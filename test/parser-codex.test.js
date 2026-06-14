import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCodexFiles } from '../src/parsers/codex.js';
import { localDateOf } from '../src/lib/dates.js';

// 테스트 목록
// 1. parseCodexFiles_표준경로_last증분합산과모델추적              (성공)
// 2. parseCodexFiles_동일total반복스냅샷_한번만집계               (경계)
// 3. parseCodexFiles_세션첫이벤트_total아닌last만집계             (경계: resume 이월 방지)
// 4. parseCodexFiles_cached가input초과_input한도로클램프          (실패 입력 보정)
// 5. parseCodexFiles_fork형제파일replay_전역dedup으로1회집계      (경계)
// 6. parseCodexFiles_info없는token_count와zero스냅샷_집계제외     (실패 입력)
// 7. parseCodexFiles_모델없는초기이벤트_turn_context등장시플러시  (경계)

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-codex-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function writeJsonl(lines) {
  const file = join(dir, `rollout-${seq++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

const TS = '2026-06-10T03:00:00.000Z';

function sessionMeta({ id = 'sess_1', source = 'interactive' } = {}) {
  return JSON.stringify({ timestamp: TS, type: 'session_meta', payload: { id, source } });
}

function turnContext(model = 'gpt-5.1-codex') {
  return JSON.stringify({ timestamp: TS, type: 'turn_context', payload: { model } });
}

function tokenCount({ total, last, ts = TS } = {}) {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        ...(total ? { total_token_usage: total } : {}),
        ...(last ? { last_token_usage: last } : {}),
      },
    },
  });
}

function usage(input, cached, output, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

test('parseCodexFiles_표준경로_last증분합산과모델추적', async () => {
  // Given: 두 턴 — 누적 total이 증가하고 각 턴의 last가 증분
  const file = writeJsonl([
    sessionMeta(),
    turnContext('gpt-5.1-codex'),
    tokenCount({ total: usage(1000, 600, 50), last: usage(1000, 600, 50) }),
    tokenCount({ total: usage(2500, 1800, 130), last: usage(1500, 1200, 80) }),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: last 증분의 합 — input은 비캐시분(input-cached), cache_read는 cached
  assert.equal(entries.length, 2);
  const sum = entries.reduce((s, e) => ({
    input: s.input + e.inputTok, cacheRead: s.cacheRead + e.cacheReadTok,
    output: s.output + e.outputTok, cacheCreate: s.cacheCreate + e.cacheCreateTok,
  }), { input: 0, cacheRead: 0, output: 0, cacheCreate: 0 });
  assert.equal(sum.input, (1000 - 600) + (1500 - 1200));
  assert.equal(sum.cacheRead, 600 + 1200);
  assert.equal(sum.output, 50 + 80);
  assert.equal(sum.cacheCreate, 0); // OpenAI는 캐시 쓰기 구분 없음
  assert.ok(entries.every((e) => e.model === 'gpt-5.1-codex'));
  assert.ok(entries.every((e) => e.date === localDateOf(TS))); // 로컬 타임존 기준 날짜
});

test('parseCodexFiles_동일total반복스냅샷_한번만집계', async () => {
  // Given: 같은 누적 total을 가진 중복 스냅샷 3개 (Codex가 자주 방출)
  const t = usage(1000, 600, 50);
  const file = writeJsonl([
    sessionMeta(),
    turnContext(),
    tokenCount({ total: t, last: t }),
    tokenCount({ total: t, last: t }),
    tokenCount({ total: t, last: t }),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: total이 직전과 같으면 skip — 1건만
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outputTok, 50);
});

test('parseCodexFiles_세션첫이벤트_total아닌last만집계', async () => {
  // Given: resume된 세션 — 첫 이벤트의 total에는 이전 세션 누적분이 실려 있다
  const file = writeJsonl([
    sessionMeta(),
    turnContext(),
    tokenCount({ total: usage(50000, 30000, 9000), last: usage(1000, 600, 50) }),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: total(5만)이 아니라 last(1천)만 집계해 이월 과대집계를 막는다
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inputTok, 400);
  assert.equal(entries[0].cacheReadTok, 600);
  assert.equal(entries[0].outputTok, 50);
});

test('parseCodexFiles_cached가input초과_input한도로클램프', async () => {
  // Given: 비정상 데이터 — cached가 input보다 큼
  const file = writeJsonl([
    sessionMeta(),
    turnContext(),
    tokenCount({ total: usage(100, 500, 10), last: usage(100, 500, 10) }),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: cache_read는 input 한도로 클램프, input(비캐시)은 0
  assert.equal(entries.length, 1);
  assert.equal(entries[0].cacheReadTok, 100);
  assert.equal(entries[0].inputTok, 0);
});

test('parseCodexFiles_fork형제파일replay_전역dedup으로1회집계', async () => {
  // Given: 부모 세션과, 부모 히스토리를 그대로 replay하는 fork 자식 파일
  const total1 = usage(1000, 600, 50);
  const total2 = usage(2500, 1800, 130);
  const parent = writeJsonl([
    sessionMeta({ id: 'sess_parent' }),
    turnContext(),
    tokenCount({ total: total1, last: usage(1000, 600, 50) }),
    tokenCount({ total: total2, last: usage(1500, 1200, 80) }),
  ]);
  const child = writeJsonl([
    sessionMeta({ id: 'sess_child', source: { subagent: { thread_spawn: { parent_thread_id: 'sess_parent' } } } }),
    turnContext(),
    tokenCount({ total: total1, last: usage(1000, 600, 50) }),
    tokenCount({ total: total2, last: usage(1500, 1200, 80) }),
  ]);

  // When
  const entries = await parseCodexFiles([parent, child]);

  // Then: 자식의 replay 행은 부모와 같은 (scope, model, 누적 total) 키 → 전역 dedup으로 제외
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((s, e) => s + e.outputTok, 0), 50 + 80);
});

test('parseCodexFiles_info없는token_count와zero스냅샷_집계제외', async () => {
  // Given: info가 null인 이벤트, 전부 0인 스냅샷, 손상 라인
  const file = join(dir, 'rollout-broken.jsonl');
  writeFileSync(file, [
    sessionMeta(),
    turnContext(),
    JSON.stringify({ timestamp: TS, type: 'event_msg', payload: { type: 'token_count' } }),
    tokenCount({ total: usage(0, 0, 0), last: usage(0, 0, 0) }),
    'not json at all',
    tokenCount({ total: usage(1000, 0, 10), last: usage(1000, 0, 10) }),
  ].join('\n'));

  // When
  const entries = await parseCodexFiles([file]);

  // Then: 유효한 1건만
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inputTok, 1000);
  assert.equal(entries[0].outputTok, 10);
});

test('parseCodexFiles_모델없는초기이벤트_turn_context등장시플러시', async () => {
  // Given: turn_context보다 token_count가 먼저 오는 구버전 로그
  const file = writeJsonl([
    sessionMeta(),
    tokenCount({ total: usage(1000, 0, 50), last: usage(1000, 0, 50) }),
    turnContext('gpt-5.1-codex'),
    tokenCount({ total: usage(2000, 0, 100), last: usage(1000, 0, 50) }),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: 먼저 온 이벤트도 이후 알게 된 모델로 귀속된다
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.model === 'gpt-5.1-codex'));
});
