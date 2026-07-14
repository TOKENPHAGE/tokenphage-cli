import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_CONFIG_VERSION,
  isJwtShape,
  isUuid,
  isYmdDate,
  isIsoDate,
  isStringArray,
  migrateConfig,
  normalizeConfig,
} from '../src/lib/config-schema.js';

// 테스트 목록 — 전부 순수 함수(fs·네트워크 무관). today는 고정 상수로 주입해 결정성 확보.
// [isJwtShape] JWT "형태"(3 base64url 세그먼트)
//  1. isJwtShape_3세그먼트_true                    (성공)
//  2. isJwtShape_2세그먼트_false                   (실패 입력)
//  3. isJwtShape_비문자열_false                    (실패 입력)
// [isUuid] UUID 형식
//  4. isUuid_정상UUID_true                         (성공)
//  5. isUuid_하이픈없음_false                      (실패 입력)
//  6. isUuid_숫자입력_false                        (실패 입력)
// [isYmdDate] YYYY-MM-DD + 실제달력 + 미래금지
//  7. isYmdDate_오늘날짜_true                      (경계: today 포함)
//  8. isYmdDate_과거날짜_true                      (성공)
//  9. isYmdDate_미래날짜_false                     (경계)
// 10. isYmdDate_존재불가2월30일_false              (경계: 롤오버 차단)
// 11. isYmdDate_존재불가13월_false                 (경계)
// 12. isYmdDate_비문자열_false                     (실패 입력)
// [isIsoDate] Date.parse 가능
// 13. isIsoDate_정상ISO_true                       (성공)
// 14. isIsoDate_깨진값_false                       (실패 입력)
// [isStringArray] 문자열 배열
// 15. isStringArray_문자열배열_true                (성공)
// 16. isStringArray_혼합배열_false                 (실패 입력)
// 17. isStringArray_문자열_false                   (실패 입력)
// [migrateConfig] 버전 마이그레이션 (순수·멱등)
// 18. migrateConfig_버전없는legacy_v1로스탬프      (성공: 0→1)
// 19. migrateConfig_이미v1_멱등불변                (경계)
// 20. migrateConfig_미래버전_원본보존              (경계: 다운그레이드 파괴 금지)
// [normalizeConfig] 필드 검증·격리·passthrough
// 21. normalizeConfig_손상필드하나_해당필드만제거_토큰보존  (성공: 핵심 — 자기파괴 버그 방지)
// 22. normalizeConfig_미래lastSyncDate_제거        (경계: Bug4 자가치유)
// 23. normalizeConfig_알수없는필드_passthrough보존 (경계: 다운그레이드 안전)
// 24. normalizeConfig_비객체입력_기본configVersion (실패 입력)
// 25. normalizeConfig_미래버전_검증없이원본보존    (경계)
// 26. normalizeConfig_정상전체_모두보존및버전스탬프 (성공)
// 27. normalizeConfig_손상토큰_토큰만제거_나머지보존 (성공: 손상 토큰 제거·유효필드 보존)
// 28. normalizeConfig_각필드개별손상_해당필드만제거_유효필드보존 (성공: 필드별 드롭 배선 8종)
// 29. normalizeConfig_불리언false_hookInstalled보존 (경계: false를 없음으로 오취급 금지)

const TODAY = '2026-07-10';
const VALID_JWT = 'eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIxIn0.abc-DEF_123';
const VALID_UUID = '23189c5d-47db-4de3-b40b-1732c9af99a3';

// ── isJwtShape ──────────────────────────────────────────────
test('isJwtShape_3세그먼트_true', () => {
  // Given / When / Then: base64url 3세그먼트는 형태상 유효
  assert.equal(isJwtShape(VALID_JWT), true);
});
test('isJwtShape_2세그먼트_false', () => {
  // Given / When / Then: 세그먼트가 2개면 JWT 형태 아님
  assert.equal(isJwtShape('aaa.bbb'), false);
});
test('isJwtShape_비문자열_false', () => {
  // Given / When / Then: 문자열이 아니면 false
  assert.equal(isJwtShape(12345), false);
});

// ── isUuid ──────────────────────────────────────────────────
test('isUuid_정상UUID_true', () => {
  assert.equal(isUuid(VALID_UUID), true);
});
test('isUuid_하이픈없음_false', () => {
  assert.equal(isUuid('23189c5d47db4de3b40b1732c9af99a3'), false);
});
test('isUuid_숫자입력_false', () => {
  assert.equal(isUuid(42), false);
});

// ── isYmdDate ───────────────────────────────────────────────
test('isYmdDate_오늘날짜_true', () => {
  // Given / When / Then: today 포함(경계) 통과
  assert.equal(isYmdDate('2026-07-10', TODAY), true);
});
test('isYmdDate_과거날짜_true', () => {
  assert.equal(isYmdDate('2026-01-01', TODAY), true);
});
test('isYmdDate_미래날짜_false', () => {
  // Given: today 이후 날짜
  // When / Then: 미래 금지
  assert.equal(isYmdDate('9999-01-01', TODAY), false);
});
test('isYmdDate_존재불가2월30일_false', () => {
  // Given: 2월 30일(롤오버 대상)
  // When / Then: 컴포넌트 재구성 비교로 차단
  assert.equal(isYmdDate('2026-02-30', TODAY), false);
});
test('isYmdDate_존재불가13월_false', () => {
  assert.equal(isYmdDate('2026-13-01', TODAY), false);
});
test('isYmdDate_비문자열_false', () => {
  assert.equal(isYmdDate(20260710, TODAY), false);
});

// ── isIsoDate ───────────────────────────────────────────────
test('isIsoDate_정상ISO_true', () => {
  assert.equal(isIsoDate('2026-06-27T08:09:55.569Z'), true);
});
test('isIsoDate_깨진값_false', () => {
  assert.equal(isIsoDate('not-a-date'), false);
});

// ── isStringArray ───────────────────────────────────────────
test('isStringArray_문자열배열_true', () => {
  assert.equal(isStringArray(['~/a', '/b/c']), true);
});
test('isStringArray_혼합배열_false', () => {
  assert.equal(isStringArray(['~/a', 3]), false);
});
test('isStringArray_문자열_false', () => {
  // Given / When / Then: 배열이 아닌 문자열은 false
  assert.equal(isStringArray('~/a'), false);
});

// ── migrateConfig ───────────────────────────────────────────
test('migrateConfig_버전없는legacy_v1로스탬프', () => {
  // Given: 버전 필드 없는 기존 config
  const out = migrateConfig({ token: VALID_JWT });
  // Then: configVersion 1이 부여되고 기존 값은 보존
  assert.equal(out.configVersion, 1);
  assert.equal(out.token, VALID_JWT);
});
test('migrateConfig_이미v1_멱등불변', () => {
  // Given: 이미 v1
  const input = { configVersion: 1, token: VALID_JWT };
  // When / Then: 재실행해도 동일(멱등)
  assert.deepEqual(migrateConfig(input), { configVersion: 1, token: VALID_JWT });
});
test('migrateConfig_미래버전_원본보존', () => {
  // Given: 코드보다 높은 미래 버전
  const input = { configVersion: 9, futureField: 'x' };
  // When / Then: 다운그레이드 파괴 금지 — 원본 그대로
  assert.deepEqual(migrateConfig(input), { configVersion: 9, futureField: 'x' });
});

// ── normalizeConfig ─────────────────────────────────────────
test('normalizeConfig_손상필드하나_해당필드만제거_토큰보존', () => {
  // Given: token은 유효한데 lastSyncDate만 숫자로 손상
  const out = normalizeConfig({ token: VALID_JWT, deviceId: VALID_UUID, lastSyncDate: 12345 }, TODAY);
  // Then: token/deviceId는 보존, lastSyncDate만 제거
  assert.equal(out.token, VALID_JWT);
  assert.equal(out.deviceId, VALID_UUID);
  assert.equal('lastSyncDate' in out, false);
  assert.equal(out.configVersion, CURRENT_CONFIG_VERSION);
});
test('normalizeConfig_미래lastSyncDate_제거', () => {
  // Given: 미래 워터마크(히스토리 영구 공백 유발값)
  const out = normalizeConfig({ lastSyncDate: '9999-01-01' }, TODAY);
  // Then: 제거되어 다음 sync가 전체 재파싱
  assert.equal('lastSyncDate' in out, false);
});
test('normalizeConfig_알수없는필드_passthrough보존', () => {
  // Given: 신버전이 추가했을 미지 필드 + 유효 토큰
  const out = normalizeConfig({ futureField: 1, token: VALID_JWT }, TODAY);
  // Then: 둘 다 보존(구버전 CLI가 신버전 필드를 파괴하지 않음)
  assert.equal(out.futureField, 1);
  assert.equal(out.token, VALID_JWT);
});
test('normalizeConfig_비객체입력_기본configVersion반환', () => {
  // Given / When / Then: null/배열 등은 기본 스키마로
  assert.deepEqual(normalizeConfig(null, TODAY), { configVersion: CURRENT_CONFIG_VERSION });
  assert.deepEqual(normalizeConfig([1, 2], TODAY), { configVersion: CURRENT_CONFIG_VERSION });
});
test('normalizeConfig_미래버전_검증없이원본보존', () => {
  // Given: 미래 버전 파일
  const out = normalizeConfig({ configVersion: 9, token: 'garbage', unknown: true }, TODAY);
  // Then: 검증/제거 없이 그대로(토큰이 형태상 이상해도 건드리지 않음)
  assert.deepEqual(out, { configVersion: 9, token: 'garbage', unknown: true });
});
test('normalizeConfig_정상전체_모두보존및버전스탬프', () => {
  // Given: 전 필드가 유효한 config
  const input = {
    token: VALID_JWT,
    deviceId: VALID_UUID,
    lastSyncDate: '2026-07-09',
    hookInstalled: true,
    hookInstalledAt: '2026-06-27T08:09:55.569Z',
    hookMeta: { platform: 'darwin' },
    claudePaths: ['~/.claude'],
  };
  // When
  const out = normalizeConfig(input, TODAY);
  // Then: 모든 필드 보존 + configVersion 스탬프
  assert.equal(out.token, VALID_JWT);
  assert.equal(out.hookInstalled, true);
  assert.deepEqual(out.claudePaths, ['~/.claude']);
  assert.equal(out.configVersion, CURRENT_CONFIG_VERSION);
});

test('normalizeConfig_손상토큰_토큰만제거_나머지보존', () => {
  // Given: token만 형태 손상(JWT 3세그먼트 아님), deviceId·lastSyncDate는 유효
  const out = normalizeConfig({ token: 'not-a-jwt', deviceId: VALID_UUID, lastSyncDate: '2026-07-09' }, TODAY);
  // Then: token만 제거(→ 재인증 유도), 유효 필드는 보존
  assert.equal('token' in out, false);
  assert.equal(out.deviceId, VALID_UUID);
  assert.equal(out.lastSyncDate, '2026-07-09');
  assert.equal(out.configVersion, CURRENT_CONFIG_VERSION);
});

test('normalizeConfig_각필드개별손상_해당필드만제거_유효필드보존', () => {
  // Given: 각 필드를 개별 손상시키고 token은 유효하게 둔다
  const cases = [
    { field: 'deviceId', bad: 'not-uuid' },
    { field: 'lastSyncDate', bad: 12345 },
    { field: 'hookInstalledAt', bad: 'nope' },
    { field: 'hookInstalled', bad: 'yes' },
    { field: 'claudePaths', bad: 'x' },
    { field: 'hookMeta', bad: [] },
  ];
  for (const { field, bad } of cases) {
    // When: 해당 필드만 손상
    const out = normalizeConfig({ token: VALID_JWT, [field]: bad }, TODAY);
    // Then: 손상 필드는 제거, 유효한 token은 보존
    assert.equal(field in out, false, `${field} 손상값이 제거되어야 함`);
    assert.equal(out.token, VALID_JWT, `${field} 손상 시에도 token 보존`);
  }
});

test('normalizeConfig_불리언false_hookInstalled보존', () => {
  // Given: hookInstalled=false는 유효한 불리언
  const out = normalizeConfig({ hookInstalled: false }, TODAY);
  // Then: false를 없음으로 오취급하지 않고 그대로 보존
  assert.equal(out.hookInstalled, false);
});
