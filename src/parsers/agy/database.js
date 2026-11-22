import { localDateOf } from '../../lib/dates.js';
import { tokenRecord } from './record.js';

// AGY stores protobuf messages in steps.metadata. Read individual fields without
// decoding prompt text or tool payloads. Fixed-width fields can be skipped.
function fields(bytes = []) {
  const result = new Map();
  let offset = 0;
  function varint() {
    let n = 0n;
    for (let shift = 0n; shift < 70n && offset < bytes.length; shift += 7n) {
      const b = bytes[offset++];
      n |= BigInt(b & 127) << shift;
      if (b < 128) return Number(n);
    }
    throw new Error('Invalid AGY protobuf integer');
  }
  while (offset < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    switch (key % 8) {
      case 0: result.set(field, varint()); break;
      case 1: offset += 8; break;
      case 2: {
        const length = varint();
        result.set(field, bytes.subarray(offset, offset + length));
        offset += length;
        break;
      }
      case 5: offset += 4; break;
      default: throw new Error('Unsupported AGY protobuf field');
    }
    if (offset > bytes.length) throw new Error('Truncated AGY metadata');
  }
  return result;
}

export async function readDatabase(file, turns) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = new Map();
    const missing = [];
    for (const { idx, metadata } of db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL').iterate()) {
      const meta = fields(metadata);
      const usage = fields(meta.get(9));
      if (!usage.size) continue;
      const modelId = usage.get(1);
      if (turns.has(idx)) names.set(modelId, turns.get(idx).model);
      else if ([2, 3, 5].some(k => usage.get(k))) missing.push({ meta, usage, idx, modelId });
    }
    if (missing.length) {
      for (const { data } of db.prepare('SELECT data FROM gen_metadata').iterate()) {
        const request = fields(fields(data).get(1));
        const name = request.get(19)?.toString();
        if (name) names.set(fields(request.get(4)).get(1), name);
      }
    }
    for (const { meta, usage, idx, modelId } of missing) {
      const seconds = fields(meta.get(1)).get(1);
      turns.set(idx, tokenRecord(localDateOf(new Date(seconds * 1000)), names.get(modelId) ?? `agy-model-${modelId}`,
        usage.get(2), usage.get(3), usage.get(5)));
    }
  } finally {
    db.close();
  }
}
