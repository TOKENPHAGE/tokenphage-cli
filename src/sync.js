/**
 * 집계된 토큰 사용 기록을 서버에 업로드한다 (POST /api/sync).
 * 사용자는 서버가 JWT(Bearer)에서 식별하고, 본문에 deviceId와 records를 담아 보낸다.
 * @param {string} apiBase  API 서버 base URL
 * @param {string} token    Bearer JWT
 * @param {string} deviceId 기기 식별 UUID
 * @param {Array<{date:string, model:string, inputTok:number, outputTok:number, cacheReadTok:number, cacheCreateTok:number}>} records 날짜·모델별 집계 레코드
 * @throws {Error} 응답이 2xx가 아니면 status와 응답 본문을 담아 throw
 */
export async function syncRecords(apiBase, token, deviceId, records) {
  // Node 18+ 전역 fetch 사용 (node-fetch 의존성 불필요).
  const res = await fetch(`${apiBase}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ deviceId, records }),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status} ${await res.text()}`);
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
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch {  }
    throw new Error(res.status === 429 ? msg : `Server error: ${res.status} ${msg}`);
  }
}
