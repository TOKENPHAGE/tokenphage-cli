import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUpdateInfo, checkLatestVersion } from '../src/lib/update-check.js';

// 테스트 목록 — update 판정은 순수 함수(getUpdateInfo)로, 조회는 checkLatestVersion(fetch 스텁)으로 검증한다.
// [getUpdateInfo]  조회한 latest vs 설치버전 문자열 불일치(!==) 판정 (순수)
// 1. getUpdateInfo_최신이다름_hasUpdate참            (성공: 핵심 시나리오)
// 2. getUpdateInfo_latest없음_hasUpdate거짓          (실패 입력: 조회 실패/옵트아웃 → null)
// 3. getUpdateInfo_동일버전_hasUpdate거짓            (경계: 업데이트 직후 상태)
// 4. getUpdateInfo_베타패치최신_hasUpdate참          (성공: -BETA 회귀 가드)
// 5. getUpdateInfo_설치본이최신보다앞섬_hasUpdate참   (경계: !== 의도된 동작 명시)
// [checkLatestVersion]  옵트아웃 게이트 + fetch 성공/폴백 (globalThis.fetch 스텁으로 결정적)
// 6. checkLatestVersion_옵트아웃env_null             (경계: 알림 끔 → 조회 스킵)
// 7. checkLatestVersion_성공_latest반환              (성공: 정상 매니페스트 파싱)
// 8. checkLatestVersion_404_null                    (실패: 미배포/오타 → null)
// 9. checkLatestVersion_version비문자열_null         (실패: 에러객체 등 → typeof 가드)
// 10. checkLatestVersion_fetch거부_null              (실패: 네트워크 단절/타임아웃 → catch)

test('getUpdateInfo_최신이다름_hasUpdate참', () => {
  // Given / When: 조회된 latest가 현재와 다름
  const info = getUpdateInfo('2026.6.0', '2026.7.0');

  // Then
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, '2026.7.0');
  assert.equal(info.current, '2026.6.0');
});

test('getUpdateInfo_latest없음_hasUpdate거짓', () => {
  // Given / When / Then: 조회 실패·옵트아웃으로 latest가 null이면 알림 없음
  assert.equal(getUpdateInfo('2026.6.0', null).hasUpdate, false);
});

test('getUpdateInfo_동일버전_hasUpdate거짓', () => {
  // Given / When / Then: 최신과 동일하면 알림 없음(업데이트 직후 상태)
  assert.equal(getUpdateInfo('2026.7.0', '2026.7.0').hasUpdate, false);
});

test('getUpdateInfo_베타패치최신_hasUpdate참', () => {
  // Given: 다음 패치 베타가 최신 (이번 버그 회귀 가드 — 예전엔 -BETA에서 NaN 폴백으로 항상 false)
  const info = getUpdateInfo('2026.7.0-BETA', '2026.7.1-BETA');

  // Then
  assert.equal(info.hasUpdate, true);
  assert.equal(info.latest, '2026.7.1-BETA');
});

test('getUpdateInfo_설치본이최신보다앞섬_hasUpdate참', () => {
  // Given / When / Then: 설치본이 latest보다 앞서도 불일치면 알림(의도된 동작 — update는 항상 @latest 설치)
  assert.equal(getUpdateInfo('2026.7.2-BETA', '2026.7.1-BETA').hasUpdate, true);
});

test('checkLatestVersion_옵트아웃env_null', async () => {
  // Given: 옵트아웃 env 설정 (fetch 전에 즉시 null이어야 함 — 네트워크 미사용)
  const saved = process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
  process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER = '1';

  // When / Then: 옵트아웃이면 조회를 스킵하고 null
  try {
    assert.equal(await checkLatestVersion(), null);
  } finally {
    // 다른 테스트 오염 방지: env 원복
    if (saved === undefined) delete process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
    else process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER = saved;
  }
});

// checkLatestVersion의 fetch 경로를 결정적으로 검증하기 위해 globalThis.fetch를 스텁으로 교체하고
// 옵트아웃 env를 잠시 해제한다(테스트 종료 시 fetch·env 모두 원복).
async function withStubbedFetch(fetchImpl, run) {
  const savedFetch = globalThis.fetch;
  const savedNotifier = process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
  const savedApi = process.env.TOKENPHAGE_API;
  globalThis.fetch = fetchImpl;
  delete process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
  delete process.env.TOKENPHAGE_API;
  try {
    return await run();
  } finally {
    globalThis.fetch = savedFetch;
    if (savedNotifier === undefined) delete process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER;
    else process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER = savedNotifier;
    if (savedApi === undefined) delete process.env.TOKENPHAGE_API;
    else process.env.TOKENPHAGE_API = savedApi;
  }
}

test('checkLatestVersion_성공_latest반환', async () => {
  // Given: 레지스트리가 정상 매니페스트 반환 (이 값이 getUpdateInfo 판정 입력이 됨)
  const latest = await withStubbedFetch(
    async () => ({ ok: true, json: async () => ({ version: '2026.7.2-BETA' }) }),
    () => checkLatestVersion(),
  );

  // Then: version 문자열을 그대로 반환
  assert.equal(latest, '2026.7.2-BETA');
});

test('checkLatestVersion_404_null', async () => {
  // Given: 미배포/오타 패키지 → 404 (res.ok=false)
  const latest = await withStubbedFetch(
    async () => ({ ok: false, json: async () => ({}) }),
    () => checkLatestVersion(),
  );

  // Then: 조용히 null
  assert.equal(latest, null);
});

test('checkLatestVersion_version비문자열_null', async () => {
  // Given: 레지스트리 에러객체 등 version이 문자열이 아님
  const latest = await withStubbedFetch(
    async () => ({ ok: true, json: async () => ({ error: 'Not found' }) }),
    () => checkLatestVersion(),
  );

  // Then: typeof 가드로 null
  assert.equal(latest, null);
});

test('checkLatestVersion_fetch거부_null', async () => {
  // Given: 네트워크 단절/타임아웃(abort) → fetch reject
  const latest = await withStubbedFetch(
    async () => { throw new Error('network down'); },
    () => checkLatestVersion(),
  );

  // Then: catch로 null (throw하지 않음)
  assert.equal(latest, null);
});
