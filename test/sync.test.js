import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { syncRecords, resetData, mapServerError, apiFetch } from '../src/sync.js';
import { gistLogin } from '../src/auth.js';

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
// [실행시간 전송·이름표·지원 종료 안내] 흐름(경고·설정 저장)은 sync-flow.test.js
// 13. syncRecords_토큰과실행시간_한요청에함께                   (성공)
// 14. syncRecords_실행시간10000개_1회요청                       (경계)
// 15. syncRecords_실행시간10001개_2회요청_두번째는records빈배열  (경계)
// 16. API요청_sync·reset·auth_모두이름표UA                     (성공)
// 17. mapServerError_410·426_업데이트안내                       (실패)
// 18. apiFetch_Deprecation·Sunset·Link헤더_안내1줄             (성공)
// 19. apiFetch_지원종료헤더없음_안내없이통과                    (엣지: headers 없음·get 없음 포함)
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
const RUNTIMES = [
  { date: '2026-06-10', source: 'claude', model: 'claude-sonnet-4-6', runtimeMs: 7_200_000 },
];
const RUNTIME_RESULT = JSON.stringify({ runtimes: { accepted: 1, rejected: 0 } });
// 이름표 형식은 서버 감사 로그가 받는 외부 계약이라 package.json에서 따로 조립해 대조한다
const { version: PKG_VERSION } = createRequire(import.meta.url)('../package.json');
const EXPECTED_UA = `tokenphage-cli/${PKG_VERSION} (${process.platform}; ${process.arch}) node/${process.versions.node}`;

/** 실행시간 n개를 만든다(모델 이름으로 서로 구분). */
const runtimesOf = (n) => Array.from({ length: n }, (_, i) => ({ date: '2026-06-10', source: 'claude', model: `m-${i}`, runtimeMs: 1 }));

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

// ── 실행시간 전송·이름표·지원 종료 안내 ─────────────────────────
test('syncRecords_토큰과실행시간_한요청에함께', async () => {
  // Given: 서버가 실행시간 결과 본문과 함께 200을 반환
  stubFetch({ ok: true, status: 200, body: RUNTIME_RESULT });

  // When
  await syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS, RUNTIMES);

  // Then: 한 요청 본문에 토큰과 실행시간이 함께 실린다
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), { deviceId: DEVICE_ID, records: RECORDS, runtimes: RUNTIMES });
});

test('syncRecords_실행시간10000개_1회요청', async () => {
  // Given: 서버 한도(SyncRequest.MAX_RECORDS)와 같은 개수
  stubFetch({ ok: true, status: 200, body: RUNTIME_RESULT });

  // When
  await syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS, runtimesOf(10_000));

  // Then: 나누지 않는다
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).runtimes.length, 10_000);
});

test('syncRecords_실행시간10001개_2회요청_두번째는records빈배열', async () => {
  // Given: 한도를 1개 넘는 실행시간
  stubFetch({ ok: true, status: 200, body: RUNTIME_RESULT });
  const runtimes = runtimesOf(10_001);

  // When
  await syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS, runtimes);

  // Then: 토큰은 첫 요청에 모두, 남은 실행시간은 records: []와 함께 보낸다
  assert.equal(calls.length, 2);
  const [first, second] = calls.map(({ init }) => JSON.parse(init.body));
  assert.deepEqual(first, { deviceId: DEVICE_ID, records: RECORDS, runtimes: runtimes.slice(0, 10_000) });
  assert.deepEqual(second, { deviceId: DEVICE_ID, records: [], runtimes: runtimes.slice(10_000) });
});

test('API요청_sync·reset·auth_모두이름표UA', async () => {
  // Given: 인증 챌린지는 실패시켜 브라우저·입력 단계 전에 끝낸다
  const agents = [];
  globalThis.fetch = async (url, init) => {
    agents.push(init.headers['User-Agent']);
    return url.endsWith('/auth/challenge')
      ? { ok: false, status: 503, text: async () => '{}' }
      : { ok: true, status: 200, text: async () => '' };
  };

  // When
  await syncRecords(API_BASE, TOKEN, DEVICE_ID, RECORDS);
  await resetData(API_BASE, TOKEN);
  await assert.rejects(() => gistLogin(API_BASE, 'octocat'), /Challenge request failed/);

  // Then: 세 요청 모두 같은 이름표를 붙인다
  assert.deepEqual(agents, [EXPECTED_UA, EXPECTED_UA, EXPECTED_UA]);
});

test('mapServerError_410·426_업데이트안내', () => {
  // Given / When / Then: 지원 종료(410)·업그레이드 필요(426)는 업데이트 명령 안내
  for (const status of [410, 426]) {
    assert.equal(mapServerError(status), 'This CLI version is no longer supported. Update: npm i -g tokenphage@latest');
  }
});

test('apiFetch_Deprecation·Sunset·Link헤더_안내1줄', async () => {
  // Given: 지원 종료를 알리는 표준 헤더 3종(RFC 9745, RFC 8594, Link rel="deprecation")
  const cases = [
    { headers: { Deprecation: '@1798761599' }, expected: [/deprecated/, /npm i -g tokenphage@latest/] },
    { headers: { Sunset: 'Thu, 31 Dec 2026 23:59:59 GMT' }, expected: [/Thu, 31 Dec 2026 23:59:59 GMT/] },
    {
      headers: { Link: '<https://a.example/alt>; rel="alternate", <https://tokenphage.com/deprecation>; rel="deprecation"; type="text/html"' },
      expected: [/https:\/\/tokenphage\.com\/deprecation/],
    },
  ];
  for (const { headers, expected } of cases) {
    const notices = [];

    // When
    await apiFetch(`${API_BASE}/api/sync`, { method: 'POST' }, {
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(headers) }),
      onNotice: (msg) => notices.push(msg),
    });

    // Then: 안내 1줄에 업데이트 방법과 헤더 정보가 담긴다
    assert.equal(notices.length, 1, JSON.stringify(headers));
    for (const pattern of expected) assert.match(notices[0], pattern);
  }
});

test('apiFetch_지원종료헤더없음_안내없이통과', async () => {
  // Given: headers 없음(기존 스텁), get 없는 객체, 빈 Headers, deprecation이 아닌 Link
  const variants = [undefined, {}, new Headers(), new Headers({ Link: '<https://a.example/next>; rel="next"' })];
  const notices = [];

  // When
  for (const headers of variants) {
    await apiFetch(`${API_BASE}/api/sync`, { method: 'POST' }, {
      fetchImpl: async () => ({ ok: true, status: 200, headers }),
      onNotice: (msg) => notices.push(msg),
    });
  }

  // Then: 예외도 안내도 없다
  assert.deepEqual(notices, []);
});
