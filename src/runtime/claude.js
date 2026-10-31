import { sumRuntimes, addRuntimeRows } from './timeline.js';

// Claude Code 실행시간 추출기. parseClaudeFiles가 읽은 줄을 받아 실행 단위별로 계산한다.
//  - 실행 단위: 메인 세션 파일, subagents/ 아래 에이전트 파일(파일 전체가 한 턴). journal.jsonl은 제외한다.
//  - 이벤트: timestamp가 있는 user·assistant·system·attachment 레코드.
//  - 턴 시작: 메인 파일에서 처음 나온 promptId의 user 레코드. promptId가 없는 옛 파일은 사람이 입력한 질문.
//  - 중복 제거: forkedFrom을 원본까지 따라간 uuid로 한 번만 센다. 원본이 있으면 복사본은 버린다.

const SOURCE = 'claude';
const EVENT_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);
const INTERRUPTED_PREFIX = '[Request interrupted';
const LOCAL_STDOUT_PREFIX = '<local-command-stdout>';
const MAX_FORK_DEPTH = 100;

function firstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = content.find((c) => c?.type === 'text')?.text;
  return typeof text === 'string' ? text : '';
}

function isToolResult(obj) {
  const content = obj.message?.content;
  return obj.toolUseResult != null || (Array.isArray(content) && content.some((c) => c?.type === 'tool_result'));
}

/** promptId가 없는 옛 버전의 턴 시작: 사람이 입력한 질문, 작업 완료 알림, 다른 세션 메시지. */
function isLegacyTurnStart(obj) {
  const kind = obj.origin?.kind;
  if (kind === 'task-notification' || kind === 'peer') return true;
  if (obj.isMeta || obj.isCompactSummary || isToolResult(obj)) return false;
  const text = firstText(obj.message?.content);
  return !text.startsWith(INTERRUPTED_PREFIX) && !text.startsWith(LOCAL_STDOUT_PREFIX);
}

function unitKindOf(file) {
  const path = String(file).replaceAll('\\', '/');
  if (path.split('/').pop() === 'journal.jsonl') return 'journal';
  // 사용자 폴더 이름에 subagents가 있어도 영향받지 않게 projects/ 아래 경로만 본다
  return path.slice(Math.max(path.lastIndexOf('/projects/'), 0)).includes('/subagents/') ? 'agent' : 'main';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// 에이전트 파일은 가장 이른 기록이, 메인 파일은 처음 나온 promptId(옛 파일은 사람의 질문)가 턴 시작이다.
function markTurnStarts(unit, events) {
  if (unit.kind === 'agent') {
    let first = null;
    for (const e of events) if (!first || e.t < first.t) first = e;
    if (first) first.start = true;
    return;
  }
  const seen = new Set();
  for (const e of events) {
    if (!unit.hasPromptId) {
      e.start = e.legacyStart === true;
    } else if (e.promptId !== undefined && !seen.has(e.promptId)) {
      seen.add(e.promptId);
      e.start = true;
    }
  }
}

/**
 * Claude 실행시간 수집기를 만든다. onRecord를 parseClaudeFiles에 넘겨 같은 읽기에서 계산한다.
 * @returns {{ onRecord: (record: object, file: string) => void,
 *   result: () => { source: 'claude', rows: Array<{ date: string, source: string, model: string, runtimeMs: number }>, ok: boolean } }}
 */
export function createClaudeRuntimeCollector() {
  const totals = new Map();
  const originals = new Set();   // 원본 레코드 uuid
  const copyParents = new Map(); // 복사본 uuid → 가리키는 uuid
  const pending = [];            // 복사본이 있어 끝에 원본과 대조할 실행 단위(나머지는 읽는 즉시 합산)
  let unit = null;
  let failed = false;

  const sumUnit = (target, events) => {
    markTurnStarts(target, events);
    addRuntimeRows(totals, sumRuntimes([{ source: SOURCE, events }]));
  };

  // 파일이 바뀌면 앞 단위를 마무리한다(parseClaudeFiles는 파일을 하나씩 순서대로 읽는다).
  const closeUnit = () => {
    if (!unit) return;
    if (unit.hasCopies) pending.push(unit);
    else if (unit.kind !== 'journal') sumUnit(unit, unit.events);
    unit = null;
  };

  // 포크의 포크는 앞 복사본을 가리키므로 원본 uuid까지 따라간다.
  const rootOf = (key) => {
    let current = key;
    for (let hop = 0; hop < MAX_FORK_DEPTH && copyParents.has(current); hop++) current = copyParents.get(current);
    return current;
  };

  const onRecord = (obj, file) => {
    try {
      if (!EVENT_TYPES.has(obj?.type)) return;
      const t = Date.parse(obj.timestamp);
      if (!Number.isFinite(t)) return;
      if (unit?.file !== file) {
        closeUnit();
        unit = { file, kind: unitKindOf(file), events: [], hasPromptId: false, hasCopies: false };
      }
      if (unit.kind === 'journal') return;

      const isUser = obj.type === 'user';
      const promptId = isUser ? nonEmptyString(obj.promptId) : undefined;
      if (promptId) unit.hasPromptId = true;

      const uuid = nonEmptyString(obj.uuid);
      const copyOf = nonEmptyString(obj.forkedFrom?.messageUuid);
      if (copyOf) {
        if (uuid) copyParents.set(uuid, copyOf);
        unit.hasCopies = true;
      } else if (uuid) {
        if (originals.has(uuid)) return; // resume 복사본(같은 uuid)
        originals.add(uuid);
      }

      const isAssistant = obj.type === 'assistant';
      const event = { t, start: false, reply: isAssistant || (isUser && isToolResult(obj)), model: isAssistant ? obj.message?.model : undefined };
      if (isUser) {
        event.promptId = promptId;
        event.legacyStart = isLegacyTurnStart(obj);
      }
      if (copyOf) event.copyOf = copyOf;
      unit.events.push(event);
    } catch {
      failed = true;
    }
  };

  const result = () => {
    try {
      closeUnit();
      const keptCopies = new Set();
      for (const waiting of pending) {
        const kept = [];
        for (const e of waiting.events) {
          if (e.copyOf !== undefined) {
            const root = rootOf(e.copyOf);
            if (originals.has(root) || keptCopies.has(root)) continue;
            keptCopies.add(root);
          }
          kept.push(e);
        }
        sumUnit(waiting, kept);
      }
      pending.length = 0;
      return { source: SOURCE, rows: [...totals.values()], ok: !failed };
    } catch {
      return { source: SOURCE, rows: [], ok: false };
    }
  };

  return { onRecord, result };
}
