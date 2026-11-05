import { parseClaudeFiles } from '../parsers/claude.js';
import { parseCodexFiles } from '../parsers/codex.js';
import { parseOpencodeDatabase, parseOpencodeFiles } from '../parsers/opencode.js';
import { createClaudeRuntimeCollector } from './claude.js';
import { createCodexRuntimeCollector } from './codex.js';
import { createOpencodeRuntimeCollector } from './opencode.js';

/**
 * 소스별 실행시간 줄을 이어 붙이고 읽기 성공 여부와 읽지 못한 소스를 모은다. 줄마다 source가 달라 합칠 줄은 없다.
 * @param {Array<{ source: string, rows: Array<{ date: string, source: string, model: string, runtimeMs: number }>, ok: boolean }>} results 로그가 있는 소스의 결과
 * @param {string|null} fromDate YYYY-MM-DD(포함). null이면 전체 기간
 */
function mergeRuntimeResults(results, fromDate = null) {
  const runtimes = results.flatMap((result) => result.rows).filter((row) => !fromDate || row.date >= fromDate);
  const failedSources = results.filter((result) => !result.ok).map((result) => result.source);
  return { runtimes, allSourcesRead: failedSources.length === 0, failedSources };
}

/**
 * 찾은 로그를 소스마다 한 번씩 읽어 토큰 항목과 실행시간을 함께 모은다.
 * Claude·Codex 파일을 열 수 없으면 예외를 올린다.
 * @param {{ claudeFiles: string[], codexFiles: string[], opencodeDatabase: string|null, opencodeFiles: string[] }} paths
 * @param {string|null} [runtimeFrom] 실행시간 시작 날짜 YYYY-MM-DD(포함). null이면 전체 기간
 * @returns {Promise<{ entries: Array<object>, runtimes: Array<{ date: string, source: string, model: string, runtimeMs: number }>, allSourcesRead: boolean }>}
 */
export async function readLogs(paths, runtimeFrom = null) {
  const claude = createClaudeRuntimeCollector();
  const codex = createCodexRuntimeCollector();
  const opencode = createOpencodeRuntimeCollector();

  const [claudeEntries, codexEntries, opencodeEntries] = await Promise.all([
    parseClaudeFiles(paths.claudeFiles, claude.onRecord),
    parseCodexFiles(paths.codexFiles, codex.onRecord),
    paths.opencodeDatabase
      ? parseOpencodeDatabase(paths.opencodeDatabase, undefined, opencode.onDatabase)
      : parseOpencodeFiles(paths.opencodeFiles),
  ]);

  // 로그가 없는 소스(미설치)는 성공 조건에서 뺀다. opencode 옛 JSON 저장소는 실행시간 범위 밖이다.
  const results = [];
  if (paths.claudeFiles.length > 0) results.push(claude.result());
  if (paths.codexFiles.length > 0) results.push(codex.result());
  if (paths.opencodeDatabase) results.push(opencode.result());

  return { entries: [...claudeEntries, ...codexEntries, ...opencodeEntries], ...mergeRuntimeResults(results, runtimeFrom) };
}
