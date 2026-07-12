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
  if (status >= 500) return 'Server temporarily unavailable. Your existing badge data is safe.';
  return `Server error: ${status}`; // 매핑되지 않은 상태 폴백
}

/**
 * 집계된 토큰 사용 기록을 서버에 업로드한다 (POST /api/sync).
 * 사용자는 서버가 JWT(Bearer)에서 식별하고, 본문에 deviceId와 records를 담아 보낸다.
 * @param {string} apiBase  API 서버 base URL
 * @param {string} token    Bearer JWT
 * @param {string} deviceId 기기 식별 UUID
 * @param {Array<{date:string, model:string, inputTok:number, outputTok:number, cacheReadTok:number, cacheCreateTok:number}>} records 날짜·모델별 집계 레코드
 * @throws {Error} 2xx가 아니면 mapServerError 메시지로 throw
 */
export async function syncRecords(apiBase, token, deviceId, records) {
  // Node 18+ 전역 fetch 사용 (node-fetch 의존성 불필요).
  const res = await fetch(`${apiBase}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ deviceId, records }),
  });
  if (!res.ok) throw new Error(mapServerError(res.status, await res.text()));
}

/**
 * 서버에 전체 초기화를 요청한다. 대상은 서버가 JWT에서 식별하므로 본문은 비운다.
 * @param {string} apiBase
 * @param {string} token  Bearer JWT
 */
export async function resetData(apiBase, token) {
  const res = await fetch(`${apiBase}/api/reset`, {
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
