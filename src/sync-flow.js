/**
 * sync 흐름: 기준 날짜·버전 판단 → 파싱 → 전송 → 설정 저장.
 * index.js는 불러오는 순간 CLI가 시동되어 테스트할 수 없으므로 흐름을 이 모듈로 분리했다.
 */
import { loadConfig, saveConfig } from './auth.js';
import { syncRecords, printWarning, CLI_VERSION } from './sync.js';
import { localDateOf } from './lib/dates.js';

/**
 * 로컬 로그를 파싱해 토큰·실행시간을 서버로 보내고, 모든 묶음이 끝난 뒤 설정을 한 번 저장한다.
 * 토큰은 lastSyncDate부터, 실행시간은 lastSyncVersion이 지금 버전과 같을 때만 lastSyncDate부터(다르면 전체) 보낸다.
 * parseLogs는 호출부가 넘기고 나머지 의존성은 실제 구현이 기본값이다.
 * @param {{apiBase: string, token: string, deviceId: string, parseLogs: Function,
 *          readConfig?: Function, writeConfig?: Function, fetchImpl?: Function, version?: string,
 *          today?: string, log?: Function, interactive?: boolean}} deps
 * @throws {Error} 파싱 실패나 첫 요청 실패 시(설정은 바꾸지 않는다)
 */
export async function runSyncFlow({
  apiBase,
  token,
  deviceId,
  parseLogs,
  readConfig = loadConfig,
  writeConfig = saveConfig,
  fetchImpl = globalThis.fetch,
  version = CLI_VERSION,
  today = localDateOf(new Date()), // 시작 시 1회 계산: 자정을 넘겨도 시작일을 저장한다
  log = console.log,
  interactive = Boolean(process.stdin.isTTY),
}) {
  const warn = (msg) => printWarning(msg, { interactive, log });
  const { lastSyncDate = null, lastSyncVersion } = readConfig();
  const tokenFrom = lastSyncDate;
  const runtimeFrom = lastSyncVersion === version ? tokenFrom : null; // 버전이 다르면 실행시간은 전체 기간

  log(`Parsing local logs... (${tokenFrom ?? 'beginning'} ~ ${today})`);
  const { records, runtimes, allSourcesRead, failedSources = [] } = await parseLogs({ tokenFrom, runtimeFrom });
  log(`${records.length} records aggregated (date×model)`);
  log(`${runtimes.length} runtime records aggregated (date×source×model)`);
  if (!allSourcesRead) warn(`Could not read ${failedSources.join(', ') || 'some'} logs. They were skipped in this sync.`);

  const hasData = records.length > 0 || runtimes.length > 0;
  let runtimesOk = true;
  if (hasData) {
    log('Uploading to server...');
    const result = await syncRecords(apiBase, token, deviceId, records, runtimes, { fetchImpl, onNotice: warn });
    if (result.rejected > 0) warn(`${result.rejected} runtime record(s) were rejected by the server.`);
    if (result.failure) warn(`Runtime upload incomplete, it will be resent on the next sync: ${result.failure}`);
    else if (!result.runtimesOk) warn('The server did not confirm runtime records. They will be resent on the next sync.'); // API 롤백으로 실행시간을 모르는 옛 서버를 만난 경우
    runtimesOk = result.runtimesOk;
  } else {
    log('Nothing to sync.');
  }

  // 모든 묶음 뒤 1회 저장. 전송이 성공하면 버전을 남긴다(못 읽은 도구로 지우면 매일 전체 재전송)
  const { lastSyncVersion: _previous, ...rest } = readConfig();
  writeConfig(runtimesOk
    ? { ...rest, lastSyncDate: today, lastSyncVersion: version }
    : { ...rest, lastSyncDate: today });
  if (hasData) log('Done! Badge will update shortly.');
}
