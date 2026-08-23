import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { localDateOf } from '../src/lib/dates.js';
import { parseHermesSessions } from '../src/parsers/hermes.js';

// 테스트 목록
// 1. parseHermesSessions_종료세션_공통6필드매핑                 (성공)
// 2. parseHermesSessions_진행중세션_집계제외                   (경계)
// 3. parseHermesSessions_모델또는종료시각무효_집계제외          (실패 입력)
// 4. parseHermesSessions_음수및누락토큰_0보정                  (실패 입력)
// 5. parseHermesSessions_DB없음_빈목록반환                     (실패 입력)

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'tp-hermes-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

function createDb(name = 'state.db') {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      model TEXT,
      started_at REAL,
      ended_at REAL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0
    )
  `);
  return { path, db };
}

function insertSession(db, values = {}) {
  db.prepare(`
    INSERT INTO sessions (
      id, model, started_at, ended_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
    ) VALUES (
      @id, @model, @started_at, @ended_at,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens
    )
  `).run({
    id: 'session-1',
    model: 'gpt-5.6-terra',
    started_at: 1785806000,
    ended_at: 1785806458.785922,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 700,
    cache_write_tokens: 40,
    reasoning_tokens: 100,
    ...values,
  });
}

test('parseHermesSessions_종료세션_공통6필드매핑', async () => {
  // Given: Hermes가 Unix seconds로 기록한 종료 세션
  const { path, db } = createDb('valid.db');
  insertSession(db);
  db.close();

  // When
  const entries = await parseHermesSessions(path);

  // Then: reasoning은 output에 별도 합산하지 않고 공통 6필드만 반환
  assert.deepEqual(entries, [{
    date: localDateOf(new Date(1785806458.785922 * 1000)),
    model: 'gpt-5.6-terra',
    inputTok: 1200,
    outputTok: 300,
    cacheReadTok: 700,
    cacheCreateTok: 40,
  }]);
});

test('parseHermesSessions_진행중세션_집계제외', async () => {
  // Given: ended_at이 없는 진행 중 세션과 종료 세션
  const { path, db } = createDb('running.db');
  insertSession(db, { id: 'finished' });
  insertSession(db, { id: 'running', model: 'gpt-5.6-terra-running', ended_at: null, output_tokens: 999 });
  db.close();

  // When
  const entries = await parseHermesSessions(path);

  // Then: 누적값이 변하는 진행 중 세션은 중복 집계를 막기 위해 제외
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model, 'gpt-5.6-terra');
});

test('parseHermesSessions_모델또는종료시각무효_집계제외', async () => {
  // Given: 모델이 비었거나 종료 시각이 무효인 종료 세션
  const { path, db } = createDb('invalid.db');
  insertSession(db, { id: 'ok' });
  insertSession(db, { id: 'no-model', model: '  ' });
  insertSession(db, { id: 'bad-time', model: 'gpt-bad-time', ended_at: 'not-a-timestamp' });
  db.close();

  // When
  const entries = await parseHermesSessions(path);

  // Then: 정상 세션만 남는다
  assert.equal(entries.length, 1);
  assert.equal(entries[0].model, 'gpt-5.6-terra');
});

test('parseHermesSessions_음수및누락토큰_0보정', async () => {
  // Given: 손상/구버전 DB의 음수·null 토큰 값
  const { path, db } = createDb('tokens.db');
  insertSession(db, {
    input_tokens: -1,
    output_tokens: null,
    cache_read_tokens: -3,
    cache_write_tokens: null,
  });
  db.close();

  // When
  const [entry] = await parseHermesSessions(path);

  // Then: 레코드는 유지하되 비정상 토큰은 0으로 보정
  assert.deepEqual({
    inputTok: entry.inputTok,
    outputTok: entry.outputTok,
    cacheReadTok: entry.cacheReadTok,
    cacheCreateTok: entry.cacheCreateTok,
  }, {
    inputTok: 0,
    outputTok: 0,
    cacheReadTok: 0,
    cacheCreateTok: 0,
  });
});

test('parseHermesSessions_DB없음_빈목록반환', async () => {
  // Given / When: Hermes를 설치하지 않았거나 state.db가 없는 환경
  const entries = await parseHermesSessions(join(dir, 'missing.db'));

  // Then: 다른 source의 sync는 계속 진행된다
  assert.deepEqual(entries, []);
});
