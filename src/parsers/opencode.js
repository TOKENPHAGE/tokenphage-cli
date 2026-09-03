import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import Database from 'better-sqlite3';
import { localDateOf } from '../lib/dates.js';

// opencode(sst) 세션 저장 파서.
// 최신 opencode는 사용량을 data home 아래 opencode.db(SQLite)에 저장하고,
// 구버전은 storage/message·part JSON 파일에 저장한다. 두 형태를 모두 지원한다.
//
// DB는 외부 App(`opencode` CLI)을 거치지 않고 read-only로 직접 조회한다.
// OpenCode의 설치 여부·버전·오작동이 tokenphage sync에 영향을 주지 않아야 하기 때문이다.
//
// opencode는 턴당 assistant 메시지 1개에 스텝마다 tokens를 덮어써(=) 마지막 스텝만 남기므로,
// 스텝별 토큰이 보존된 step-finish part를 전부 합산해야 정확하다.
// 전략:
//  - message(role==='assistant')에서 id→{model, date}를 모으고, step-finish part를 messageID로 조인한다.
//  - 입력 파일 목록에 message/part가 섞여 오고 순서 보장이 없으므로, 두 맵을 모은 뒤 마지막에 조인한다.
//  - 필드 매핑(claude/codex와 정합): opencode getUsage가 input은 캐시 제외로, output은 reasoning 제외로
//    저장하므로 → inputTok은 그대로, outputTok은 output+reasoning으로 reasoning을 되살린다.
//    cache.write는 cacheCreate로 둔다(opencode는 Anthropic cacheCreation을 여기 담는다).
//  - 손상 파일·부모 없는 part·모델/날짜 없는 메시지는 집계에서 제외한다.

// DB 스키마도 JSON 파일과 같은 구조(message.data / part.data)를 담고 있어 동일 규칙으로 집계한다.
const USAGE_QUERY = `
SELECT
  strftime('%Y-%m-%d', m.time_created / 1000, 'unixepoch', 'localtime') AS date,
  json_extract(m.data, '$.modelID') AS model,
  SUM(MAX(COALESCE(json_extract(p.data, '$.tokens.input'), 0), 0)) AS input,
  SUM(MAX(COALESCE(json_extract(p.data, '$.tokens.output'), 0), 0)) AS output,
  SUM(MAX(COALESCE(json_extract(p.data, '$.tokens.reasoning'), 0), 0)) AS reasoning,
  SUM(MAX(COALESCE(json_extract(p.data, '$.tokens.cache.read'), 0), 0)) AS cache_read,
  SUM(MAX(COALESCE(json_extract(p.data, '$.tokens.cache.write'), 0), 0)) AS cache_write
FROM message m
JOIN part p ON p.message_id = m.id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(p.data, '$.type') = 'step-finish'
  AND json_type(p.data, '$.tokens') = 'object'
  AND json_extract(m.data, '$.modelID') IS NOT NULL
GROUP BY date, model
`;

// step-finish part의 tokens를 tokenphage 레코드 4필드로 매핑한다. 음수 방어로 max(…,0).
function entryOf(date, model, tokens) {
  const cache = tokens.cache ?? {};
  return {
    date,
    model,
    inputTok: Math.max(tokens.input ?? 0, 0),
    // opencode는 output에서 reasoning을 미리 뺐으므로 되살려 청구 기준(claude/codex)과 맞춘다.
    outputTok: Math.max(tokens.output ?? 0, 0) + Math.max(tokens.reasoning ?? 0, 0),
    cacheReadTok: Math.max(cache.read ?? 0, 0),
    cacheCreateTok: Math.max(cache.write ?? 0, 0),
  };
}

// USAGE_QUERY가 내보내는 7개 별칭(date·model·input·output·reasoning·cache_read·cache_write)만 읽는다.
// date는 strftime 결과라 'YYYY-MM-DD' 아니면 NULL이다(m.time_created가 NULL인 경우).
// 날짜나 모델을 못 만든 행은 어느 날짜·모델에 귀속시킬지 알 수 없으므로 집계에서 뺀다.
function entryOfRow(row) {
  if (!row || typeof row.model !== 'string' || !row.model) return null;
  if (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  return entryOf(row.date, row.model, {
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cache: { read: row.cache_read, write: row.cache_write },
  });
}

// OpenCode를 지운 뒤 남은 빈 DB와, 스키마가 바뀐 DB를 구분하기 위한 조회.
function tableCount(db, filter = '') {
  return db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'${filter}`).get().n;
}
function hasUsageTables(db) {
  return tableCount(db, " AND name IN ('message', 'part')") === 2;
}
function hasAnyTable(db) {
  return tableCount(db, " AND name NOT LIKE 'sqlite_%'") > 0;
}

// opencode.db를 read-only로 직접 연다. OpenCode CLI/App은 호출하지 않는다.
// OpenCode가 쓰는 중이어도 WAL 기반이라 읽기는 막히지 않는다.
// DB 삭제·손상·권한·스키마 변경 등 어떤 실패도 claude/codex sync를 막지 않도록
// 예외를 올리지 않고 빈 목록으로 격리한다(경고만 남긴다).
function queryOpencodeRows(dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // 기록이 아직 없는 빈 DB는 정상 상태다. 반대로 다른 테이블은 있는데 message/part만
    // 없다면 OpenCode 스키마가 바뀐 것이므로 집계가 0으로 새지 않게 알린다.
    if (!hasUsageTables(db)) {
      if (hasAnyTable(db)) console.warn(`Skipping OpenCode usage: ${dbPath} has no message/part table (schema changed?)`);
      return [];
    }
    return db.prepare(USAGE_QUERY).all();
  } catch (err) {
    // 파일이 사라졌으면 집계할 기록이 없을 뿐이라 알릴 것이 없다.
    // 파일이 남아 있는데 실패했다면 손상·권한 문제로 사용량이 누락되는 중이다.
    if (existsSync(dbPath)) console.warn(`Skipping OpenCode usage: could not read ${dbPath} (${err.message})`);
    return [];
  } finally {
    try { db?.close(); } catch { /* close 실패는 이미 읽은 결과에 영향이 없다 */ }
  }
}

/** OpenCode SQLite 조회 결과를 tokenphage usage 목록으로 변환한다. */
export function parseOpencodeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const entries = [];
  for (const row of rows) {
    const entry = entryOfRow(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * opencode.db(SQLite)를 직접 조회해 tokenphage usage 목록으로 변환한다.
 * @param {string} dbPath opencode.db 절대 경로
 * @param {(dbPath: string) => Array<object>} [queryRows] 조회 구현(테스트 주입용)
 */
export async function parseOpencodeDatabase(dbPath, queryRows = queryOpencodeRows) {
  return parseOpencodeRows(await queryRows(dbPath));
}

/**
 * opencode message/part 파일들을 스텝(step-finish) 단위 usage 목록으로 파싱한다.
 * @param {string[]} files 메시지·파트 JSON 파일 경로 목록 (섞여 있어도 됨)
 * @returns {Promise<Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>>}
 */
export async function parseOpencodeFiles(files) {
  const messageMeta = new Map(); // messageID → { model, date }
  const stepParts = [];          // { messageID, tokens }

  for (const file of files) {
    let obj;
    try {
      obj = JSON.parse(await readFile(file, 'utf8'));
    } catch { continue; } // 읽기 실패·손상 JSON skip
    if (!obj) continue;

    if (obj.role === 'assistant') {
      // 모델·날짜를 못 만들면 이 메시지의 파트는 귀속 불가 → 맵에 넣지 않는다.
      if (!obj.id || !obj.modelID) continue;
      const date = localDateOf(obj.time?.created);
      if (!date) continue;
      messageMeta.set(obj.id, { model: obj.modelID, date });
    } else if (obj.type === 'step-finish') {
      if (!obj.messageID || !obj.tokens) continue;
      stepParts.push({ messageID: obj.messageID, tokens: obj.tokens });
    }
    // 그 외(user 메시지, 다른 part, session/project 파일)는 무시
  }

  const entries = [];
  for (const part of stepParts) {
    const meta = messageMeta.get(part.messageID);
    if (!meta) continue; // 부모 메시지 없음/모델·날짜 무효 → skip
    entries.push(entryOf(meta.date, meta.model, part.tokens));
  }
  return entries;
}
