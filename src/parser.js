import { glob } from 'glob';
import { homedir } from 'os';
import { parseClaudeFiles } from './parsers/claude.js';
import { parseCodexFiles } from './parsers/codex.js';
import { parseOpencodeDatabase, parseOpencodeFiles } from './parsers/opencode.js';
import { resolveClaudeDirs, resolveOpencodeDirs } from './lib/paths.js';
import { getCustomClaudePaths } from './auth.js';

/**
 * 소스별 파서가 돌려준 항목들을 "날짜|모델" 단위 레코드로 합산한다.
 * @param {Array<{date: string, model: string, inputTok: number, outputTok: number, cacheReadTok: number, cacheCreateTok: number}>} entries
 * @param {string|null} fromDate YYYY-MM-DD — 이 날짜(포함) 이후만 집계
 */
export function aggregateRecords(entries, fromDate = null) {
  const agg = new Map();
  for (const entry of entries) {
    if (fromDate && entry.date < fromDate) continue;
    const key = `${entry.date}|${entry.model}`;
    const cur = agg.get(key) ?? { date: entry.date, model: entry.model, inputTok: 0, outputTok: 0, cacheReadTok: 0, cacheCreateTok: 0 };
    agg.set(key, {
      ...cur,
      inputTok: cur.inputTok + entry.inputTok,
      outputTok: cur.outputTok + entry.outputTok,
      cacheReadTok: cur.cacheReadTok + entry.cacheReadTok,
      cacheCreateTok: cur.cacheCreateTok + entry.cacheCreateTok,
    });
  }
  return Array.from(agg.values());
}

async function globSorted(pattern) {
  const files = await glob(pattern, { nodir: true });
  return files.sort(); // 파일 간 dedup(first-wins)의 기준 순서를 고정한다
}

/** Claude 설정 디렉터리 후보(기본 → XDG → config.json 지정)를 우선순위 순으로 반환한다. */
export function claudeDirCandidates() {
  return resolveClaudeDirs({
    home: homedir(),
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    customPaths: getCustomClaudePaths(),
  });
}

/** opencode 데이터 디렉터리 후보(XDG data home 기준)를 우선순위 순으로 반환한다. */
export function opencodeDirCandidates() {
  return resolveOpencodeDirs({
    home: homedir(),
    xdgDataHome: process.env.XDG_DATA_HOME,
  });
}

export async function parseAll(fromDate = null) {
  // 경로가 겹쳐도 파일 간 first-wins dedup이 흡수하므로 순서만 보장하면 된다.
  const claudeFiles = [];
  for (const dir of claudeDirCandidates()) {
    claudeFiles.push(...await globSorted(`${dir.replaceAll('\\', '/')}/projects/**/*.jsonl`));
  }

  // sessions를 archived_sessions보다 먼저 — 같은 세션의 사본은 원본이 이긴다.
  const codexHome = process.env.CODEX_HOME || `${homedir()}/.codex`;
  const codexFiles = [
    ...(await globSorted(`${codexHome}/sessions/**/*.jsonl`)),
    ...(await globSorted(`${codexHome}/archived_sessions/**/*.jsonl`)),
  ];

  // 최신 opencode는 data home 바로 아래 opencode.db에 저장한다.
  // DB가 없는 구버전만 storage/message·part JSON을 읽는다.
  const opencodeDatabases = [];
  const opencodeFiles = [];
  for (const dir of opencodeDirCandidates()) {
    const base = dir.replaceAll('\\', '/');
    opencodeDatabases.push(...await globSorted(`${base}/opencode.db`));
    if (opencodeDatabases.length === 0) {
      opencodeFiles.push(...await globSorted(`${base}/storage/message/**/*.json`));
      opencodeFiles.push(...await globSorted(`${base}/storage/part/**/*.json`));
    }
  }

  const opencodePromise = opencodeDatabases.length > 0
    ? parseOpencodeDatabase()
    : parseOpencodeFiles(opencodeFiles);

  const [claudeEntries, codexEntries, opencodeEntries] = await Promise.all([
    parseClaudeFiles(claudeFiles),
    parseCodexFiles(codexFiles),
    opencodePromise,
  ]);
  return aggregateRecords([...claudeEntries, ...codexEntries, ...opencodeEntries], fromDate);
}
