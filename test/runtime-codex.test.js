import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseCodexFiles } from '../src/parsers/codex.js';
import { createCodexRuntimeCollector } from '../src/runtime/codex.js';

// 테스트 목록 (Codex 로그 해석 — 턴 경계·중복 제거·모델만 본다. 타임라인 규칙은 runtime-timeline 테스트)
// 1. codex추출_신형포맷턴이벤트와turn_id_턴구간합산하고source는codex       (해피)
// 2. codex추출_깨진줄_건너뛰고나머지계산                                   (실패)
// 3. codex추출_포크와서브에이전트복사본같은turn_id_원본파일것만1회          (엣지)
// 4. codex추출_파일신원_첫session_meta로정함                                (엣지)
// 5. codex추출_구형포맷turn_id없음_user_message로턴시작하고복사구간제외     (엣지)
// 6. codex추출_턴마다turn_context모델_턴별모델                              (엣지)
// 7. codex추출_turn_aborted로끝난턴_그뒤기록은턴밖                          (엣지)
// 8. codex추출_수집중예외_던지지않고실패로보고                               (실패)
//
// 줄 모양은 upstream openai/codex(codex-rs protocol·rollout recorder) 기준으로 만든 합성 데이터다.

const MODEL = 'gpt-5.1-codex';

let dir;
let seq = 0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-rt-codex-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/** 2026-06-10 {h}:{m} 로컬 기준 s초 뒤의 UTC 시각(rollout 줄과 같은 ms 정밀도 형식). */
function at(h, m, s = 0, ms = 0) {
  return new Date(2026, 5, 10, h, m, s, ms).toISOString();
}

const line = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
const sessionMeta = (ts, id, extra = {}) => line(ts, 'session_meta', {
  id, session_id: id, timestamp: ts, cwd: '/w', originator: 'codex_cli_rs', cli_version: '0.120.0', source: 'cli', ...extra,
});
const turnContext = (ts, turnId, model = MODEL) => line(ts, 'turn_context', {
  ...(turnId ? { turn_id: turnId } : {}), cwd: '/w', approval_policy: 'never', sandbox_policy: { mode: 'read-only' }, model, summary: 'auto',
});
const event = (ts, type, fields = {}) => line(ts, 'event_msg', { type, ...fields });
const item = (ts, type, fields = {}) => line(ts, 'response_item', { type, ...fields });
const started = (ts, turnId, type = 'task_started') => event(ts, type, { turn_id: turnId, model_context_window: 272000 });
const completed = (ts, turnId, type = 'task_complete') => event(ts, type, { turn_id: turnId, last_agent_message: null });
const userInput = (ts) => item(ts, 'message', { role: 'user', content: [{ type: 'input_text', text: '' }] });
const userMessage = (ts) => event(ts, 'user_message', { message: '', images: [] });
const assistantText = (ts) => item(ts, 'message', { role: 'assistant', content: [{ type: 'output_text', text: '' }] });
const toolCall = (ts) => item(ts, 'function_call', { name: 'shell', arguments: '{}', call_id: 'c1' });
const toolOutput = (ts) => item(ts, 'function_call_output', { call_id: 'c1', output: '' });
const tokenCount = (ts) => event(ts, 'token_count', { info: null });

function writeRollout(lines) {
  const file = join(dir, `rollout-${seq++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

async function runtimeOf(files) {
  const collector = createCodexRuntimeCollector();
  await parseCodexFiles(files, collector.onRecord);
  return collector.result();
}
const total = (rows) => rows.reduce((sum, r) => sum + r.runtimeMs, 0);

/** 원본 세션 하나: 09:00 시작, turn-a가 10초. */
function originalLines() {
  return [
    sessionMeta(at(9, 0), 'parent'),
    started(at(9, 0, 0), 'turn-a'), turnContext(at(9, 0, 0, 100), 'turn-a'), userInput(at(9, 0, 0, 200)),
    assistantText(at(9, 0, 10)), completed(at(9, 0, 11), 'turn-a'),
  ];
}

/** 부모 기록을 새 줄 시각(복사 시각)으로 옮겨 적은 줄들. turn_id는 원본과 같다. */
function copiedParent(copyH, copyM) {
  return [
    sessionMeta(at(9, 0), 'parent'),
    started(at(copyH, copyM, 0, 1), 'turn-a'), turnContext(at(copyH, copyM, 0, 2), 'turn-a'), userInput(at(copyH, copyM, 0, 3)),
    assistantText(at(copyH, copyM, 0, 4)), completed(at(copyH, copyM, 0, 5), 'turn-a'),
  ];
}

test('codex추출_신형포맷턴이벤트와turn_id_턴구간합산하고source는codex', async () => {
  // Given: 도구 호출이 있는 turn 1(20초)과 별칭 이벤트(turn_started/turn_complete)를 쓴 turn 2(10초)
  const file = writeRollout([
    sessionMeta(at(9, 0), 's1'),
    started(at(9, 0, 0), 't1'), turnContext(at(9, 0, 0, 100), 't1'), userInput(at(9, 0, 0, 200)), userMessage(at(9, 0, 0, 300)),
    item(at(9, 0, 5), 'reasoning', { summary: [] }), toolCall(at(9, 0, 6)), toolOutput(at(9, 0, 16)),
    assistantText(at(9, 0, 20)), tokenCount(at(9, 0, 20, 500)), completed(at(9, 0, 21), 't1'),
    started(at(9, 1, 40), 't2', 'turn_started'), turnContext(at(9, 1, 40, 100), 't2'),
    assistantText(at(9, 1, 50)), completed(at(9, 1, 51), 't2', 'turn_complete'),
  ]);

  // When
  const { source, ok, rows } = await runtimeOf([file]);

  // Then: 턴 시작부터 마지막 응답·도구 결과까지, 턴 사이 79초는 빠진다
  assert.equal(source, 'codex');
  assert.equal(ok, true);
  assert.deepEqual(rows, [{ date: '2026-06-10', source: 'codex', model: MODEL, runtimeMs: 30_000 }]);
});

test('codex추출_깨진줄_건너뛰고나머지계산', async () => {
  // Given: 턴 중간에 깨진 줄
  const file = writeRollout([
    sessionMeta(at(9, 0), 's1'), started(at(9, 0, 0), 't1'), turnContext(at(9, 0, 0, 100), 't1'),
    '{not json', toolCall(at(9, 0, 4)), toolOutput(at(9, 0, 8)), completed(at(9, 0, 9), 't1'),
  ]);

  // When
  const { ok, rows } = await runtimeOf([file]);

  // Then
  assert.equal(ok, true);
  assert.equal(total(rows), 8_000);
});

test('codex추출_포크와서브에이전트복사본같은turn_id_원본파일것만1회', async () => {
  // Given: 원본(turn-a 10초), 포크(복사 + turn-b 20초), 포크로 띄운 서브에이전트(복사 + turn-c 10초)
  const original = writeRollout(originalLines());
  const fork = writeRollout([
    sessionMeta(at(9, 30), 'child', { forked_from_id: 'parent' }), ...copiedParent(9, 30),
    started(at(9, 31, 0), 'turn-b'), turnContext(at(9, 31, 0, 100), 'turn-b'), assistantText(at(9, 31, 20)), completed(at(9, 31, 21), 'turn-b'),
  ]);
  const subagent = writeRollout([
    sessionMeta(at(9, 40), 'sub', { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } }), ...copiedParent(9, 40),
    started(at(9, 41, 0), 'turn-c'), turnContext(at(9, 41, 0, 100), 'turn-c'), assistantText(at(9, 41, 10)), completed(at(9, 41, 11), 'turn-c'),
  ]);

  // When
  const forward = await runtimeOf([original, fork, subagent]);
  const backward = await runtimeOf([subagent, fork, original]);

  // Then: 복사된 turn-a는 원본 파일 것만 센다(10 + 20 + 10초)
  assert.equal(total(forward.rows), 40_000);
  assert.equal(total(backward.rows), 40_000);
});

test('codex추출_파일신원_첫session_meta로정함', async () => {
  // Given: 포크 파일 안의 복사된 부모 session_meta는 원본보다 이른 시각을 담고 있다
  const original = writeRollout(originalLines());
  const fork = writeRollout([
    sessionMeta(at(9, 30), 'child', { forked_from_id: 'parent' }),
    sessionMeta(at(8, 0), 'parent'),
    started(at(9, 30, 0, 1), 'turn-a'), turnContext(at(9, 30, 0, 2), 'turn-a'), assistantText(at(9, 30, 0, 4)), completed(at(9, 30, 0, 5), 'turn-a'),
  ]);

  // When
  const { rows } = await runtimeOf([fork, original]);

  // Then: 포크의 신원은 첫 session_meta(09:30)라 turn-a는 원본의 10초로 센다
  assert.equal(total(rows), 10_000);
});

test('codex추출_구형포맷turn_id없음_user_message로턴시작하고복사구간제외', async () => {
  // Given: turn 이벤트가 없는 옛 rollout과, 다른 id의 session_meta 뒤로 부모 기록을 복사한 옛 포크
  const old = writeRollout([
    sessionMeta(at(9, 0), 'old'), turnContext(at(9, 0, 0), null),
    userMessage(at(9, 0, 1)), userInput(at(9, 0, 1, 1)), toolCall(at(9, 0, 5)), toolOutput(at(9, 0, 9)), assistantText(at(9, 0, 11)),
    tokenCount(at(9, 0, 12)),
    userMessage(at(9, 1, 40)), assistantText(at(9, 1, 45)),
  ]);
  const oldFork = writeRollout([
    sessionMeta(at(9, 30), 'old-fork'),
    sessionMeta(at(9, 0), 'old'), turnContext(at(9, 30, 0, 1), null),
    userMessage(at(9, 30, 0, 2)), assistantText(at(9, 30, 3)),
  ]);

  // When
  const { rows } = await runtimeOf([old, oldFork]);

  // Then: user_message마다 새 턴(10초 + 5초), 옛 포크의 복사 구간은 세지 않는다
  assert.equal(total(rows), 15_000);
});

test('codex추출_턴마다turn_context모델_턴별모델', async () => {
  // Given: 턴마다 다른 모델의 turn_context
  const file = writeRollout([
    sessionMeta(at(9, 0), 's1'),
    started(at(9, 0, 0), 't1'), turnContext(at(9, 0, 0, 100), 't1', 'gpt-5.1-codex'), assistantText(at(9, 0, 10)), completed(at(9, 0, 11), 't1'),
    started(at(9, 1, 0), 't2'), turnContext(at(9, 1, 0, 100), 't2', 'gpt-5.1-codex-mini'), toolCall(at(9, 1, 2)), toolOutput(at(9, 1, 20)),
    completed(at(9, 1, 21), 't2'),
  ]);

  // When
  const { rows } = await runtimeOf([file]);

  // Then
  assert.deepEqual(rows.map((r) => [r.model, r.runtimeMs]), [['gpt-5.1-codex', 10_000], ['gpt-5.1-codex-mini', 20_000]]);
});

test('codex추출_수집중예외_던지지않고실패로보고', () => {
  // Given: 읽는 순간 예외가 나는 레코드(토큰 파서의 줄 처리에 예외가 번지면 안 된다)
  const collector = createCodexRuntimeCollector();
  const hostile = { timestamp: at(9, 0), type: 'event_msg', payload: { get type() { throw new Error('boom'); } } };

  // When / Then
  assert.doesNotThrow(() => collector.onRecord(hostile, 'rollout.jsonl'));
  assert.equal(collector.result().ok, false);
});

test('codex추출_turn_aborted로끝난턴_그뒤기록은턴밖', async () => {
  // Given: 중단된 턴 뒤, 다음 턴 시작 전에 응답 모양 기록이 남아 있다
  const file = writeRollout([
    sessionMeta(at(9, 0), 's1'),
    started(at(9, 0, 0), 't1'), turnContext(at(9, 0, 0, 100), 't1'), toolCall(at(9, 0, 5)),
    event(at(9, 0, 6), 'turn_aborted', { turn_id: 't1', reason: 'interrupted' }),
    event(at(9, 2, 0), 'agent_message', { message: '' }),
    started(at(9, 3, 0), 't2'), turnContext(at(9, 3, 0, 100), 't2'), assistantText(at(9, 3, 10)), completed(at(9, 3, 11), 't2'),
  ]);

  // When / Then: 5초 + 10초(중단 뒤 기록은 턴을 늘리지 않는다)
  assert.equal(total((await runtimeOf([file])).rows), 15_000);
});
