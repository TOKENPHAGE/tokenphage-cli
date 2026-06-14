import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { localDateOf } from '../lib/dates.js';

// OpenAI Codex CLI rollout(~/.codex/sessions/**/*.jsonl) 파서.
// 전략:
//  - token_count 이벤트의 last_token_usage를 증분으로 합산한다.
//    total_token_usage는 누적 스냅샷이라 중복 판정·단조성 검사에만 쓴다.
//  - 세션 첫 이벤트도 last만 집계한다 (resume 시 이전 세션 누적분 이월 방지).
//  - fork/서브에이전트 자식 파일은 부모 히스토리를 그대로 replay하므로,
//    (fork 부모 세션, 모델, 누적 total) 키로 전역 dedup해 1회만 집계한다.
//  - cached_input_tokens는 input_tokens의 부분집합 → input은 비캐시분만,
//    cache_read에 cached를 둔다. OpenAI는 캐시 쓰기 구분이 없어 cache_create=0.
//  - reasoning_output_tokens(Codex rollout 내부 필드명; OpenAI 공식 API에서는
//    output_tokens_details.reasoning_tokens)는 output_tokens에 이미 포함된 부분집합이라
//    별도 합산하지 않는다. 근거: OpenAI 공식 문서 "reasoning tokens ... are billed as
//    output tokens" (developers.openai.com/api/docs/guides/reasoning).

function totalsOf(u) {
  if (!u) return null;
  return {
    input: Math.max(u.input_tokens ?? 0, 0),
    output: Math.max(u.output_tokens ?? 0, 0),
    cached: Math.max(u.cached_input_tokens ?? 0, u.cache_read_input_tokens ?? 0, 0),
    // reasoning_output_tokens: Codex rollout 내부 필드명 (OpenAI 공식 API는 reasoning_tokens).
    // 단조성·dedup 키 판정용으로만 추적하고 출력 레코드에는 넣지 않는다.
    reasoning: Math.max(u.reasoning_output_tokens ?? 0, 0),
  };
}

function totalsEqual(a, b) {
  return a.input === b.input && a.output === b.output
    && a.cached === b.cached && a.reasoning === b.reasoning;
}

// 모든 필드가 단조 증가했을 때만 증분을 돌려준다. 하나라도 줄었으면 null (리셋/회귀).
function deltaFrom(current, previous) {
  if (current.input < previous.input || current.output < previous.output
    || current.cached < previous.cached || current.reasoning < previous.reasoning) {
    return null;
  }
  return {
    input: current.input - previous.input,
    output: current.output - previous.output,
    cached: current.cached - previous.cached,
    reasoning: current.reasoning - previous.reasoning,
  };
}

function totalSum(t) {
  return t.input + t.output + t.cached + t.reasoning;
}

// 누적 total이 살짝 뒤로 간 스냅샷이 순서 뒤바뀜(stale)인지 판정한다.
// 진짜 리셋과 달리 직전 누적의 98% 이상이거나 최근 증분 2회분 이내로만 줄어든다.
function looksLikeStaleRegression(current, previous, last) {
  const prevSum = totalSum(previous);
  const curSum = totalSum(current);
  const lastSum = totalSum(last);
  if (prevSum <= 0 || curSum <= 0 || lastSum <= 0) return false;
  return curSum * 100 >= prevSum * 98 || curSum + lastSum * 2 >= prevSum;
}

// 증분 totals를 tokenphage 레코드 토큰 필드로 변환한다.
function tokensOf(t) {
  const clampedCached = Math.min(t.cached, t.input);
  return {
    inputTok: Math.max(t.input - clampedCached, 0),
    outputTok: t.output,
    cacheReadTok: Math.max(clampedCached, 0),
    cacheCreateTok: 0,
  };
}

function isZeroTotals(t) {
  return t.input === 0 && t.output === 0 && t.cached === 0 && t.reasoning === 0;
}

// fork 자식이 replay한 행은 부모와 같은 키가 되도록 fork 부모 id로 스코프를 잡는다.
function dedupKeyOf(scopeId, model, totalUsage, tokens, date) {
  if (totalUsage) {
    return `total:${scopeId}:${model}:${totalUsage.input}:${totalUsage.output}:${totalUsage.cached}:${totalUsage.reasoning}`;
  }
  return `tok:${scopeId}:${model}:${date}:${tokens.inputTok}:${tokens.outputTok}:${tokens.cacheReadTok}`;
}

function forkedFromIdOf(payload) {
  return payload.forked_from_id
    ?? payload.source?.subagent?.thread_spawn?.parent_thread_id
    ?? null;
}

// token_count 이벤트 하나에서 (집계할 증분, 다음 baseline)을 결정한다.
function resolveIncrement(total, last, previous) {
  if (total && last) {
    if (previous) {
      if (totalsEqual(total, previous)) return null; // 변화 없는 중복 스냅샷
      if (deltaFrom(total, previous) === null && looksLikeStaleRegression(total, previous, last)) {
        return null; // 순서 뒤바뀐 구식 스냅샷 — last를 두 번 세지 않는다
      }
    }
    return { tokens: last, next: total };
  }
  if (total) {
    if (previous) {
      if (totalsEqual(total, previous)) return null;
      const delta = deltaFrom(total, previous);
      if (delta === null) return { tokens: null, next: total }; // 리셋 → baseline만 갱신
      return { tokens: delta, next: total };
    }
    return { tokens: total, next: total }; // last 없는 구버전 첫 이벤트
  }
  if (last) {
    if (previous) {
      return {
        tokens: last,
        next: {
          input: previous.input + last.input,
          output: previous.output + last.output,
          cached: previous.cached + last.cached,
          reasoning: previous.reasoning + last.reasoning,
        },
      };
    }
    return { tokens: last, next: null };
  }
  return null;
}

/**
 * Codex rollout 파일들을 턴 증분 단위 usage 목록으로 파싱한다.
 * @param {string[]} files JSONL 파일 경로 목록 (정렬된 순서 — sessions를 archived보다 먼저)
 * @returns {Promise<Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>>}
 */
export async function parseCodexFiles(files) {
  const entries = [];
  const seenKeys = new Set(); // 파일 간 replay/복제 dedup

  for (const file of files) {
    let currentModel = null;
    let previousTotals = null;
    let sessionId = null;
    let forkedFromId = null;
    const pendingNoModel = []; // 모델을 아직 모를 때 도착한 증분 — 모델 발견 시 플러시

    const flushPending = (model) => {
      for (const pending of pendingNoModel) {
        const key = dedupKeyOf(pending.scopeId, model, pending.totalUsage, pending.tokens, pending.date);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        entries.push({ date: pending.date, model, ...pending.tokens });
      }
      pendingNoModel.length = 0;
    };

    const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const payload = obj.payload;
        if (!payload) continue;

        if (obj.type === 'session_meta') {
          sessionId = payload.id ?? sessionId;
          forkedFromId = forkedFromIdOf(payload) ?? forkedFromId;
          continue;
        }

        if (obj.type === 'turn_context') {
          if (payload.model) {
            currentModel = payload.model;
            flushPending(currentModel);
          }
          continue;
        }

        if (obj.type !== 'event_msg' || payload.type !== 'token_count') continue;
        const info = payload.info;
        if (!info) continue;

        const model = payload.model ?? info.model ?? info.model_name ?? currentModel;
        if (model) currentModel = model;

        const total = totalsOf(info.total_token_usage);
        const last = totalsOf(info.last_token_usage);
        const resolved = resolveIncrement(total, last, previousTotals);
        if (resolved === null) continue;
        if (resolved.tokens === null) { previousTotals = resolved.next; continue; }
        // 전부 0인 스냅샷은 baseline을 옮기지 않고 버린다 (compaction 직후 0 total 대비).
        if (isZeroTotals(resolved.tokens)) continue;
        previousTotals = resolved.next;

        const date = localDateOf(obj.timestamp);
        if (!date) continue;

        const tokens = tokensOf(resolved.tokens);
        const scopeId = forkedFromId ?? sessionId ?? file;
        if (model) {
          const key = dedupKeyOf(scopeId, model, total, tokens, date);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          entries.push({ date, model, ...tokens });
        } else {
          pendingNoModel.push({ date, tokens, totalUsage: total, scopeId });
        }
      } catch { /* 손상 라인 skip */ }
    }
    // 파일이 끝나도 모델을 못 찾은 증분은 모델 귀속이 불가능해 버린다.
  }

  return entries;
}
