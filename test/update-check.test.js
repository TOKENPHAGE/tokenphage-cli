import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersion, shouldCheck, getUpdateInfo } from '../src/lib/update-check.js';

// 테스트 목록 — 비교/TTL/판정은 순수 함수(네트워크·파일 무관)로 결정적으로 검증한다.
// fetchLatestFromNpm/refreshCache는 네트워크·config 의존이라 단위 테스트 제외(수동/통합).
// [compareVersion]  CalVer "YYYY.M.PATCH" 숫자 3파트 비교 (-1/0/1)
// 1. compareVersion_더큰최신버전_양수            (성공: 핵심 시나리오)
// 2. compareVersion_동일버전_0                   (경계)
// 3. compareVersion_구버전비교_음수              (성공)
// 4. compareVersion_월롤오버_연도우선            (경계: 12 → 1 + 연도 증가)
// 5. compareVersion_패치만증가_양수              (경계)
// 6. compareVersion_비CalVer입력_0폴백           (실패 입력: dev 버전 등)
// [shouldCheck]  24h TTL 판정 (now 주입으로 결정성 확보)
// 7. shouldCheck_마지막조회없음_검사필요         (경계)
// 8. shouldCheck_24시간경과_검사필요             (성공)
// 9. shouldCheck_24시간이내_검사불필요           (경계)
// [getUpdateInfo]  캐시 vs 현재버전 판정
// 10. getUpdateInfo_캐시최신이더큼_hasUpdate참   (성공: 핵심 시나리오)
// 11. getUpdateInfo_캐시없음_hasUpdate거짓       (실패 입력)
// 12. getUpdateInfo_동일버전_hasUpdate거짓       (경계: 업데이트 직후 상태)
// 13. getUpdateInfo_옵트아웃env_hasUpdate거짓    (경계: 알림 끔)

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-06-22T12:00:00.000Z');

test('compareVersion_더큰최신버전_양수', () => {
  // Given / When / Then: 다음 달 릴리스가 더 최신
  assert.equal(compareVersion('2026.7.0', '2026.6.0'), 1);
});

test('compareVersion_동일버전_0', () => {
  // Given / When / Then: 같은 버전은 차이 없음
  assert.equal(compareVersion('2026.6.0', '2026.6.0'), 0);
});

test('compareVersion_구버전비교_음수', () => {
  // Given / When / Then: 왼쪽이 더 구버전이면 음수
  assert.equal(compareVersion('2026.6.0', '2026.7.0'), -1);
});

test('compareVersion_월롤오버_연도우선', () => {
  // Given: 12월 → 다음 해 1월 (월 숫자는 작아지지만 연도가 커짐)
  // When / Then: 연도 파트가 우선이므로 2027.1.0 이 더 최신
  assert.equal(compareVersion('2027.1.0', '2026.12.0'), 1);
});

test('compareVersion_패치만증가_양수', () => {
  // Given / When / Then: 같은 달 패치 증가
  assert.equal(compareVersion('2026.6.1', '2026.6.0'), 1);
});

test('compareVersion_비CalVer입력_0폴백', () => {
  // Given: dev/비숫자 버전 — 비교 불가
  // When / Then: 안전하게 0(업데이트 없음)으로 폴백, 양방향 모두
  assert.equal(compareVersion('dev', '2026.6.0'), 0);
  assert.equal(compareVersion('2026.6.0', 'dev'), 0);
});

test('compareVersion_3파트아님_0폴백', () => {
  // Given: 2파트/4파트 등 CalVer 형식 위반(레지스트리 응답 이상)
  // When / Then: 형식 어긋나면 비교하지 않고 0 — 조용한 오탐/누락 방지
  assert.equal(compareVersion('2026.7', '2026.6.0'), 0);
  assert.equal(compareVersion('2026.6.0.1', '2026.6.0'), 0);
});

test('shouldCheck_마지막조회없음_검사필요', () => {
  // Given / When / Then: 조회 이력이 없으면 무조건 검사
  assert.equal(shouldCheck(null, NOW), true);
});

test('shouldCheck_24시간경과_검사필요', () => {
  // Given: 25시간 전 마지막 조회
  const last = new Date(NOW - 25 * HOUR_MS).toISOString();

  // When / Then: TTL(24h) 초과 → 재조회
  assert.equal(shouldCheck(last, NOW), true);
});

test('shouldCheck_정확히24시간_검사필요', () => {
  // Given: 정확히 24시간 전 (>= 경계)
  const last = new Date(NOW - 24 * HOUR_MS).toISOString();

  // When / Then: TTL 경계 도달 → 재조회(>=)
  assert.equal(shouldCheck(last, NOW), true);
});

test('shouldCheck_24시간이내_검사불필요', () => {
  // Given: 1시간 전 마지막 조회
  const last = new Date(NOW - 1 * HOUR_MS).toISOString();

  // When / Then: TTL 이내 → 스킵
  assert.equal(shouldCheck(last, NOW), false);
});

test('getUpdateInfo_캐시최신이더큼_hasUpdate참', () => {
  // Given: 캐시된 최신버전이 현재보다 높음
  const cfg = { latestVersion: '2026.7.0' };

  // When
  const info = getUpdateInfo('2026.6.0', cfg);

  // Then
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, '2026.7.0');
  assert.equal(info.current, '2026.6.0');
});

test('getUpdateInfo_캐시없음_hasUpdate거짓', () => {
  // Given / When / Then: latestVersion 캐시가 없으면 알림 없음
  assert.equal(getUpdateInfo('2026.6.0', {}).hasUpdate, false);
});

test('getUpdateInfo_동일버전_hasUpdate거짓', () => {
  // Given: 업데이트 직후 — 현재버전이 캐시 최신과 같아짐
  // When / Then: 알림 자동 소멸
  assert.equal(getUpdateInfo('2026.7.0', { latestVersion: '2026.7.0' }).hasUpdate, false);
});

test('getUpdateInfo_옵트아웃env_hasUpdate거짓', () => {
  // Given: 옵트아웃 환경변수 설정 + 새 버전 캐시
  const saved = process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
  process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER = '1';

  // When / Then: 옵트아웃이면 새 버전이 있어도 알리지 않음
  try {
    assert.equal(getUpdateInfo('2026.6.0', { latestVersion: '2026.7.0' }).hasUpdate, false);
  } finally {
    // 다른 테스트 오염 방지: env 원복
    if (saved === undefined) delete process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
    else process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER = saved;
  }
});
