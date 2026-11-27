import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aggregateRecords } from './parser.js';
import { parseAgy } from './parsers/agy.js';
import { syncRecords } from './sync.js';

// AGY의 과거 사용량을 다시 보내도 기존 CLI가 같은 모델로 저장한 사용량과 키가 겹치지 않는다.
function agyDeviceId(deviceId) {
  const digest = createHash('sha256').update('tokenphage/agy/' + deviceId.toLowerCase()).digest();
  digest[6] = (digest[6] & 15) | 128; // UUIDv8
  digest[8] = (digest[8] & 63) | 128;
  const hex = digest.toString('hex', 0, 16);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export async function syncAgy({ apiBase, token, deviceId, home = process.env.TOKENPHAGE_AGY_HOME,
  fetchImpl, log = console.log }) {
  const dir = home || join(homedir(), '.gemini', 'antigravity-cli');
  const records = aggregateRecords(await parseAgy(dir, Boolean(home)));
  if (!records.length) return;

  const id = agyDeviceId(deviceId);
  const maxRecords = 10000; // SyncRequest.MAX_RECORDS
  for (let i = 0; i < records.length; i += maxRecords) {
    await syncRecords(apiBase, token, id, records.slice(i, i + maxRecords), [], { fetchImpl });
  }
  log(`Synced ${records.length} AGY records (date×model).`);
}
