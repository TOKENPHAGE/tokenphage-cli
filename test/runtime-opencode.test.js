import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { parseOpencodeDatabase } from '../src/parsers/opencode.js';
import { createOpencodeRuntimeCollector } from '../src/runtime/opencode.js';

// 테스트 목록 (opencode 로그 해석 — 턴 경계·중복 제거·모델만 본다. 타임라인 규칙은 runtime-timeline 테스트)
// 1. opencode추출_세션과자식세션_합산하고source는opencode와modelID          (해피)
// 2. opencode추출_DB를읽을수없음_실패로보고하고빈DB는실패아님               (실패)
// 3. opencode추출_포크복사본같은시각모델_가장오래된세션것만1회              (엣지)
// 4. opencode추출_step_start없는셸명령메시지_제외                           (엣지)
// 5. opencode추출_time_completed없는메시지_제외                             (엣지)
// 6. opencode추출_대기열에쌓인질문_턴시작은첫assistant생성시각              (엣지)
//
// 표 구조는 upstream opencode(packages/opencode/src/session/session.sql.ts, v1.4.0)의 session·message·part를 따른다.

const T0 = new Date(2026, 5, 10, 9, 0).getTime();
const sec = (s) => T0 + s * 1000;

let dir;
let seq = 0;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-rt-opencode-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * opencode.db와 같은 표로 테스트 DB를 만든다.
 * sessions: [{ id, parentId?, created, messages: [{ id, role, parentID?, modelID?, created, completed?, parts? }] }]
 */
function createDb(sessions) {
  const path = join(dir, `opencode-${seq++}.db`);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
      title TEXT NOT NULL, version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const insertSession = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertMessage = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  let partSeq = 0;
  for (const s of sessions) {
    insertSession.run(s.id, 'prj', s.parentId ?? null, 'slug', '/w', 'title', '1.4.0', s.created, s.created);
    for (const m of s.messages) {
      const time = m.completed === undefined ? { created: m.created } : { created: m.created, completed: m.completed };
      const data = m.role === 'user'
        ? { role: 'user', time, agent: 'build', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } }
        : { role: 'assistant', time, parentID: m.parentID, modelID: m.modelID ?? 'claude-sonnet-4-5', providerID: 'anthropic', mode: 'build' };
      insertMessage.run(m.id, s.id, m.created, m.completed ?? m.created, JSON.stringify(data));
      const parts = m.parts ?? (m.role === 'assistant' ? ['step-start', 'text', 'step-finish'] : ['text']);
      for (const type of parts) insertPart.run(`prt_${partSeq++}`, m.id, s.id, m.created, m.created, JSON.stringify({ type }));
    }
  }
  db.close();
  return path;
}

const user = (id, s) => ({ id, role: 'user', created: sec(s) });
const assistant = (id, parentID, from, to, fields = {}) => ({ id, role: 'assistant', parentID, created: sec(from), completed: sec(to), ...fields });

async function runtimeOf(dbPath) {
  const collector = createOpencodeRuntimeCollector();
  const original = console.warn;
  console.warn = () => {}; // 토큰 파서의 읽기 실패 경고는 이 테스트의 관심사가 아니다
  try {
    await parseOpencodeDatabase(dbPath, undefined, collector.onDatabase);
  } finally {
    console.warn = original;
  }
  return collector.result();
}
const total = (rows) => rows.reduce((sum, r) => sum + r.runtimeMs, 0);

test('opencode추출_세션과자식세션_합산하고source는opencode와modelID', async () => {
  // Given: 부모 세션 한 턴(assistant 2개, 20초)과 task 도구로 만든 자식 세션(다른 모델, 10초)
  const dbPath = createDb([
    { id: 'ses_a', created: sec(0), messages: [user('msg_u1', 0), assistant('msg_a1', 'msg_u1', 1, 11), assistant('msg_a2', 'msg_u1', 11.5, 21)] },
    { id: 'ses_c', parentId: 'ses_a', created: sec(2), messages: [user('msg_cu', 2), assistant('msg_ca', 'msg_cu', 3, 13, { modelID: 'claude-haiku-4-5' })] },
  ]);

  // When
  const { source, ok, rows } = await runtimeOf(dbPath);

  // Then: 세션마다 따로 계산해 modelID별로 남는다
  assert.equal(source, 'opencode');
  assert.equal(ok, true);
  assert.deepEqual(rows, [
    { date: '2026-06-10', source: 'opencode', model: 'claude-sonnet-4-5', runtimeMs: 20_000 },
    { date: '2026-06-10', source: 'opencode', model: 'claude-haiku-4-5', runtimeMs: 10_000 },
  ]);
});

test('opencode추출_DB를읽을수없음_실패로보고하고빈DB는실패아님', async () => {
  // Given: SQLite가 아닌 파일, message·part 표가 없는 DB(스키마 변경), 표가 하나도 없는 DB(opencode 삭제 후 남은 파일)
  const broken = join(dir, 'broken.db');
  writeFileSync(broken, 'not a sqlite file');
  const changed = join(dir, 'changed.db');
  const changedDb = new Database(changed);
  changedDb.exec('CREATE TABLE session_v2 (id TEXT)');
  changedDb.close();
  const empty = join(dir, 'empty.db');
  new Database(empty).close();

  // When
  const results = await Promise.all([broken, changed, empty].map(runtimeOf));

  // Then: 읽지 못한 DB만 실패로 넘기고, 빈 DB는 기록이 없을 뿐이다
  assert.deepEqual(results.map((r) => [r.ok, r.rows.length]), [[false, 0], [false, 0], [true, 0]]);
});

test('opencode추출_포크복사본같은시각모델_가장오래된세션것만1회', async () => {
  // Given: 원본 턴(a1·a2, 사이 30초 포함 50초)과, a1까지만 새 id로 복사한 뒤 새 턴(20초)을 이어간 포크.
  // 포크 세션 행을 먼저 넣어 저장 순서로는 원본을 고를 수 없게 한다.
  const dbPath = createDb([
    { id: 'ses_fork', created: sec(3600), messages: [
      user('msg_fu1', 0), assistant('msg_fa1', 'msg_fu1', 1, 11),
      user('msg_fu2', 3600), assistant('msg_fa2', 'msg_fu2', 3610, 3630),
    ] },
    { id: 'ses_orig', created: sec(0), messages: [user('msg_u1', 0), assistant('msg_a1', 'msg_u1', 1, 11), assistant('msg_a2', 'msg_u1', 41, 51)] },
  ]);

  // When / Then: 복사된 a1은 원본 세션 것만 세어 원본 턴이 50초로 남는다(+ 포크 새 턴 20초)
  assert.equal(total((await runtimeOf(dbPath)).rows), 70_000);
});

test('opencode추출_step_start없는셸명령메시지_제외', async () => {
  // Given: 모델 턴(10초) 뒤 사용자 셸 명령(!cmd) — 도구 파트만 있고 step-start가 없다
  const dbPath = createDb([{ id: 'ses_a', created: sec(0), messages: [
    user('msg_u1', 0), assistant('msg_a1', 'msg_u1', 1, 11),
    user('msg_u2', 100), assistant('msg_a2', 'msg_u2', 100, 160, { parts: ['tool'] }),
  ] }]);

  // When / Then
  assert.equal(total((await runtimeOf(dbPath)).rows), 10_000);
});

test('opencode추출_time_completed없는메시지_제외', async () => {
  // Given: 턴의 첫 assistant가 끝나지 않았고(중단·진행 중), 다음 assistant가 31~41초에 완료
  const dbPath = createDb([{ id: 'ses_a', created: sec(0), messages: [
    user('msg_u1', 0), { id: 'msg_a1', role: 'assistant', parentID: 'msg_u1', created: sec(1) }, assistant('msg_a2', 'msg_u1', 31, 41),
  ] }]);

  // When / Then: 끝나지 않은 메시지는 빼므로 턴은 a2의 생성 시각부터
  assert.equal(total((await runtimeOf(dbPath)).rows), 10_000);
});

test('opencode추출_대기열에쌓인질문_턴시작은첫assistant생성시각', async () => {
  // Given: 첫 턴(1~30초)이 도는 동안 5초에 두 번째 질문이 대기열에 쌓이고, 그 답은 31~41초
  const dbPath = createDb([{ id: 'ses_a', created: sec(0), messages: [
    user('msg_u1', 0), user('msg_u2', 5), assistant('msg_a1', 'msg_u1', 1, 30), assistant('msg_a2', 'msg_u2', 31, 41),
  ] }]);

  // When / Then: 두 턴이 겹치지 않아 29초 + 10초
  assert.equal(total((await runtimeOf(dbPath)).rows), 39_000);
});
