import Database from 'better-sqlite3';
import { localDateOf } from '../lib/dates.js';

// Hermes Agent 세션 DB(~/.hermes/state.db) 파서.
// sessions의 토큰 수치는 세션 단위 누적값이므로, 종료된 세션만 1회 집계한다.
// Hermes timestamp는 Unix seconds(REAL)이므로 Date에 넘기기 전에 milliseconds로 변환한다.

function nonNegative(value) {
  return Math.max(Number(value) || 0, 0);
}

function dateOfUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return localDateOf(new Date(seconds * 1000));
}

function entryOf(row) {
  if (typeof row.model !== 'string' || !row.model.trim()) return null;
  const date = dateOfUnixSeconds(row.ended_at);
  if (!date) return null;

  return {
    date,
    model: row.model,
    inputTok: nonNegative(row.input_tokens),
    // Hermes reasoning_tokens가 output_tokens에 포함되는지는 저장 계층의 계약 확인 전까지
    // 별도 합산하지 않는다. 중복 집계를 피하기 위해 output_tokens 원문만 사용한다.
    outputTok: nonNegative(row.output_tokens),
    cacheReadTok: nonNegative(row.cache_read_tokens),
    cacheCreateTok: nonNegative(row.cache_write_tokens),
  };
}

/**
 * Hermes state.db의 종료된 세션을 TokenPhage 공통 usage 레코드로 변환한다.
 * DB가 없거나 읽을 수 없으면 다른 source sync를 막지 않고 빈 목록을 반환한다.
 * @param {string} dbPath Hermes SQLite state.db 절대 경로
 * @returns {Promise<Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>>}
 */
export async function parseHermesSessions(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(`
      SELECT model, ended_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
      FROM sessions
      WHERE ended_at IS NOT NULL
    `).all();
    return rows.map(entryOf).filter(Boolean);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* close 실패는 sync를 막지 않는다 */ }
  }
}
