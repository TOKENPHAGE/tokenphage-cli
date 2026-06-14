import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseClaudeFiles } from '../src/parsers/claude.js';
import { aggregateRecords } from '../src/parser.js';

// 테스트 목록
// 1. parseClaudeFiles_스트리밍중복라인_필드별max로1건합산        (성공)
// 2. parseClaudeFiles_서로다른응답_모두합산                      (성공)
// 3. parseClaudeFiles_requestId없는라인_messageId키로dedup       (경계)
// 4. parseClaudeFiles_messageId없는라인_dedup없이전부합산        (경계)
// 5. parseClaudeFiles_파일간중복키_첫파일승리                    (경계)
// 6. parseClaudeFiles_synthetic모델과손상라인_집계제외           (실패 입력)
// 7. aggregateRecords_날짜모델집계와fromDate경계_경계날짜포함     (성공+경계)

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-claude-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function writeJsonl(lines) {
  const file = join(dir, `s${seq++}.jsonl`);
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function assistantLine({ id = 'msg_1', reqId = 'req_1', model = 'claude-sonnet-4-6', ts = '2026-06-10T03:00:00.000Z', usage = {} } = {}) {
  const obj = {
    type: 'assistant',
    timestamp: ts,
    message: {
      ...(id != null ? { id } : {}),
      model,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  };
  if (reqId != null) obj.requestId = reqId;
  return JSON.stringify(obj);
}

test('parseClaudeFiles_스트리밍중복라인_필드별max로1건합산', async () => {
  // Given: 같은 messageId:requestId로 3줄 — 스트리밍 진행에 따라 output이 커진다
  const file = writeJsonl([
    assistantLine({ usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 500 } }),
    assistantLine({ usage: { input_tokens: 1000, output_tokens: 40, cache_read_input_tokens: 500 } }),
    assistantLine({ usage: { input_tokens: 1000, output_tokens: 350, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 } }),
  ]);

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: 1건으로 합쳐지고 각 필드는 max를 취한다
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inputTok, 1000);
  assert.equal(entries[0].outputTok, 350);
  assert.equal(entries[0].cacheReadTok, 500);
  assert.equal(entries[0].cacheCreateTok, 20);
});

test('parseClaudeFiles_서로다른응답_모두합산', async () => {
  // Given: messageId가 다른 두 응답
  const file = writeJsonl([
    assistantLine({ id: 'msg_a', reqId: 'req_a', usage: { input_tokens: 10, output_tokens: 100 } }),
    assistantLine({ id: 'msg_b', reqId: 'req_b', usage: { input_tokens: 20, output_tokens: 200 } }),
  ]);

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: 2건 모두 남는다
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((s, e) => s + e.outputTok, 0), 300);
});

test('parseClaudeFiles_requestId없는라인_messageId키로dedup', async () => {
  // Given: requestId가 없는 같은 messageId 2줄
  const file = writeJsonl([
    assistantLine({ id: 'msg_x', reqId: null, usage: { output_tokens: 5 } }),
    assistantLine({ id: 'msg_x', reqId: null, usage: { output_tokens: 90 } }),
  ]);

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: message:<id> 키로 dedup되어 1건, output은 max
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outputTok, 90);
});

test('parseClaudeFiles_messageId없는라인_dedup없이전부합산', async () => {
  // Given: messageId가 아예 없는 2줄 (dedup 키 구성 불가)
  const file = writeJsonl([
    assistantLine({ id: null, reqId: null, usage: { output_tokens: 10 } }),
    assistantLine({ id: null, reqId: null, usage: { output_tokens: 10 } }),
  ]);

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: dedup하지 않고 둘 다 집계
  assert.equal(entries.length, 2);
});

test('parseClaudeFiles_파일간중복키_첫파일승리', async () => {
  // Given: resume 등으로 같은 키가 두 파일에 복제된 상황 — 뒤 파일이 더 큰 값을 가져도 무시
  const f1 = writeJsonl([assistantLine({ id: 'msg_dup', reqId: 'req_dup', usage: { output_tokens: 100 } })]);
  const f2 = writeJsonl([assistantLine({ id: 'msg_dup', reqId: 'req_dup', usage: { output_tokens: 999 } })]);

  // When
  const entries = await parseClaudeFiles([f1, f2]);

  // Then: 첫 파일 것만 남는다 (파일 내 max 병합은 파일 간에는 적용하지 않음)
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outputTok, 100);
});

test('parseClaudeFiles_synthetic모델과손상라인_집계제외', async () => {
  // Given: <synthetic> 모델, 모델 누락, usage 누락, 손상 JSON, 비-assistant 라인
  const file = join(dir, 'mixed.jsonl');
  writeFileSync(file, [
    assistantLine({ id: 'msg_syn', reqId: 'req_syn', model: '<synthetic>', usage: { output_tokens: 50 } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T03:00:00.000Z', message: { id: 'msg_nm', usage: { output_tokens: 5 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T03:00:00.000Z', message: { id: 'msg_nu', model: 'claude-sonnet-4-6' } }),
    '{broken json',
    JSON.stringify({ type: 'user', timestamp: '2026-06-10T03:00:00.000Z' }),
    assistantLine({ id: 'msg_ok', reqId: 'req_ok', usage: { output_tokens: 7 } }),
  ].join('\n'));

  // When
  const entries = await parseClaudeFiles([file]);

  // Then: 정상 라인 1건만 집계
  assert.equal(entries.length, 1);
  assert.equal(entries[0].outputTok, 7);
});

test('aggregateRecords_날짜모델집계와fromDate경계_경계날짜포함', () => {
  // Given: 날짜/모델이 섞인 항목들
  const entries = [
    { date: '2026-06-09', model: 'm1', inputTok: 1, outputTok: 1, cacheReadTok: 0, cacheCreateTok: 0 },
    { date: '2026-06-10', model: 'm1', inputTok: 2, outputTok: 2, cacheReadTok: 0, cacheCreateTok: 0 },
    { date: '2026-06-10', model: 'm1', inputTok: 3, outputTok: 3, cacheReadTok: 0, cacheCreateTok: 0 },
    { date: '2026-06-10', model: 'm2', inputTok: 4, outputTok: 4, cacheReadTok: 0, cacheCreateTok: 0 },
  ];

  // When: fromDate를 2026-06-10으로 — 경계 당일은 포함
  const records = aggregateRecords(entries, '2026-06-10');

  // Then: 06-09는 제외, 06-10은 모델별 2행으로 합산
  assert.equal(records.length, 2);
  const m1 = records.find((r) => r.model === 'm1');
  assert.equal(m1.inputTok, 5);
  assert.equal(m1.outputTok, 5);
  const m2 = records.find((r) => r.model === 'm2');
  assert.equal(m2.inputTok, 4);
});
