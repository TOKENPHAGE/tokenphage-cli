import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { parseAgy } from '../src/parsers/agy.js';
import { aggregateRecords } from '../src/parser.js';
import { syncAgy } from '../src/agy-sync.js';

test('AGY merges steps from both representations and syncs historical totals idempotently', async t => {
  const home = await mkdtemp(join(tmpdir(), 'agy-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const logs = join(home, 'brain', 'session', '.system_generated', 'logs');
  await mkdir(logs, { recursive: true });
  const ts = '1970-01-01T00:00:25Z';
  const turn = { step_index: 1, model: 'test', created_at: ts, input_tokens: 4,
    cache_read_tokens: 9, output_tokens: 3, thinking_tokens: 1 };
  await writeFile(join(logs, 'transcript.jsonl'), [turn, turn].map(r => JSON.stringify(r)).join('\n'));
  await mkdir(join(home, 'conversations'));
  const db = new Database(join(home, 'conversations', 'session.db'));
  db.exec('CREATE TABLE steps(idx INTEGER, metadata BLOB); CREATE TABLE gen_metadata(data BLOB)');
  // timestamp 25, model ID 1, input 4, output 3 (includes thinking 1), cache 9.
  const meta = Buffer.from([10,2,8,25,74,10,8,1,16,4,24,3,40,9,72,1]);
  for (const idx of [1, 2]) db.prepare('INSERT INTO steps VALUES (?,?)').run(idx, meta);
  db.close();
  const records = aggregateRecords(await parseAgy(home));
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { date: records[0].date, model: 'test', inputTok: 8,
    outputTok: 6, cacheReadTok: 18, cacheCreateTok: 0 });
  const payloads = [];
  const deviceId = '013cc5eb-b623-4175-a096-8a7145c47815';
  for (let run = 0; run < 2; run++) {
    await syncAgy({ home, deviceId, apiBase: 'https://example.test', token: 'test', log() {},
      fetchImpl: async (_, init) => { payloads.push(JSON.parse(init.body)); return { ok: true }; } });
  }
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[0].records, records);
  assert.notEqual(payloads[0].deviceId, deviceId);
});
