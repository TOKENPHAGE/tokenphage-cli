import chalk from 'chalk';
import { createRequire } from 'node:module';

// package.json의 version: 이름표와 lastSyncVersion에 쓴다
export const CLI_VERSION = createRequire(import.meta.url)('../package.json').version;

// 모든 API 요청에 붙이는 이름표
const USER_AGENT = `tokenphage-cli/${CLI_VERSION} (${process.platform}; ${process.arch}) node/${process.versions.node}`;

// 서버가 한 요청에 받는 실행시간 최대 개수(SyncRequest.MAX_RECORDS)
const MAX_RUNTIMES_PER_REQUEST = 10_000;

const UPDATE_HINT = 'Update: npm i -g tokenphage@latest';

/**
 * 서버 HTTP 상태코드를 사용자 대면 메시지로 매핑한다(응답 원문은 노출하지 않음).
 * @param {number} status HTTP 상태코드
 * @param {string} [bodyText] 400 세부 분기 판단용 응답 본문
 * @returns {string} 사용자 메시지
 */
export function mapServerError(status, bodyText) {
  if (status === 401) return 'Authentication expired or invalid. Run `tokenphage login` to sign in again.';
  if (status === 400) {
    const lower = (bodyText || '').toLowerCase();
    if (lower.includes('deviceid')) return 'Your config file looks corrupted. Run `tokenphage login` to re-authenticate.';
    return 'Request format error. Update the CLI: npm i -g tokenphage@latest';
  }
  if (status === 410 || status === 426) return `This CLI version is no longer supported. ${UPDATE_HINT}`; // 지원 종료
  if (status >= 500) return 'Server temporarily unavailable. Your existing badge data is safe.';
  return `Server error: ${status}`; // 매핑되지 않은 상태 폴백
}

/** 경고 1줄을 남긴다. 대화형은 노란색, 헤드리스는 평문(스케줄러 래퍼가 stdout을 sync.log로 보낸다). */
export function printWarning(msg, { interactive = Boolean(process.stdin.isTTY), log = console.log } = {}) {
  const line = `! ${msg}`;
  log(interactive ? chalk.yellow(line) : line);
}

/** Link 헤더에서 rel="deprecation" 주소를 찾는다. 없으면 null. */
function deprecationLink(link) {
  for (const part of (link ?? '').split(/,(?=\s*<)/)) {
    const [, url, params = ''] = part.match(/<([^>]*)>(.*)/) ?? [];
    const rel = params.match(/;\s*rel\s*=\s*"?([^";]*)/i)?.[1] ?? '';
    if (url && rel.toLowerCase().split(/\s+/).includes('deprecation')) return url;
  }
  return null;
}

/** 응답의 Deprecation·Sunset·Link(rel="deprecation") 헤더로 지원 종료 안내 1줄을 만든다. 없으면 null. */
function deprecationNotice(headers) {
  if (typeof headers?.get !== 'function') return null; // 헤더가 없는 응답도 통과
  const deprecation = headers.get('deprecation');
  const sunset = headers.get('sunset');
  const link = deprecationLink(headers.get('link'));
  if (!deprecation && !sunset && !link) return null;
  const until = sunset ? ` and stops working after ${sunset}` : '';
  const details = link ? ` (details: ${link})` : '';
  return `This CLI version is deprecated${until}. ${UPDATE_HINT}${details}`;
}

/**
 * API 공통 요청: 이름표(User-Agent)를 붙이고, 응답에 지원 종료 헤더가 있으면 onNotice로 안내한다.
 * @param {string} url
 * @param {object} init fetch 옵션
 * @param {{fetchImpl?: Function, onNotice?: (msg: string) => void}} [deps]
 * @returns {Promise<Response>}
 */
export async function apiFetch(url, init, { fetchImpl = globalThis.fetch, onNotice = printWarning } = {}) {
  const res = await fetchImpl(url, { ...init, headers: { ...init.headers, 'User-Agent': USER_AGENT } });
  const notice = deprecationNotice(res.headers);
  if (notice) onNotice(notice);
  return res;
}

/** 2xx 응답 본문의 실행시간 결과({accepted, rejected})를 읽는다. 없거나 형식이 다르면 null. */
async function runtimeResult(res) {
  try {
    const result = JSON.parse(await res.text())?.runtimes;
    return Number.isInteger(result?.accepted) && Number.isInteger(result?.rejected) ? result : null;
  } catch {
    return null; // 빈 본문(API 롤백으로 만난 옛 API)·비JSON
  }
}

/**
 * 토큰 레코드와 실행시간을 서버에 업로드한다 (POST /api/sync).
 * 토큰은 첫 요청에 모두 싣고, 실행시간은 10,000개씩 나눠 남은 묶음을 records: []와 함께 보낸다.
 * 실행시간이 없으면 runtimes 칸을 빼 지금과 같은 {deviceId, records}를 보낸다.
 * @param {string} apiBase  API 서버 base URL
 * @param {string} token    Bearer JWT
 * @param {string} deviceId 기기 식별 UUID
 * @param {Array<{date:string, model:string, inputTok:number, outputTok:number, cacheReadTok:number, cacheCreateTok:number}>} records 날짜·모델별 집계 레코드
 * @param {Array<{date:string, source:string, model:string, runtimeMs:number}>} [runtimes] 날짜·도구·모델별 실행시간
 * @param {{fetchImpl?: Function, onNotice?: (msg: string) => void}} [deps]
 * @returns {Promise<{runtimesOk: boolean, rejected: number, failure: string|null}>}
 *   runtimesOk는 실행시간을 모두 보냈고 응답마다 결과가 있을 때 true, failure는 후속 요청 실패 사유
 * @throws {Error} 첫 요청이 2xx가 아니면 mapServerError 메시지로 throw
 */
export async function syncRecords(apiBase, token, deviceId, records, runtimes = [], { fetchImpl, onNotice = printWarning } = {}) {
  let noticed = false; // 묶음이 여러 개여도 지원 종료 안내는 1줄
  const post = (body) => apiFetch(`${apiBase}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body),
  }, { fetchImpl, onNotice: (msg) => { if (!noticed) onNotice(msg); noticed = true; } });

  // 첫 요청: 토큰 전부와 첫 실행시간 묶음. 실패하면 지금처럼 throw
  const first = runtimes.slice(0, MAX_RUNTIMES_PER_REQUEST);
  const res = await post(first.length ? { deviceId, records, runtimes: first } : { deviceId, records });
  if (!res.ok) throw new Error(mapServerError(res.status, await res.text()));
  if (!first.length) return { runtimesOk: true, rejected: 0, failure: null };

  let result = await runtimeResult(res);
  let rejected = result?.rejected ?? 0;
  // 후속 요청: 남은 실행시간만. 결과가 없거나 실패하면 멈추고 미완료로 돌려준다
  for (let i = MAX_RUNTIMES_PER_REQUEST; result && i < runtimes.length; i += MAX_RUNTIMES_PER_REQUEST) {
    try {
      const next = await post({ deviceId, records: [], runtimes: runtimes.slice(i, i + MAX_RUNTIMES_PER_REQUEST) });
      if (!next.ok) return { runtimesOk: false, rejected, failure: mapServerError(next.status, await next.text()) };
      result = await runtimeResult(next);
    } catch (err) {
      return { runtimesOk: false, rejected, failure: err.message };
    }
    rejected += result?.rejected ?? 0;
  }
  return { runtimesOk: result !== null, rejected, failure: null };
}

/**
 * 서버에 전체 초기화를 요청한다. 대상은 서버가 JWT에서 식별하므로 본문은 비운다.
 * @param {string} apiBase
 * @param {string} token  Bearer JWT
 */
export async function resetData(apiBase, token) {
  const res = await apiFetch(`${apiBase}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      // 429: 서버 쿨다운 메시지를 그대로 노출
      let msg = text;
      try { msg = JSON.parse(text).message ?? text; } catch { /* 비JSON은 원문 */ }
      throw new Error(msg);
    }
    throw new Error(mapServerError(res.status, text));
  }
}
