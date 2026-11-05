import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { readLogs } from '../src/runtime/read-logs.js';
import { parseClaudeFiles } from '../src/parsers/claude.js';
import { parseCodexFiles } from '../src/parsers/codex.js';
import { parseOpencodeDatabase } from '../src/parsers/opencode.js';

// 테스트 목록 (로그 한 번 읽기와 소스 합치기 — 소스를 합치는 규칙은 이 파일에서만 검사한다)
// 1. readLogs_세소스결과_날짜소스모델로합침                                   (해피)
// 2. readLogs_한소스실패_나머지결과유지하고allSourcesRead는false              (실패)
// 3. readLogs_claude파일을열수없음_예외                                       (실패)
// 4. readLogs_같은모델을ClaudeCode와opencode에서씀_source가다른두줄           (엣지)
// 5. readLogs_source는모델이름과상관없이읽은로그로정함                        (엣지)
// 6. readLogs_runtimeFrom_그날짜포함이후만                                    (경곗값)
// 7. readLogs_로그없는소스_성공조건에서뺌                                     (엣지)
// 8. readLogs_같은읽기의토큰항목_수집기없이읽은결과와같음                     (회귀)

const SHAPES = {
  humanPrompt: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    origin: {
      kind: "human"
    },
    message: {
      role: "user",
      content: ""
    }
  },
  assistant: {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        {
          type: "thinking"
        }
      ]
    }
  }
};

let root;
let seq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), 'tp-rt-logs-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

const localMs = (day, s) => new Date(2026, 5, day, 9, 0, s).getTime();
const iso = (day, s) => new Date(localMs(day, s)).toISOString();

function writeFile(relPath, lines) {
  const file = join(root, `c${seq++}`, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Claude 메인 세션 하나: 질문 뒤 seconds초에 응답(usage 포함). */
function claudeSession(model, seconds, day = 10) {
  const prompt = { ...SHAPES.humanPrompt, timestamp: iso(day, 0), uuid: `cu${seq++}`, promptId: `p${seq}` };
  const answer = structuredClone(SHAPES.assistant);
  Object.assign(answer, { timestamp: iso(day, seconds), uuid: `ca${seq++}`, requestId: `req${seq}` });
  answer.message = { ...answer.message, id: `msg${seq}`, model, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  return writeFile('projects/-p/s.jsonl', [JSON.stringify(prompt), JSON.stringify(answer)]);
}

/** Codex rollout 하나: 한 턴이 seconds초(응답 뒤 token_count 포함). */
function codexRollout(model, seconds, day = 10) {
  const line = (s, type, payload) => JSON.stringify({ timestamp: iso(day, s), type, payload });
  const usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 107 };
  return writeFile('sessions/rollout.jsonl', [
    line(0, 'session_meta', { id: `x${seq}`, timestamp: iso(day, 0), cwd: '/w', originator: 'codex_cli_rs', cli_version: '0.120.0', source: 'cli' }),
    line(0, 'event_msg', { type: 'task_started', turn_id: `turn${seq}` }),
    line(0, 'turn_context', { turn_id: `turn${seq}`, model }),
    line(seconds, 'response_item', { type: 'message', role: 'assistant', content: [] }),
    line(seconds, 'event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage } }),
    line(seconds + 1, 'event_msg', { type: 'task_complete', turn_id: `turn${seq}` }),
  ]);
}

/** opencode.db 하나: 한 턴이 seconds초(step-finish 토큰 포함). */
function opencodeDb(model, seconds, day = 10) {
  const path = join(root, `c${seq++}`, 'opencode.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);
  `);
  const start = localMs(day, 0);
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_1', null, start);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_u', 'ses_1', start, JSON.stringify({ role: 'user', time: { created: start } }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('msg_a', 'ses_1', start, JSON.stringify({
    role: 'assistant', parentID: 'msg_u', modelID: model, time: { created: start, completed: start + seconds * 1000 },
  }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('prt_1', 'msg_a', 'ses_1', JSON.stringify({ type: 'step-start' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('prt_2', 'msg_a', 'ses_1', JSON.stringify({ type: 'step-finish', tokens: { input: 3, output: 4 } }));
  db.close();
  return path;
}

function paths({ claudeFiles = [], codexFiles = [], opencodeDatabase = null, opencodeFiles = [] } = {}) {
  return { claudeFiles, codexFiles, opencodeDatabase, opencodeFiles };
}

async function quietly(fn) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

const pick = (runtimes) => runtimes.map((r) => [r.date, r.source, r.model, r.runtimeMs]);

test('readLogs_세소스결과_날짜소스모델로합침', async () => {
  // Given: 같은 날 세 도구가 각자 일한 기록
  const input = paths({
    claudeFiles: [claudeSession('claude-opus-4-1', 10)],
    codexFiles: [codexRollout('gpt-5.1-codex', 20)],
    opencodeDatabase: opencodeDb('claude-haiku-4-5', 30),
  });

  // When
  const { runtimes, allSourcesRead } = await readLogs(input);

  // Then
  assert.equal(allSourcesRead, true);
  assert.deepEqual(pick(runtimes), [
    ['2026-06-10', 'claude', 'claude-opus-4-1', 10_000],
    ['2026-06-10', 'codex', 'gpt-5.1-codex', 20_000],
    ['2026-06-10', 'opencode', 'claude-haiku-4-5', 30_000],
  ]);
});

test('readLogs_한소스실패_나머지결과유지하고allSourcesRead는false', async () => {
  // Given: opencode.db가 손상돼 열 수 없다
  const broken = join(root, `c${seq++}-opencode.db`);
  writeFileSync(broken, 'not a sqlite file');
  const input = paths({ claudeFiles: [claudeSession('claude-opus-4-1', 10)], codexFiles: [codexRollout('gpt-5.1-codex', 20)], opencodeDatabase: broken });

  // When
  const { runtimes, allSourcesRead, failedSources } = await quietly(() => readLogs(input));

  // Then: 읽은 도구의 결과는 그대로 넘기고 읽지 못한 도구를 알린다
  assert.equal(allSourcesRead, false);
  assert.deepEqual(failedSources, ['opencode']);
  assert.deepEqual(pick(runtimes).map((r) => r[1]), ['claude', 'codex']);
});

test('readLogs_claude파일을열수없음_예외', async () => {
  // Given: 목록에는 있지만 열 수 없는 Claude 파일
  const input = paths({ claudeFiles: [join(root, 'missing', 'gone.jsonl')], codexFiles: [codexRollout('gpt-5.1-codex', 20)] });

  // When / Then: 토큰을 일부만 보내 서버 값을 덮어쓰지 않도록 지금처럼 실패시킨다
  await assert.rejects(() => readLogs(input), { code: 'ENOENT' });
});

test('readLogs_같은모델을ClaudeCode와opencode에서씀_source가다른두줄', async () => {
  // Given: 같은 날 같은 모델을 두 도구에서 사용
  const input = paths({ claudeFiles: [claudeSession('claude-sonnet-4-5', 10)], opencodeDatabase: opencodeDb('claude-sonnet-4-5', 30) });

  // When
  const { runtimes } = await readLogs(input);

  // Then: 토큰과 달리 실행시간은 도구별 두 줄이다
  assert.deepEqual(pick(runtimes), [
    ['2026-06-10', 'claude', 'claude-sonnet-4-5', 10_000],
    ['2026-06-10', 'opencode', 'claude-sonnet-4-5', 30_000],
  ]);
});

test('readLogs_source는모델이름과상관없이읽은로그로정함', async () => {
  // Given: Codex에서 claude 이름의 모델, opencode에서 gpt 모델
  const input = paths({ codexFiles: [codexRollout('claude-sonnet-4-5', 20)], opencodeDatabase: opencodeDb('gpt-5.1-codex', 30) });

  // When
  const { runtimes } = await readLogs(input);

  // Then
  assert.deepEqual(pick(runtimes).map((r) => [r[1], r[2]]), [['codex', 'claude-sonnet-4-5'], ['opencode', 'gpt-5.1-codex']]);
});

test('readLogs_runtimeFrom_그날짜포함이후만', async () => {
  // Given: 6/9, 6/10, 6/11에 각 10초
  const input = paths({ claudeFiles: [9, 10, 11].map((day) => claudeSession('claude-opus-4-1', 10, day)) });

  // When
  const { runtimes } = await readLogs(input, '2026-06-10');

  // Then: 기준 날짜 당일은 포함, 하루 전은 제외
  assert.deepEqual(pick(runtimes).map((r) => r[0]), ['2026-06-10', '2026-06-11']);
});

test('readLogs_로그없는소스_성공조건에서뺌', async () => {
  // Given: Claude만 설치(Codex·opencode 로그 없음), opencode는 실행시간 범위 밖인 옛 JSON 저장소만 있는 경우
  const claudeOnly = paths({ claudeFiles: [claudeSession('claude-opus-4-1', 10)] });
  const legacyOpencode = paths({ claudeFiles: [claudeSession('claude-opus-4-1', 10)], opencodeFiles: [writeFile('storage/message/m.json', ['{}'])] });
  const nothing = paths();

  // When
  const results = await Promise.all([claudeOnly, legacyOpencode, nothing].map((p) => readLogs(p)));

  // Then
  assert.deepEqual(results.map((r) => [r.allSourcesRead, r.runtimes.length]), [[true, 1], [true, 1], [true, 0]]);
});

test('readLogs_같은읽기의토큰항목_수집기없이읽은결과와같음', async () => {
  // Given
  const claudeFiles = [claudeSession('claude-opus-4-1', 10)];
  const codexFiles = [codexRollout('gpt-5.1-codex', 20)];
  const opencodeDatabase = opencodeDb('claude-haiku-4-5', 30);

  // When
  const { entries } = await readLogs(paths({ claudeFiles, codexFiles, opencodeDatabase }));
  const plain = [
    ...await parseClaudeFiles(claudeFiles),
    ...await parseCodexFiles(codexFiles),
    ...await parseOpencodeDatabase(opencodeDatabase),
  ];

  // Then: 실행시간을 함께 모아도 토큰 항목은 바뀌지 않는다
  assert.ok(plain.length === 3);
  assert.deepEqual(entries, plain);
});
