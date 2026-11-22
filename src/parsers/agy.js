import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readDatabase } from './agy/database.js';
import { readTranscript } from './agy/transcript.js';

async function children(dir, optional) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (optional && err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function parseAgy(home, explicit = false) {
  const dirs = await children(home, !explicit);
  const sessions = new Map();
  if (dirs.some(d => d.name === 'brain')) {
    for (const d of await children(join(home, 'brain'))) {
      if (d.isDirectory()) sessions.set(d.name, { log: join(home, 'brain', d.name, '.system_generated', 'logs', 'transcript.jsonl') });
    }
  }
  if (dirs.some(d => d.name === 'conversations')) {
    for (const d of await children(join(home, 'conversations'))) {
      if (!d.isFile() || !d.name.endsWith('.db')) continue;
      const id = d.name.slice(0, -3);
      sessions.set(id, { ...sessions.get(id), db: join(home, 'conversations', d.name) });
    }
  }
  const entries = [];
  for (const session of sessions.values()) {
    const turns = new Map();
    if (session.log) await readTranscript(session.log, turns);
    if (session.db) await readDatabase(session.db, turns);
    for (const row of turns.values()) entries.push(row);
  }
  return entries;
}
