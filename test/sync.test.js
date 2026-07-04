import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { syncRecords, resetData } from '../src/sync.js';

// 테스트 목록
// 1. syncRecords_정상2xx_sync엔드포인트에계약대로POST            (성공: URL/메서드/헤더/바디 shape)
// 2. syncRecords_비2xx응답_status포함Error로throw               (실패)
// 3. resetData_정상2xx_reset엔드포인트에바디없이POST            (성공)
// 4. resetData_429응답_서버message만throw                       (경계: prefix 없이 원문)
// 5. resetData_기타에러JSON본문_ServerError프리픽스포함throw    (실패)
// 6. resetData_비JSON본문_텍스트그대로폴백                      (경계)
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

test('syncRecords_비2xx응답_status포함Error로throw', async () => {
  // Given: 서버가 500과 본문을 반환
  stubFetch({ ok: false, status: 500, body: 'internal boom' });

  // When
  // Then: status와 본문을 담아 throw
  await assert.rejects(
    () => syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS),
    (err) => err instanceof Error && /500/.test(err.message) && /internal boom/.test(err.message),
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

test('resetData_기타에러JSON본문_ServerError프리픽스포함throw', async () => {
  // Given: 500 + JSON message
  stubFetch({ ok: false, status: 500, body: JSON.stringify({ message: 'db down' }) });

  // When
  // Then: 429가 아니면 "Server error: {status} {message}" 형식
  await assert.rejects(
    () => resetData(API_BASE, TOKEN),
    (err) => err.message === 'Server error: 500 db down',
  );
});

test('resetData_비JSON본문_텍스트그대로폴백', async () => {
  // Given: 500 + JSON이 아닌 본문
  stubFetch({ ok: false, status: 500, body: '<html>Bad Gateway</html>' });

  // When
  // Then: JSON 파싱 실패 시 원문 텍스트로 폴백
  await assert.rejects(
    () => resetData(API_BASE, TOKEN),
    (err) => err.message === 'Server error: 500 <html>Bad Gateway</html>',
  );
});
