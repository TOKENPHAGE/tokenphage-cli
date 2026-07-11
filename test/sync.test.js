import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncRecords, resetData, mapServerError } from '../src/sync.js';

// 테스트 목록
// 1. syncRecords_정상2xx_sync엔드포인트에계약대로POST            (성공: URL/메서드/헤더/바디 shape)
// 2. syncRecords_500응답_일시오류메시지로throw                  (실패: mapServerError 매핑, 원문 미노출)
// 3. syncRecords_401응답_재로그인메시지로throw                  (실패: 인증)
// 4. resetData_정상2xx_reset엔드포인트에바디없이POST            (성공)
// 5. resetData_429응답_서버message만throw                       (경계: prefix 없이 원문)
// 6. resetData_429비JSON본문_원문텍스트폴백                     (경계: JSON 파싱 실패)
// 7. resetData_500응답_일시오류메시지로throw                    (실패: mapServerError 매핑)
// [mapServerError] 상태코드 → 영어 메시지 (순수)
// 8. mapServerError_401_재로그인지시                            (성공)
// 9. mapServerError_400deviceId_설정손상안내                    (경계)
// 10. mapServerError_400기타_업데이트안내                       (경계)
// 11. mapServerError_500_일시오류안내                           (성공)
// 12. mapServerError_알수없는상태_폴백                          (실패 입력)
//
// syncRecords/resetData는 전역 fetch만 사용하므로(node-fetch 의존 없음) globalThis.fetch를
// 스텁해 네트워크·DB 없이 요청 계약(URL·메서드·헤더·바디 shape)과 에러 처리를 고정한다.
// 스킬이 지목한 #1 회귀(요청 body/헤더 drift)는 정확히 이 계약이 깨질 때 발생한다.

const API_BASE = 'https://api.example.test';
const TOKEN = 'jwt-abc';
const DEVICE_ID = 'device-0001';
const RECORDS = [
  { date: '2026-06-10', model: 'claude-sonnet-4-6', inputTok: 100, outputTok: 50, cacheReadTok: 20, cacheCreateTok: 10 },
];

let originalFetch;
let calls;

/** 지정 응답을 돌려주는 fetch 스텁을 설치하고 호출 인자를 calls에 기록한다. */
function stubFetch({ ok, status, body = '' }) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      text: async () => body,
    };
  };
}

beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('syncRecords_정상2xx_sync엔드포인트에계약대로POST', async () => {
  // Given: 서버가 200 OK를 반환
  stubFetch({ ok: true, status: 200 });

  // When
  await syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS);

  // Then: URL·메서드·헤더·바디 shape가 계약과 정확히 일치
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${API_BASE}/api/sync`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(init.body), { deviceId: DEVICE_ID, records: RECORDS });
});

test('syncRecords_500응답_일시오류메시지로throw', async () => {
  // Given: 서버가 500과 본문을 반환
  stubFetch({ ok: false, status: 500, body: 'internal boom' });

  // When
  // Then: 원문 대신 매핑된 메시지로 throw
  await assert.rejects(
    () => syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS),
    (err) => err instanceof Error
      && err.message === 'Server temporarily unavailable. Your existing badge data is safe.',
  );
});

test('syncRecords_401응답_재로그인메시지로throw', async () => {
  // Given: 인증 실패(토큰 만료/손상)
  stubFetch({ ok: false, status: 401, body: '' });

  // When
  // Then: 재로그인 실행 지시 메시지
  await assert.rejects(
    () => syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS),
    (err) => err.message === 'Authentication expired or invalid. Run `tokenphage login` to sign in again.',
  );
});

test('resetData_정상2xx_reset엔드포인트에바디없이POST', async () => {
  // Given: 서버가 200 OK를 반환
  stubFetch({ ok: true, status: 200 });

  // When
  await resetData(API_BASE, TOKEN);

  // Then: reset 엔드포인트로 인증 헤더만 담아 POST, 바디는 보내지 않는다
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, `${API_BASE}/api/reset`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Authorization'], `Bearer ${TOKEN}`);
  assert.equal(init.body, undefined);
});

test('resetData_429응답_서버message만throw', async () => {
  // Given: 429 쿨다운 응답 (JSON message 포함)
  stubFetch({ ok: false, status: 429, body: JSON.stringify({ message: '5분 후 다시 시도하세요' }) });

  // When
  // Then: 429는 "Server error:" prefix 없이 서버 message를 그대로 노출
  await assert.rejects(
    () => resetData(API_BASE, TOKEN),
    (err) => err.message === '5분 후 다시 시도하세요',
  );
});

test('resetData_429비JSON본문_원문텍스트폴백', async () => {
  // Given: 429인데 본문이 JSON이 아님
  stubFetch({ ok: false, status: 429, body: 'Too Many Requests' });

  // When
  // Then: 429 쿨다운 경로는 JSON 파싱 실패 시 원문 텍스트를 그대로 노출
  await assert.rejects(
    () => resetData(API_BASE, TOKEN),
    (err) => err.message === 'Too Many Requests',
  );
});

test('resetData_500응답_일시오류메시지로throw', async () => {
  // Given: 500 + JSON message
  stubFetch({ ok: false, status: 500, body: JSON.stringify({ message: 'db down' }) });

  // When
  // Then: 429가 아닌 오류는 mapServerError로 매핑(서버 원문 미노출)
  await assert.rejects(
    () => resetData(API_BASE, TOKEN),
    (err) => err.message === 'Server temporarily unavailable. Your existing badge data is safe.',
  );
});

// ── mapServerError (순수) ───────────────────────────────────
test('mapServerError_401_재로그인지시', () => {
  // Given / When / Then
  assert.equal(mapServerError(401), 'Authentication expired or invalid. Run `tokenphage login` to sign in again.');
});

test('mapServerError_400deviceId_설정손상안내', () => {
  // Given: 서버 400 본문에 deviceId 위반 메시지
  const msg = mapServerError(400, JSON.stringify({ message: 'deviceId must be a valid UUID' }));
  // Then: 설정 손상 → 재로그인 안내
  assert.equal(msg, 'Your config file looks corrupted. Run `tokenphage login` to re-authenticate.');
});

test('mapServerError_400기타_업데이트안내', () => {
  // Given: deviceId 외 형식 위반
  const msg = mapServerError(400, JSON.stringify({ message: 'date must be in ISO format' }));
  // Then: CLI 업데이트 안내
  assert.equal(msg, 'Request format error. Update the CLI: npm i -g tokenphage@latest');
});

test('mapServerError_500_일시오류안내', () => {
  // Given / When / Then: 5xx는 일시 오류 안내
  assert.equal(mapServerError(503), 'Server temporarily unavailable. Your existing badge data is safe.');
});

test('mapServerError_알수없는상태_폴백', () => {
  // Given / When / Then: 매핑되지 않은 상태는 "Server error: {status}" 폴백
  assert.equal(mapServerError(418, 'teapot'), 'Server error: 418');
});
