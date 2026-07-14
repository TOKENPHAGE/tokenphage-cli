/**
 * config.json 스키마 검증·정규화·마이그레이션. 순수 함수(fs·네트워크 없음).
 * 이상 필드는 제거하고 유효·미지 필드는 보존한다. 형태/타입만 검증하며 JWT 서명은 검증하지 않는다.
 */

// config.json 스키마 버전. breaking 변경 시 +1 하고 migrateConfig에 단계를 추가한다.
export const CURRENT_CONFIG_VERSION = 1;

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const JWT_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** JWT 형태(base64url 3세그먼트)인지 검사한다. 서명은 검증하지 않는다. */
export function isJwtShape(v) {
  if (typeof v !== 'string') return false;
  const parts = v.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0 && JWT_SEGMENT_RE.test(p));
}

/** UUID 형식(서버 SyncRequest 패턴과 동일)인지 검사한다. */
export function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * YYYY-MM-DD이고 실제 존재하는 날짜이며 today 이전인지 검사한다.
 * @param {string} today 미래 금지 기준 날짜(YYYY-MM-DD)
 */
export function isYmdDate(v, today) {
  if (typeof v !== 'string' || !YMD_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  // 롤오버(예: 2/30 → 3/2) 차단: 컴포넌트 재구성 후 일치하는 날짜만 통과.
  const dt = new Date(Date.UTC(y, m - 1, d));
  const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  if (!real) return false;
  // 미래 금지(동일 포맷이라 문자열 비교로 충분). today 미제공 시 생략.
  if (typeof today === 'string' && YMD_RE.test(today) && v > today) return false;
  return true;
}

/** Date.parse로 해석 가능한 ISO 시각 문자열인지 검사한다. */
export function isIsoDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** 문자열만 담긴 배열인지 검사한다. */
export function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * config를 현재 스키마 버전으로 마이그레이트한다. 순수·멱등.
 * @param {object} raw 파싱된 config
 * @returns {object} 마이그레이트된 새 객체
 */
export function migrateConfig(raw) {
  const version = Number.isInteger(raw.configVersion) ? raw.configVersion : 0;
  if (version > CURRENT_CONFIG_VERSION) return { ...raw }; // 미래 버전은 보존
  let out = { ...raw };
  if (version < 1) out = { ...out, configVersion: 1 }; // 0 → 1: 버전 스탬프만
  return out;
}

/**
 * 파싱된 config를 검증·정규화한다. 이상 필드는 제거하고 유효·미지 필드는 보존한다.
 * @param {*} raw JSON.parse 결과
 * @param {string} today lastSyncDate 미래 검사 기준(YYYY-MM-DD)
 * @returns {object} 정규화된 config
 */
export function normalizeConfig(raw, today) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { configVersion: CURRENT_CONFIG_VERSION };
  }
  const migrated = migrateConfig(raw);
  // 미래 버전은 검증 없이 그대로 반환한다.
  if (Number.isInteger(migrated.configVersion) && migrated.configVersion > CURRENT_CONFIG_VERSION) {
    return migrated;
  }

  const out = { ...migrated }; // 미지 필드 보존
  const dropIf = (key, ok) => { if (key in out && !ok(out[key])) delete out[key]; };

  dropIf('token', isJwtShape);
  dropIf('deviceId', isUuid);                         // 없으면 getOrCreateDeviceId가 재발급
  dropIf('lastSyncDate', (v) => isYmdDate(v, today)); // 없으면 전체 재파싱
  dropIf('hookInstalledAt', isIsoDate);
  dropIf('hookInstalled', (v) => typeof v === 'boolean');
  dropIf('claudePaths', isStringArray);
  dropIf('hookMeta', (v) => v != null && typeof v === 'object' && !Array.isArray(v));

  out.configVersion = CURRENT_CONFIG_VERSION;
  return out;
}
