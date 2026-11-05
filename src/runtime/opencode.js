import { sumRuntimes } from './timeline.js';

// opencode 실행시간 추출기. 토큰 파서가 연 opencode.db 연결로 assistant 메시지의 생성·완료 시각을 읽는다.
//  - 실행 단위는 세션(자식 세션 포함). 턴은 같은 parentID의 assistant 묶음이고 첫 assistant 생성 시각에 시작한다.
//  - step-start 파트가 없는 메시지(사용자 셸 명령)와 time.completed가 없는 메시지는 뺀다.
//  - 포크 복사본은 (role, 생성·완료 시각, modelID)가 같아 가장 먼저 만들어진 세션 것만 쓴다.

const SOURCE = 'opencode';
const REQUIRED_TABLES = ['session', 'message', 'part'];

const MESSAGE_QUERY = `
SELECT
  m.session_id AS sessionId,
  s.time_created AS sessionCreated,
  json_extract(m.data, '$.parentID') AS parentId,
  json_extract(m.data, '$.modelID') AS model,
  json_extract(m.data, '$.time.created') AS created,
  json_extract(m.data, '$.time.completed') AS completed
FROM message m
LEFT JOIN session s ON s.id = m.session_id
WHERE json_extract(m.data, '$.role') = 'assistant'
  AND json_extract(m.data, '$.time.completed') IS NOT NULL
  AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = m.id AND json_extract(p.data, '$.type') = 'step-start')
`;

function tablesOf(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  return new Set(rows.map((row) => row.name));
}

function isEarlierSession(a, b) {
  const ta = a.sessionCreated ?? Infinity;
  const tb = b.sessionCreated ?? Infinity;
  return ta < tb || (ta === tb && String(a.sessionId) < String(b.sessionId));
}

// 복사본을 걸러 세션별 실행 단위로 묶는다. 턴마다 메시지 생성(시작)·완료(응답) 이벤트를 만든다.
function unitsOf(rows) {
  const owners = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row.created) || !Number.isFinite(row.completed)) continue;
    const key = `assistant\u0000${row.created}\u0000${row.completed}\u0000${row.model}`;
    const owner = owners.get(key);
    if (!owner || isEarlierSession(row, owner)) owners.set(key, row);
  }

  const sessions = new Map(); // 세션 → (parentID → 메시지 목록)
  for (const row of owners.values()) {
    let turns = sessions.get(row.sessionId);
    if (!turns) sessions.set(row.sessionId, (turns = new Map()));
    const turnKey = row.parentId ?? `\u0000${row.created}`; // parentID가 없으면 메시지 하나가 한 턴
    const messages = turns.get(turnKey);
    if (messages) messages.push(row);
    else turns.set(turnKey, [row]);
  }

  return Array.from(sessions.values(), (turns) => ({
    source: SOURCE,
    events: [...turns.values()].flatMap((messages) => messages
      .sort((a, b) => a.created - b.created)
      .flatMap((m, i) => [
        { t: m.created, start: i === 0, model: m.model },
        { t: m.completed, reply: true, model: m.model },
      ])),
  }));
}

/**
 * opencode 실행시간 수집기를 만든다. onDatabase를 parseOpencodeDatabase에 넘겨 같은 연결로 읽는다.
 * @returns {{ onDatabase: (db: object) => void,
 *   result: () => { source: 'opencode', rows: Array<{ date: string, source: string, model: string, runtimeMs: number }>, ok: boolean } }}
 */
export function createOpencodeRuntimeCollector() {
  let rows = null; // DB를 열지 못했으면 null로 남는다
  let ok = false;

  const onDatabase = (db) => {
    try {
      const tables = tablesOf(db);
      if (tables.size === 0) {
        rows = []; // 기록이 아직 없는 빈 DB
      } else if (REQUIRED_TABLES.some((name) => !tables.has(name))) {
        throw new Error('opencode.db schema changed');
      } else {
        rows = sumRuntimes(unitsOf(db.prepare(MESSAGE_QUERY).all()));
      }
      ok = true;
    } catch {
      rows = [];
      ok = false;
    }
  };

  const result = () => ({ source: SOURCE, rows: rows ?? [], ok: rows !== null && ok });

  return { onDatabase, result };
}
