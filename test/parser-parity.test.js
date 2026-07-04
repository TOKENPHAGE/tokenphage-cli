import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseClaudeFiles } from '../src/parsers/claude.js';
import { parseCodexFiles } from '../src/parsers/codex.js';
import { aggregateRecords } from '../src/parser.js';

// 테스트 목록
// 1. parseClaudeFiles_출력레코드_정확히6키집합                  (성공)
// 2. parseCodexFiles_출력레코드_정확히6키집합                   (성공)
// 3. 두파서_출력키집합_완전히동일                              (parity 핵심)
// 4. aggregateRecords_두파서혼합입력_6키유지및숫자값            (경계)
// 5. aggregateRecords_동일날짜모델_병합후에도6키집합            (경계)
//
// CLI→API 계약(POST /api/sync records)은 Claude/Codex 두 파서가 동일한 6키 레코드를 낼 때만
// 성립한다. 한 파서에만 토큰 필드를 추가/개명하면 다른 파서·aggregateRecords 초기값과 조용히
// 어긋난다(스킬의 sandbox/production parity에 대응하는 회귀). 이 테스트가 그 계약을 못박는다.

const RECORD_KEYS = ['cacheCreateTok', 'cacheReadTok', 'date', 'inputTok', 'model', 'outputTok'];
const TS = '2026-06-10T03:00:00.000Z';

let dir;
let seq = 0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-parity-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function writeJsonl(lines) {
  const file = join(dir, `fixture-${seq++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Claude assistant 트랜스크립트 한 줄(usage 4필드 포함). */
function claudeLine({ id = 'm1', requestId = 'r1', model = 'claude-sonnet-4-6',
                      input = 100, output = 50, cacheRead = 20, cacheCreate = 10 } = {}) {
  return JSON.stringify({
    timestamp: TS,
    type: 'assistant',
    requestId,
    message: {
      id,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
      },
    },
  });
}

/** Codex rollout token_count 이벤트 계열 라인 빌더. */
function codexSessionMeta(id = 'sess_1') {
  return JSON.stringify({ timestamp: TS, type: 'session_meta', payload: { id, source: 'interactive' } });
}
function codexTurnContext(model = 'gpt-5.1-codex') {
  return JSON.stringify({ timestamp: TS, type: 'turn_context', payload: { model } });
}
function codexUsage(input, cached, output) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output };
}
function codexTokenCount(total, last) {
  return JSON.stringify({
    timestamp: TS,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  });
}

function keysOf(entry) {
  return Object.keys(entry).sort();
}

test('parseClaudeFiles_출력레코드_정확히6키집합', async () => {
  // Given: Claude 트랜스크립트 한 응답
  const file = writeJsonl([claudeLine()]);

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: 모든 레코드가 정확히 6키 계약을 가진다
  assert.ok(entries.length >= 1);
  for (const e of entries) {
    assert.deepEqual(keysOf(e), RECORD_KEYS);
  }
});

test('parseCodexFiles_출력레코드_정확히6키집합', async () => {
  // Given: Codex rollout 한 턴
  const file = writeJsonl([
    codexSessionMeta(),
    codexTurnContext(),
    codexTokenCount(codexUsage(1000, 600, 50), codexUsage(1000, 600, 50)),
  ]);

  // When
  const entries = await parseCodexFiles([file]);

  // Then: 모든 레코드가 정확히 6키 계약을 가진다 (cacheCreateTok 포함, Codex는 항상 0)
  assert.ok(entries.length >= 1);
  for (const e of entries) {
    assert.deepEqual(keysOf(e), RECORD_KEYS);
  }
});

test('두파서_출력키집합_완전히동일', async () => {
  // Given: 각 파서로 최소 1건씩 생성
  const claudeFile = writeJsonl([claudeLine()]);
  const codexFile = writeJsonl([
    codexSessionMeta('sess_2'),
    codexTurnContext(),
    codexTokenCount(codexUsage(1000, 600, 50), codexUsage(1000, 600, 50)),
  ]);

  // When
  const claudeEntries = await parseClaudeFiles([claudeFile]);
  const codexEntries = await parseCodexFiles([codexFile]);

  // Then: 두 파서의 레코드 키 집합이 서로, 그리고 계약과 완전히 동일하다
  assert.deepEqual(keysOf(claudeEntries[0]), keysOf(codexEntries[0]));
  assert.deepEqual(keysOf(claudeEntries[0]), RECORD_KEYS);
});

test('aggregateRecords_두파서혼합입력_6키유지및숫자값', async () => {
  // Given: 서로 다른 모델의 Claude/Codex 레코드
  const claudeFile = writeJsonl([claudeLine({ model: 'claude-opus-4-8' })]);
  const codexFile = writeJsonl([
    codexSessionMeta('sess_3'),
    codexTurnContext('gpt-5.1-codex'),
    codexTokenCount(codexUsage(2000, 800, 120), codexUsage(2000, 800, 120)),
  ]);
  const claudeEntries = await parseClaudeFiles([claudeFile]);
  const codexEntries = await parseCodexFiles([codexFile]);

  // When
  const agg = aggregateRecords([...claudeEntries, ...codexEntries]);

  // Then: 집계 후에도 각 레코드는 6키를 유지하고 토큰 필드는 숫자다
  assert.ok(agg.length >= 2);
  for (const r of agg) {
    assert.deepEqual(keysOf(r), RECORD_KEYS);
    for (const k of ['inputTok', 'outputTok', 'cacheReadTok', 'cacheCreateTok']) {
      assert.equal(typeof r[k], 'number');
    }
  }
});

test('aggregateRecords_동일날짜모델_병합후에도6키집합', async () => {
  // Given: 같은 date|model을 내는 Claude/Codex 레코드 (병합 대상)
  const claudeFile = writeJsonl([claudeLine({ model: 'shared-model', input: 100, output: 50, cacheRead: 20, cacheCreate: 0 })]);
  const codexFile = writeJsonl([
    codexSessionMeta('sess_4'),
    codexTurnContext('shared-model'),
    codexTokenCount(codexUsage(300, 100, 40), codexUsage(300, 100, 40)),
  ]);
  const claudeEntries = await parseClaudeFiles([claudeFile]);
  const codexEntries = await parseCodexFiles([codexFile]);

  // When: 동일 date|model이면 한 레코드로 합산된다
  const agg = aggregateRecords([...claudeEntries, ...codexEntries]);

  // Then: 병합으로 키가 늘거나 줄지 않고 정확히 6키를 유지한다
  const merged = agg.find((r) => r.model === 'shared-model');
  assert.ok(merged);
  assert.deepEqual(keysOf(merged), RECORD_KEYS);
  assert.equal(agg.filter((r) => r.model === 'shared-model').length, 1);
});
