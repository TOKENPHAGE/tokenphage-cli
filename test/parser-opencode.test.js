import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { parseOpencodeDatabase, parseOpencodeFiles, parseOpencodeRows } from '../src/parsers/opencode.js';
import { aggregateRecords } from '../src/parser.js';
import { localDateOf } from '../src/lib/dates.js';

// parseOpencodeFiles 동작 계약(회귀 보장).
// 리팩터링 후에도 아래 규칙이 그대로 유지되어야 한다.
//
// [포함/매핑 — 반드시 집계]
//  - role==='assistant'이고 id·modelID·유효 time.created를 가진 메시지의 step-finish part
//  - part는 스텝마다 개별 방출(합산은 aggregateRecords 담당)
//  - inputTok = tokens.input (그대로, 재차감 금지)
//  - outputTok = tokens.output + tokens.reasoning (reasoning 되살림)
//  - cacheReadTok = tokens.cache.read, cacheCreateTok = tokens.cache.write
//  - date = 부모 메시지 time.created 기준(part엔 시간이 없음), model = 부모 메시지 modelID
//  - message/part 입력 순서 무관
//
// [제외 — 무조건 집계에서 빠져야 함]
//  - 손상 JSON / 읽을 수 없는 경로 / null·비객체 JSON
//  - role!=='assistant'(user 등), type!=='step-finish'인 part(text·tool·step-start 등), session/project 파일
//  - id 없는 assistant, modelID 없는 assistant, time 없거나 파싱 불가한 assistant → 그 메시지의 part 전부 제외
//  - messageID 없는 step-finish, tokens 없는 step-finish
//  - 부모 메시지가 없는 orphan part
//  제외는 "다른 정상 레코드에 영향 없이" 그 항목만 빠져야 한다(각 제외 테스트는 정상 대조군과 함께 검증).
//
// [정규화 — 값 보정 후 포함]
//  - 음수/누락 토큰 필드는 0으로 보정하되 레코드 자체는 방출(제외 아님)

const TS = '2026-06-10T03:00:00.000Z';
const TS_MS = Date.parse(TS);                        // 기준일 epoch millis
const TS2_MS = Date.parse('2026-06-11T03:00:00.000Z'); // 하루 뒤(어느 타임존이든 다른 날짜)
const OK_MODEL = 'ok-model';
const OK_DATE = localDateOf(TS_MS);                   // DB 쿼리의 date 별칭과 같은 로컬 날짜

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-opencode-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

let seq = 0;
function writeJson(obj) {
  const file = join(dir, `f${seq++}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}
function writeRaw(text) {
  const file = join(dir, `r${seq++}.json`);
  writeFileSync(file, text);
  return file;
}
function assistantMessage({ id = 'msg_1', modelID = 'claude-sonnet-4-5', providerID = 'anthropic', time = { created: TS_MS, completed: TS_MS } } = {}) {
  return { role: 'assistant', id, modelID, providerID, time };
}
function stepFinishPart({ messageID = 'msg_1', tokens } = {}) {
  return {
    type: 'step-finish', messageID, sessionID: 'ses_1',
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...tokens },
  };
}
// 제외 테스트용 정상 대조군(메시지 + step-finish part). 파일 경로 배열을 돌려준다.
function okPair(outputTok = 7) {
  return [
    writeJson(assistantMessage({ id: 'ok', modelID: OK_MODEL })),
    writeJson(stepFinishPart({ messageID: 'ok', tokens: { output: outputTok } })),
  ];
}
// 결과가 정상 대조군 1건만 남았는지(=대상 항목이 영향 없이 제외됐는지) 단언한다.
function assertOnlyOk(entries) {
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model, OK_MODEL);
  assert.equal(entries[0].outputTok, 7);
}

// opencode.db와 같은 스키마(message.data / part.data JSON)의 SQLite 파일을 만든다.
function createUsageDb(name, steps) {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT);
  `);
  const insertMessage = db.prepare('INSERT OR IGNORE INTO message (id, time_created, data) VALUES (?, ?, ?)');
  const insertPart = db.prepare('INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)');
  steps.forEach((step, i) => {
    const { messageID, modelID, timeCreated, role = 'assistant', partType = 'step-finish', tokens } = step;
    insertMessage.run(messageID, timeCreated, JSON.stringify({ id: messageID, role, modelID }));
    insertPart.run(`prt_${i}`, messageID, JSON.stringify({ type: partType, messageID, tokens }));
  });
  db.close();
  return path;
}

// console.warn을 가로채 경고 발생 여부까지 함께 단언한다.
async function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(String(msg));
  try {
    return { entries: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('성공 — 포함·매핑', () => {
  test('parseOpencodeFiles_단일스텝_토큰4필드매핑', async () => {
    // Given
    const files = [
      writeJson(assistantMessage()),
      writeJson(stepFinishPart({ tokens: { input: 400, output: 300, reasoning: 900, cache: { read: 500, write: 20 } } })),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 4필드 매핑(reasoning은 output에 합산), 모델·로컬날짜 귀속
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      date: localDateOf(TS_MS), model: 'claude-sonnet-4-5',
      inputTok: 400, outputTok: 1200, cacheReadTok: 500, cacheCreateTok: 20,
    });
  });

  test('parseOpencodeFiles_reasoning존재_output에되살려합산', async () => {
    // Given: 추론 모델(output과 reasoning 분리 저장)
    const files = [writeJson(assistantMessage()), writeJson(stepFinishPart({ tokens: { output: 300, reasoning: 900 } }))];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: outputTok = 300 + 900
    assert.equal(entries[0].outputTok, 1200);
  });

  test('parseOpencodeFiles_reasoning만있고output없음_outputTok는reasoning값', async () => {
    // Given: output 0, reasoning만
    const files = [writeJson(assistantMessage()), writeJson(stepFinishPart({ tokens: { output: 0, reasoning: 500 } }))];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then
    assert.equal(entries[0].outputTok, 500);
  });

  test('parseOpencodeFiles_input이미캐시제외_그대로매핑_재차감없음', async () => {
    // Given: input은 opencode가 이미 캐시를 뺀 값
    const files = [writeJson(assistantMessage()), writeJson(stepFinishPart({ tokens: { input: 400, cache: { read: 600, write: 0 } } }))];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 400 유지(600 재차감 금지), cacheRead=600
    assert.equal(entries[0].inputTok, 400);
    assert.equal(entries[0].cacheReadTok, 600);
  });

  test('parseOpencodeFiles_캐시readwrite_각각cacheRead와cacheCreate로매핑', async () => {
    // Given: read/write 구분
    const files = [writeJson(assistantMessage()), writeJson(stepFinishPart({ tokens: { cache: { read: 111, write: 222 } } }))];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then
    assert.equal(entries[0].cacheReadTok, 111);
    assert.equal(entries[0].cacheCreateTok, 222);
  });

  test('parseOpencodeFiles_멀티스텝part_스텝마다개별방출', async () => {
    // Given: 한 메시지에 step-finish part 3개
    const files = [
      writeJson(assistantMessage()),
      writeJson(stepFinishPart({ tokens: { output: 10 } })),
      writeJson(stepFinishPart({ tokens: { output: 20 } })),
      writeJson(stepFinishPart({ tokens: { output: 30 } })),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 스텝마다 1건씩(합산 전) — 마지막 스텝만 남기지 않음
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map((e) => e.outputTok).sort((a, b) => a - b), [10, 20, 30]);
  });

  test('parseOpencodeFiles_멀티스텝_aggregate로전체합산', async () => {
    // Given
    const files = [
      writeJson(assistantMessage()),
      writeJson(stepFinishPart({ tokens: { input: 100, output: 10 } })),
      writeJson(stepFinishPart({ tokens: { input: 200, output: 20 } })),
      writeJson(stepFinishPart({ tokens: { input: 300, output: 30 } })),
    ];
    // When: 최종 합산은 aggregateRecords가 date×model로 수행
    const records = aggregateRecords(await parseOpencodeFiles(files));
    // Then: 3스텝 전부 합산(마지막 스텝 300/30만이 아님)
    assert.equal(records.length, 1);
    assert.equal(records[0].inputTok, 600);
    assert.equal(records[0].outputTok, 60);
  });

  test('parseOpencodeFiles_다중메시지_각part를부모의모델과날짜에귀속', async () => {
    // Given: 서로 다른 모델·날짜의 두 메시지, 각기 part 1개
    const files = [
      writeJson(assistantMessage({ id: 'a', modelID: 'claude-sonnet-4-5', time: { created: TS_MS } })),
      writeJson(stepFinishPart({ messageID: 'a', tokens: { output: 11 } })),
      writeJson(assistantMessage({ id: 'b', modelID: 'gpt-5', time: { created: TS2_MS } })),
      writeJson(stepFinishPart({ messageID: 'b', tokens: { output: 22 } })),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: part가 자기 부모의 model·date로만 귀속(교차 없음)
    assert.equal(entries.length, 2);
    const a = entries.find((e) => e.model === 'claude-sonnet-4-5');
    const b = entries.find((e) => e.model === 'gpt-5');
    assert.equal(a.outputTok, 11);
    assert.equal(a.date, localDateOf(TS_MS));
    assert.equal(b.outputTok, 22);
    assert.equal(b.date, localDateOf(TS2_MS));
    assert.notEqual(a.date, b.date);
  });

  test('parseOpencodeFiles_part가message보다먼저_순서무관조인', async () => {
    // Given: 파일 목록에서 part가 부모 message보다 먼저 등장
    const files = [
      writeJson(stepFinishPart({ messageID: 'later', tokens: { output: 42 } })),
      writeJson(assistantMessage({ id: 'later', modelID: 'm' })),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 순서와 무관하게 조인됨
    assert.equal(entries.length, 1);
    assert.equal(entries[0].outputTok, 42);
    assert.equal(entries[0].model, 'm');
  });

  test('parseOpencodeFiles_토큰필드일부누락_누락은0으로채워포함', async () => {
    // Given: output만 있는 part(input·reasoning·cache 누락)
    const files = [
      writeJson(assistantMessage()),
      writeJson({ type: 'step-finish', messageID: 'msg_1', sessionID: 'ses_1', tokens: { output: 5 } }),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 누락 필드는 0, 레코드는 포함
    assert.deepEqual(entries[0], {
      date: localDateOf(TS_MS), model: 'claude-sonnet-4-5',
      inputTok: 0, outputTok: 5, cacheReadTok: 0, cacheCreateTok: 0,
    });
  });
});

describe('제외 — 반드시 집계에서 빠져야 함(정상 대조군은 영향 없음)', () => {
  test('parseOpencodeFiles_손상JSON파일_제외되고정상유지', async () => {
    // Given: 깨진 JSON + 정상 대조군
    const files = [writeRaw('{not valid json'), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_존재하지않는경로_제외되고정상유지', async () => {
    // Given: 읽을 수 없는 경로(readFile ENOENT) + 정상 대조군
    const files = [join(dir, 'does-not-exist.json'), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_null과비객체JSON_제외되고안깨짐', async () => {
    // Given: null, 숫자, 문자열, 배열, boolean + 정상 대조군
    const files = [
      writeJson(null), writeJson(123), writeJson('str'), writeJson([1, 2]), writeJson(true),
      ...okPair(),
    ];
    // When / Then: 크래시 없이 정상만 남음
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_user메시지_제외', async () => {
    // Given: user 메시지 + 정상 대조군
    const files = [writeJson({ role: 'user', id: 'u1', time: { created: TS_MS } }), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_step_finish아닌part_제외', async () => {
    // Given: text·tool·step-start part + 정상 대조군
    const files = [
      writeJson({ type: 'text', messageID: 'ok', text: 'hi' }),
      writeJson({ type: 'tool', messageID: 'ok', tool: 'read' }),
      writeJson({ type: 'step-start', messageID: 'ok' }),
      ...okPair(),
    ];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_session또는project파일_무시', async () => {
    // Given: role도 step-finish도 아닌 session/project 파일 + 정상 대조군
    const files = [
      writeJson({ id: 'ses_x', title: 'a session', time: { created: TS_MS } }),
      writeJson({ id: 'prj_x', worktree: '/repo' }),
      ...okPair(),
    ];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_id없는assistant메시지_그파트제외', async () => {
    // Given: id 없는 assistant + 그 part + 정상 대조군
    const files = [
      writeJson({ role: 'assistant', modelID: 'm', time: { created: TS_MS } }), // id 없음 → 맵 미등록
      writeJson(stepFinishPart({ messageID: 'no_id_msg', tokens: { output: 999 } })), // 그 메시지를 가리킬 방법이 없어 귀속 불가
      ...okPair(),
    ];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_modelID없는assistant메시지_그파트제외', async () => {
    // Given: modelID 없는 메시지 + 그 part + 정상 대조군
    const files = [
      writeJson({ role: 'assistant', id: 'no_model', time: { created: TS_MS } }),
      writeJson(stepFinishPart({ messageID: 'no_model', tokens: { output: 999 } })),
      ...okPair(),
    ];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_time없거나파싱불가한assistant_그파트제외', async () => {
    // Given: time 누락, time.created가 파싱 불가 문자열 + 각 part + 정상 대조군
    const files = [
      writeJson({ role: 'assistant', id: 'no_time', modelID: 'm' }),
      writeJson(stepFinishPart({ messageID: 'no_time', tokens: { output: 999 } })),
      writeJson({ role: 'assistant', id: 'bad_time', modelID: 'm', time: { created: 'not-a-date' } }),
      writeJson(stepFinishPart({ messageID: 'bad_time', tokens: { output: 999 } })),
      ...okPair(),
    ];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_messageID없는step_finish_제외', async () => {
    // Given: messageID 없는 step-finish + 정상 대조군
    const files = [writeJson({ type: 'step-finish', sessionID: 'ses_1', tokens: { output: 999 } }), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_tokens없는step_finish_제외', async () => {
    // Given: tokens 없는 step-finish + 정상 대조군
    const files = [writeJson({ type: 'step-finish', messageID: 'ok', sessionID: 'ses_1' }), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_부모메시지없는orphanpart_제외', async () => {
    // Given: 부모 메시지가 없는 messageID의 part + 정상 대조군
    const files = [writeJson(stepFinishPart({ messageID: 'ghost', tokens: { output: 999 } })), ...okPair()];
    // When / Then
    assertOnlyOk(await parseOpencodeFiles(files));
  });

  test('parseOpencodeFiles_빈파일목록_빈배열', async () => {
    // Given / When
    const entries = await parseOpencodeFiles([]);
    // Then
    assert.deepEqual(entries, []);
  });
});

describe('정규화 — 값 보정 후 포함', () => {
  test('parseOpencodeFiles_음수토큰_전부0으로클램프하되레코드는방출', async () => {
    // Given: 모든 토큰 필드가 음수 + 정상 대조군
    const files = [
      writeJson(assistantMessage({ id: 'neg', modelID: 'm' })),
      writeJson(stepFinishPart({ messageID: 'neg', tokens: { input: -5, output: -1, reasoning: -3, cache: { read: -2, write: -4 } } })),
      ...okPair(),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: 음수 레코드는 제외가 아니라 전 필드 0으로 방출(대조군 포함 2건)
    assert.equal(entries.length, 2);
    const neg = entries.find((e) => e.model === 'm');
    assert.deepEqual(neg, { date: localDateOf(TS_MS), model: 'm', inputTok: 0, outputTok: 0, cacheReadTok: 0, cacheCreateTok: 0 });
  });

  test('parseOpencodeFiles_cache객체누락_캐시필드0', async () => {
    // Given: tokens에 cache 객체가 없음
    const files = [
      writeJson(assistantMessage()),
      writeJson({ type: 'step-finish', messageID: 'msg_1', sessionID: 'ses_1', tokens: { input: 10, output: 20 } }),
    ];
    // When
    const entries = await parseOpencodeFiles(files);
    // Then: cacheRead/Create 0으로 방어
    assert.equal(entries.length, 1);
    assert.equal(entries[0].cacheReadTok, 0);
    assert.equal(entries[0].cacheCreateTok, 0);
  });
});

describe('SQLite 저장소', () => {
  test('parseOpencodeRows_DB컬럼을기존토큰계약으로매핑', () => {
    const entries = parseOpencodeRows([{
      date: '2026-06-10',
      model: 'claude-sonnet-4-6',
      input: 400,
      output: 300,
      reasoning: 900,
      cache_read: 500,
      cache_write: 20,
    }]);

    assert.deepEqual(entries, [{
      date: '2026-06-10', model: 'claude-sonnet-4-6',
      inputTok: 400, outputTok: 1200, cacheReadTok: 500, cacheCreateTok: 20,
    }]);
  });

  // 행 shape은 USAGE_QUERY가 내보내는 7개 별칭 그대로다.
  // date는 strftime 결과이므로 'YYYY-MM-DD' 아니면 NULL(m.time_created가 NULL일 때)이다.
  test('parseOpencodeRows_모델또는날짜가없는행은제외', () => {
    const entries = parseOpencodeRows([
      { date: OK_DATE, model: null, output: 999 },
      { date: null, model: 'bad-time', output: 999 },
      { date: OK_DATE, model: OK_MODEL, output: 7 },
    ]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, OK_DATE);
    assert.equal(entries[0].model, OK_MODEL);
    assert.equal(entries[0].outputTok, 7);
  });

  test('parseOpencodeDatabase_time_created가NULL인메시지_집계에서제외', async () => {
    // Given: time_created가 NULL이면 strftime이 NULL을 돌려줘 date를 만들 수 없다 + 정상 대조군
    const dbPath = createUsageDb('null-time.db', [
      { messageID: 'no_time', modelID: 'skip', timeCreated: null, tokens: { output: 999 } },
      { messageID: 'ok', modelID: OK_MODEL, timeCreated: TS_MS, tokens: { output: 7 } },
    ]);

    // When / Then: 귀속할 날짜가 없는 행만 빠진다
    assertOnlyOk(await parseOpencodeDatabase(dbPath));
  });

  test('parseOpencodeDatabase_실제DB를외부CLI없이직접조회', async () => {
    // Given: opencode.db와 같은 스키마의 실제 SQLite 파일(OpenCode CLI는 설치되어 있지 않아도 된다)
    const dbPath = createUsageDb('direct.db', [
      { messageID: 'm1', modelID: 'db-model', timeCreated: TS_MS, tokens: { input: 400, output: 300, reasoning: 900, cache: { read: 500, write: 20 } } },
    ]);

    // When
    const entries = await parseOpencodeDatabase(dbPath);

    // Then: 4필드 매핑(reasoning은 output에 합산)
    assert.deepEqual(entries, [{
      date: localDateOf(TS_MS), model: 'db-model',
      inputTok: 400, outputTok: 1200, cacheReadTok: 500, cacheCreateTok: 20,
    }]);
  });

  test('parseOpencodeDatabase_같은날짜모델의여러스텝_DB에서합산', async () => {
    // Given: 한 메시지에 step-finish part 3개(스텝마다 토큰이 다름)
    const dbPath = createUsageDb('steps.db', [
      { messageID: 'm1', modelID: 'db-model', timeCreated: TS_MS, tokens: { input: 100, output: 10 } },
      { messageID: 'm1', modelID: 'db-model', timeCreated: TS_MS, tokens: { input: 200, output: 20 } },
      { messageID: 'm1', modelID: 'db-model', timeCreated: TS_MS, tokens: { input: 300, output: 30 } },
    ]);

    // When
    const entries = await parseOpencodeDatabase(dbPath);

    // Then: date×model 1건으로 전 스텝 합산(마지막 스텝만이 아님)
    assert.equal(entries.length, 1);
    assert.equal(entries[0].inputTok, 600);
    assert.equal(entries[0].outputTok, 60);
  });

  test('parseOpencodeDatabase_assistant아니거나step_finish아닌행_제외', async () => {
    // Given: user 메시지·step-finish 아닌 part·tokens 없는 part + 정상 대조군
    const dbPath = createUsageDb('filtered.db', [
      { messageID: 'u1', modelID: 'skip', timeCreated: TS_MS, role: 'user', tokens: { output: 999 } },
      { messageID: 't1', modelID: 'skip', timeCreated: TS_MS, partType: 'text', tokens: { output: 999 } },
      { messageID: 'n1', modelID: 'skip', timeCreated: TS_MS, tokens: null },
      { messageID: 'x1', modelID: null, timeCreated: TS_MS, tokens: { output: 999 } },
      { messageID: 'ok', modelID: OK_MODEL, timeCreated: TS_MS, tokens: { output: 7 } },
    ]);

    // When / Then
    assertOnlyOk(await parseOpencodeDatabase(dbPath));
  });

  // OpenCode 상태(삭제·손상·스키마 변경)가 claude/codex sync를 막으면 안 된다.
  // parseAll이 Promise.all로 묶기 때문에 여기서 throw하면 다른 source 결과까지 버려진다.
  // 또한 집계할 기록이 없을 뿐인 상황은 경고 없이 조용히 넘어가야 한다.
  test('parseOpencodeDatabase_DB없음_경고없이빈목록', async () => {
    // Given: 존재하지 않는 경로(= 집계할 기록이 없음)
    const missing = join(dir, 'nope.db');
    // When
    const { entries, warnings } = await captureWarnings(() => parseOpencodeDatabase(missing));
    // Then: OpenCode 미사용자를 시끄럽게 하지 않는다
    assert.deepEqual(entries, []);
    assert.deepEqual(warnings, []);
  });

  test('parseOpencodeDatabase_빈DB_경고없이빈목록', async () => {
    // Given: 테이블이 하나도 없는 DB(OpenCode 삭제 후 잔존 파일)
    const path = join(dir, 'empty.db');
    new Database(path).close();
    // When
    const { entries, warnings } = await captureWarnings(() => parseOpencodeDatabase(path));
    // Then
    assert.deepEqual(entries, []);
    assert.deepEqual(warnings, []);
  });

  test('parseOpencodeDatabase_손상된DB파일_경고와함께빈목록', async () => {
    // Given: 파일은 남아 있는데 SQLite가 아님 → 사용량이 누락되는 중이므로 알려야 한다
    const broken = join(dir, 'broken.db');
    writeFileSync(broken, 'not a sqlite file');
    // When
    const { entries, warnings } = await captureWarnings(() => parseOpencodeDatabase(broken));
    // Then
    assert.deepEqual(entries, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not read/);
  });

  test('parseOpencodeDatabase_다른테이블만있음_스키마변경경고', async () => {
    // Given: 유효한 DB에 테이블은 있으나 message/part가 없음(OpenCode 스키마 변경)
    const path = join(dir, 'schema.db');
    const db = new Database(path);
    db.exec('CREATE TABLE unrelated (id TEXT)');
    db.close();
    // When
    const { entries, warnings } = await captureWarnings(() => parseOpencodeDatabase(path));
    // Then: 집계가 0으로 새는 것을 조용히 넘기지 않는다
    assert.deepEqual(entries, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /schema changed/);
  });

  test('parseAll_OpenCodeDB실패_claude와codex집계는정상', async () => {
    // Given: OpenCode 조회는 실패하고, 다른 source는 정상 항목을 낸 상황
    const opencodeEntries = await parseOpencodeDatabase(join(dir, 'gone.db'));
    const claudeLike = { date: '2026-06-10', model: 'claude', inputTok: 5, outputTok: 5, cacheReadTok: 0, cacheCreateTok: 0 };
    const codexLike = { date: '2026-06-10', model: 'codex', inputTok: 3, outputTok: 3, cacheReadTok: 0, cacheCreateTok: 0 };

    // When: parseAll과 동일하게 합산
    const records = aggregateRecords([claudeLike, codexLike, ...opencodeEntries]);

    // Then: OpenCode만 빠지고 나머지는 그대로 집계된다
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((r) => r.model).sort(), ['claude', 'codex']);
  });
});
