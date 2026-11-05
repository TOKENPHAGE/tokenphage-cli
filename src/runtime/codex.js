import { sumRuntimes } from './timeline.js';

// Codex 실행시간 추출기. parseCodexFiles가 읽은 rollout 줄을 받아 파일(실행 단위)별 턴으로 모은다.
//  - 파일 신원은 첫 session_meta. 턴은 task_started(turn_started)부터, 그 이벤트가 없는 구버전은 user_message부터.
//  - task_complete(turn_complete)·turn_aborted 뒤 기록은 다음 턴 시작 전까지 세지 않는다.
//  - 포크 복사본은 turn_id가 같아 첫 session_meta가 가장 이른 파일 것만 쓴다.
//  - turn_id가 없는 구버전은 다른 id의 session_meta가 나온 뒤를 복사로 본다.

const SOURCE = 'codex';
const START_EVENTS = new Set(['task_started', 'turn_started']);
const END_EVENTS = new Set(['task_complete', 'turn_complete', 'turn_aborted']);
// 모델 응답·도구 호출과 그 결과(response_item.payload.type)
const REPLY_ITEMS = new Set([
  'reasoning', 'agent_message', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'web_search_call', 'tool_search_call', 'tool_search_output', 'image_generation_call',
]);
// 응답·도구 결과를 알리는 event_msg(legacy 기록 방식)
const REPLY_EVENTS = new Set([
  'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'exec_command_end', 'patch_apply_end',
  'mcp_tool_call_end', 'web_search_end', 'image_generation_end',
]);
const INPUT_ITEMS = new Set(['UserMessage', 'HookPrompt']);

function isReply(obj) {
  const payload = obj.payload;
  if (obj.type === 'response_item') {
    return REPLY_ITEMS.has(payload.type) || (payload.type === 'message' && payload.role === 'assistant');
  }
  if (obj.type !== 'event_msg') return false;
  if (payload.type === 'item_completed') return typeof payload.item?.type === 'string' && !INPUT_ITEMS.has(payload.item.type);
  return REPLY_EVENTS.has(payload.type);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Codex 실행시간 수집기를 만든다. onRecord를 parseCodexFiles에 넘겨 같은 읽기에서 이벤트를 모은다.
 * @returns {{ onRecord: (record: object, file: string) => void,
 *   result: () => { source: 'codex', rows: Array<{ date: string, source: string, model: string, runtimeMs: number }>, ok: boolean } }}
 */
export function createCodexRuntimeCollector() {
  const files = []; // { path, metaId, metaTime, copying, model, inTask, segments, open }
  let current = null;
  let failed = false;

  const fileOf = (path) => {
    if (current?.path !== path) {
      current = { path, metaId: null, metaTime: Infinity, copying: false, model: null, inTask: false, segments: [], open: null };
      files.push(current);
    }
    return current;
  };

  const openSegment = (file, t, turnId) => {
    file.open = { turnId, copy: turnId === null && file.copying, events: [{ t, start: true }] };
    file.segments.push(file.open);
  };

  const onRecord = (obj, path) => {
    try {
      const payload = obj?.payload;
      if (!payload || typeof obj.type !== 'string') return;
      const file = fileOf(path);
      const t = Date.parse(obj.timestamp);

      if (obj.type === 'session_meta') {
        if (file.metaId === null) {
          file.metaId = nonEmptyString(payload.id) ?? '';
          const metaTime = Date.parse(payload.timestamp);
          file.metaTime = Number.isFinite(metaTime) ? metaTime : (Number.isFinite(t) ? t : Infinity);
        } else if (nonEmptyString(payload.id) && payload.id !== file.metaId) {
          file.copying = true; // 부모 기록 복사가 시작된다
          if (file.open?.turnId === null) file.open = null;
        }
        return;
      }
      if (!Number.isFinite(t)) return;
      if (obj.type === 'turn_context' && nonEmptyString(payload.model)) file.model = payload.model;

      if (obj.type === 'event_msg' && START_EVENTS.has(payload.type)) {
        openSegment(file, t, nonEmptyString(payload.turn_id));
        file.inTask = true;
        return;
      }
      if (obj.type === 'event_msg' && payload.type === 'user_message' && !file.inTask) {
        openSegment(file, t, null);
        return;
      }
      if (!file.open) return;

      const reply = isReply(obj);
      file.open.events.push({ t, start: false, reply, model: reply ? file.model : undefined });
      if (obj.type === 'event_msg' && END_EVENTS.has(payload.type)) {
        file.open = null;
        file.inTask = false;
      }
    } catch {
      failed = true;
    }
  };

  const result = () => {
    try {
      // 같은 turn_id는 첫 session_meta가 가장 이른 파일(같으면 먼저 읽은 파일)이 주인이다.
      const owners = new Map();
      files.forEach((file, index) => {
        for (const segment of file.segments) {
          if (segment.turnId === null) continue;
          const owner = owners.get(segment.turnId);
          if (owner === undefined || file.metaTime < files[owner].metaTime) owners.set(segment.turnId, index);
        }
      });
      const units = files.map((file, index) => ({
        source: SOURCE,
        events: file.segments
          .filter((segment) => (segment.turnId === null ? !segment.copy : owners.get(segment.turnId) === index))
          .flatMap((segment) => segment.events),
      }));
      return { source: SOURCE, rows: sumRuntimes(units), ok: !failed };
    } catch {
      return { source: SOURCE, rows: [], ok: false };
    }
  };

  return { onRecord, result };
}
