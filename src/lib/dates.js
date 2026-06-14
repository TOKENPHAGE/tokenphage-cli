// 날짜 버킷팅 공용 헬퍼.
// 트랜스크립트 타임스탬프(UTC)를 "사용자 체감 날짜"인 로컬 타임존 기준
// lastSyncDate(로컬 기준)와 레코드 날짜의 기준을 일치시킨다.

const formatterCache = new Map();

/**
 * 타임스탬프를 로컬(또는 지정 타임존) 날짜 문자열로 변환한다.
 * @param {string|Date} ts ISO8601 문자열 또는 Date
 * @param {string} [timeZone] IANA 타임존 (예: 'Asia/Seoul') — 미지정 시 시스템 로컬
 * @returns {string|null} YYYY-MM-DD, 파싱 불가면 null
 */
export function localDateOf(ts, timeZone = undefined) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;

  if (timeZone) {
    let fmt = formatterCache.get(timeZone);
    if (!fmt) {
      // en-CA 로케일은 YYYY-MM-DD 형식을 보장한다.
      fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      formatterCache.set(timeZone, fmt);
    }
    return fmt.format(d);
  }

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
