import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { localDateOf } from '../lib/dates.js';

// Claude Code 트랜스크립트(~/.claude/projects/**/*.jsonl) 파서.
// 전략:
//  - 스트리밍 응답은 같은 응답(messageId:requestId)을 여러 줄에 usage 반복 기록하므로 dedup이 필수다.
//  - dedup 키: messageId:requestId → 없으면 message:messageId → 둘 다 없으면 dedup 없이 집계.
//  - 파일 내 중복: 필드별 max로 병합한다 (뒤 라인일수록 누적이 완전한 값).
//  - 파일 간 중복: 첫 파일 승리 (resume 시 파일 간 복제 대비, 정렬 순서가 기준).
//  - 필드 매핑: Claude usage는 input_tokens가 cache_read/cache_creation을 포함하지 않는 별도 카운트라,
//    codex(cached가 input의 부분집합)와 달리 빼지 않고 4필드를 그대로 매핑한다.
//    캐시 쓰기를 구분하므로 cacheCreateTok는 0이 아닐 수 있다 (codex는 구분이 없어 항상 0).
//  - model이 없거나 '<'로 시작하는 라인(<synthetic> 등)과 usage 없는 라인은 집계에서 제외한다.

function dedupKeyOf(messageId, requestId) {
  if (messageId && requestId) return `${messageId}:${requestId}`;
  if (messageId) return `message:${messageId}`;
  return null;
}

// Claude usage 4필드를 그대로 매핑한다 — input_tokens가 캐시분을 포함하지 않는 별도 카운트라
// codex(tokensOf)처럼 cached를 input에서 빼는 보정이 필요 없다. 음수 방어로만 max(…,0)를 건다.
function entryOf(date, model, usage) {
  return {
    date,
    model,
    inputTok: Math.max(usage.input_tokens ?? 0, 0),
    outputTok: Math.max(usage.output_tokens ?? 0, 0),
    cacheReadTok: Math.max(usage.cache_read_input_tokens ?? 0, 0),
    cacheCreateTok: Math.max(usage.cache_creation_input_tokens ?? 0, 0),
  };
}

// 같은 응답의 후속 스트리밍 스냅샷을 필드별 max로 병합한 새 entry를 만든다.
function mergedEntry(existing, usage, timestamp) {
  const candidate = entryOf(existing.date, existing.model, usage);
  const isNewer = timestamp && timestamp > existing.ts;
  return {
    ...existing,
    ts: isNewer ? timestamp : existing.ts,
    date: isNewer ? localDateOf(timestamp) : existing.date,
    inputTok: Math.max(existing.inputTok, candidate.inputTok),
    outputTok: Math.max(existing.outputTok, candidate.outputTok),
    cacheReadTok: Math.max(existing.cacheReadTok, candidate.cacheReadTok),
    cacheCreateTok: Math.max(existing.cacheCreateTok, candidate.cacheCreateTok),
  };
}

/**
 * Claude 트랜스크립트 파일들을 응답(dedup된 메시지) 단위 usage 목록으로 파싱한다.
 * @param {string[]} files JSONL 파일 경로 목록 (정렬된 순서 = 파일 간 first-wins 기준)
 * @returns {Promise<Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>>}
 */
export async function parseClaudeFiles(files) {
  const deduped = new Map(); // key → { file, ts, ...entry }
  const noKey = [];          // dedup 키를 만들 수 없는 라인은 전부 집계

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'assistant') continue;
        const msg = obj.message;
        if (!msg?.usage) continue;

        const key = dedupKeyOf(msg.id, obj.requestId);
        if (key && deduped.has(key)) {
          const existing = deduped.get(key);
          // 파일 간 중복(resume 복제)은 첫 파일 것을 유지하고 버린다.
          if (existing.file !== file) continue;
          deduped.set(key, mergedEntry(existing, msg.usage, obj.timestamp));
          continue;
        }

        if (!msg.model || msg.model.startsWith('<')) continue; // <synthetic> 등 제외
        const date = localDateOf(obj.timestamp);
        if (!date) continue;

        const entry = entryOf(date, msg.model, msg.usage);
        if (key) {
          deduped.set(key, { ...entry, file, ts: obj.timestamp });
        } else {
          noKey.push(entry);
        }
      } catch { /* 손상 라인 skip */ }
    }
  }

  return [...Array.from(deduped.values(), ({ file: _f, ts: _t, ...entry }) => entry), ...noKey];
}
