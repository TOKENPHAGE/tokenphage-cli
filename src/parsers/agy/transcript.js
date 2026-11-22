import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { localDateOf } from '../../lib/dates.js';
import { tokenRecord } from './record.js';

export async function readTranscript(file, turns) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_input_tokens'].some(k => k in r)) continue;
      if (!Number.isSafeInteger(r.step_index)) throw new Error('Invalid AGY step index');
      turns.set(r.step_index, tokenRecord(localDateOf(r.created_at), r.model, r.input_tokens,
        r.output_tokens, r.cache_read_tokens, r.cache_creation_input_tokens));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    lines.close();
  }
}
