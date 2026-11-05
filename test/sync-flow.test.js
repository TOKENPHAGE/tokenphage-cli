import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { runSyncFlow } from '../src/sync-flow.js';
import { normalizeConfig } from '../src/lib/config-schema.js';

// sync 흐름(기준 날짜·버전 판단 → 파싱 → 전송 → 설정 저장) 테스트.
// 설정 저장소·파서·fetch·출력을 대역으로 넣어 실제 ~/.tokenphage/config.json, 로그, 서버를 건드리지 않는다.
// 요청 본문 모양·나눠 보내기·이름표·헤더 해석은 sync.test.js, lastSyncVersion 형식은 config-schema.test.js,
// reset의 두 값 삭제는 auth.test.js에서 본다.
//
// 테스트 목록:
//  [5. 기준 날짜·버전 판단과 저장]
//   1. 범위_버전같음_실행시간도lastSyncDate부터                          (성공)
//   2. 저장_실행시간완전성공_오늘날짜와지금버전기록_다른칸보존             (성공)
//   3. 저장_도구읽기실패_날짜와버전기록_경고1줄                          (실패)
//   4. 저장_첫요청실패_설정그대로                                        (실패)
//   5. 저장_파싱실패_요청없이설정그대로                                   (실패, 기준선: parseLogs 예외)
//   6. 범위_lastSyncDate당일포함_전날제외                                (경계)
//   7. 범위_버전없음더높음더낮음_실행시간전체_토큰은lastSyncDate부터       (엣지)
//   8. 범위_lastSyncDate없음_토큰실행시간모두전체                         (엣지)
//   9. 저장_보낼것없고모두읽음_요청없이날짜와버전기록                     (엣지)
//  10. 저장_rejected있어도_버전기록                                      (엣지)
//  11. 오늘_시작시한번계산_자정을넘겨도시작일로저장                       (엣지)
//  [6. 전송]
//  12. 후속묶음실패_경고1줄_종료코드0_실행시간미완료                       (실패: 500·네트워크 오류)
//  13. 결과본문없는2xx_경고1줄_실행시간미완료                             (엣지)
//  14. rejected있음_경고1줄                                             (엣지)
//  15. 설정저장_모든묶음뒤1회                                            (엣지)
//  [7. 사용자 유형 흐름: 같은 임시 설정 파일로 sync 2회, 저장한 설정이 다음 실행에 쓰이는지만 본다]
//  16. 새사용자_1회차둘다전체_2회차둘다lastSyncDate부터                   (성공)
//  17. 1회차실행시간미완료_2회차실행시간전체                              (실패)
//  18. 기존사용자업데이트_1회차실행시간만전체_2회차둘다lastSyncDate부터    (엣지)
//  [8. 지원 종료 안내]
//  19. Deprecation헤더_대화형_노란안내1줄                                 (성공)
//  20. Deprecation헤더_헤드리스_sync.log용평문1줄                         (엣지)

const API_BASE = 'https://api.example.test';
const TOKEN = 'jwt-abc';
const DEVICE_ID = '23189c5d-47db-4de3-b40b-1732c9af99a3';
const VERSION = '2026.10.0';
const LAST = '2026-10-08';    // 저장돼 있던 lastSyncDate
const TODAY = '2026-10-11';
const NEXT_DAY = '2026-10-12';
const RECORD = { date: TODAY, model: 'claude-opus-4-1', inputTok: 1, outputTok: 2, cacheReadTok: 3, cacheCreateTok: 4 };
const RUNTIME = { date: TODAY, source: 'claude', model: 'claude-opus-4-1', runtimeMs: 60_000 };
const RESULT_OK = { status: 200, body: JSON.stringify({ runtimes: { accepted: 1, rejected: 0 } }) };
const RESULT_REJECTED = { status: 200, body: JSON.stringify({ runtimes: { accepted: 0, rejected: 1 } }) };
const DEPRECATED = { ...RESULT_OK, headers: { Deprecation: '@1798761599' } };

/** 실행시간 n개를 만든다(모델 이름으로 서로 구분). */
const runtimesOf = (n) => Array.from({ length: n }, (_, i) => ({ ...RUNTIME, model: `m-${i}` }));

/** 경고 줄만 고른다(헤드리스는 색 없는 "! " 접두). */
const warnings = (lines) => lines.filter((line) => line.startsWith('! '));

/** 메모리 설정 저장소: 쓰기마다 기록을 남긴다. */
function memoryConfig(initial = {}) {
  const store = { current: { ...initial }, writes: [] };
  store.readConfig = () => ({ ...store.current });
  store.writeConfig = (cfg) => { store.writes.push(cfg); store.current = { ...cfg }; };
  return store;
}

const tempDirs = [];
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

/** 임시 설정 파일 저장소: 읽을 때 loadConfig처럼 normalizeConfig를 거친다. */
function fileConfig(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenphage-sync-flow-'));
  tempDirs.push(dir);
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(initial));
  return {
    readConfig: () => normalizeConfig(JSON.parse(readFileSync(path, 'utf8')), NEXT_DAY),
    writeConfig: (cfg) => writeFileSync(path, JSON.stringify(cfg, null, 2)),
  };
}

/** 파서 대역: 받은 범위를 기록하고 정한 결과를 돌려준다. */
function fakeParser({ records = [RECORD], runtimes = [RUNTIME], allSourcesRead = true, failedSources = [] } = {}) {
  const parseLogs = async (range) => {
    parseLogs.ranges.push(range);
    return { records, runtimes, allSourcesRead, failedSources };
  };
  parseLogs.ranges = [];
  return parseLogs;
}

/** fetch 대역: 응답을 차례로 돌려주고(마지막 응답은 반복, Error면 throw) 요청 본문을 기록한다. */
function fakeFetch(...responses) {
  const fetchImpl = async (_url, init) => {
    fetchImpl.bodies.push(JSON.parse(init.body));
    const response = responses[Math.min(fetchImpl.bodies.length, responses.length) - 1];
    if (response instanceof Error) throw response;
    const { status, body = '', headers = {} } = response;
    return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => body };
  };
  fetchImpl.bodies = [];
  return fetchImpl;
}

/** 기본 대역으로 sync 흐름을 한 번 돌리고 출력 줄을 돌려준다. */
async function sync(store, deps = {}) {
  const lines = [];
  await runSyncFlow({
    apiBase: API_BASE,
    token: TOKEN,
    deviceId: DEVICE_ID,
    parseLogs: fakeParser(),
    readConfig: store.readConfig,
    writeConfig: store.writeConfig,
    fetchImpl: fakeFetch(RESULT_OK),
    version: VERSION,
    today: TODAY,
    log: (line) => lines.push(line),
    interactive: false,
    ...deps,
  });
  return lines;
}

/** 색 출력을 켠다(테스트 프로세스는 TTY가 아니라 chalk가 꺼져 있다). 테스트가 끝나면 되돌린다. */
function forceColor(t) {
  const level = chalk.level;
  chalk.level = 1;
  t.after(() => { chalk.level = level; });
}

// ─── 5. 기준 날짜·버전 판단과 저장 ───────────────────────────────────────────

test('범위_버전같음_실행시간도lastSyncDate부터', async () => {
  // Given: 지난 sync에서 지금 버전으로 실행시간까지 보냄
  const parseLogs = fakeParser();

  // When
  await sync(memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION }), { parseLogs });

  // Then: 토큰과 실행시간 모두 lastSyncDate부터
  assert.deepEqual(parseLogs.ranges, [{ tokenFrom: LAST, runtimeFrom: LAST }]);
});

test('저장_실행시간완전성공_오늘날짜와지금버전기록_다른칸보존', async () => {
  // Given: 인증·기기 정보와 옛 버전 기록이 있는 설정, 서버가 실행시간 결과를 돌려줌
  const store = memoryConfig({ token: TOKEN, deviceId: DEVICE_ID, hookInstalled: true, lastSyncDate: LAST, lastSyncVersion: '2026.9.1' });

  // When
  await sync(store);

  // Then: 날짜는 오늘, 버전은 지금 버전으로 바꾸고 나머지 칸은 그대로 둔다
  assert.deepEqual(store.current, {
    token: TOKEN, deviceId: DEVICE_ID, hookInstalled: true, lastSyncDate: TODAY, lastSyncVersion: VERSION,
  });
});

test('저장_도구읽기실패_날짜와버전기록_경고1줄', async () => {
  // Given: 로그가 있는 도구 하나(opencode)를 읽지 못함
  const store = memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION });

  // When
  const lines = await sync(store, { parseLogs: fakeParser({ allSourcesRead: false, failedSources: ['opencode'] }) });

  // Then: 경고 1줄, 버전은 유지(지우면 매일 전체 재전송으로 옛 값을 작게 덮어씀)
  assert.equal(warnings(lines).length, 1);
  assert.match(warnings(lines)[0], /opencode/);
  assert.deepEqual(store.current, { lastSyncDate: TODAY, lastSyncVersion: VERSION });
});

test('저장_첫요청실패_설정그대로', async () => {
  // Given: 토큰을 담은 첫 요청이 500
  const store = memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION });

  // When / Then: 지금처럼 매핑된 메시지로 실패하고 설정은 쓰지 않는다
  await assert.rejects(() => sync(store, { fetchImpl: fakeFetch({ status: 500 }) }), /Server temporarily unavailable/);
  assert.equal(store.writes.length, 0);
});

test('저장_파싱실패_요청없이설정그대로', async () => {
  // Given: Claude·Codex 로그 파일을 열 수 없어 parseLogs가 예외를 던짐(토큰 일부만 보내지 않기 위한 계약)
  const store = memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION });
  const fetchImpl = fakeFetch(RESULT_OK);
  const parseLogs = async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };

  // When / Then: 예외를 그대로 올리고 요청·저장을 하지 않아 다음 실행이 같은 기간을 다시 읽는다
  await assert.rejects(() => sync(store, { parseLogs, fetchImpl }), /EACCES/);
  assert.equal(fetchImpl.bodies.length, 0);
  assert.equal(store.writes.length, 0);
});

test('범위_lastSyncDate당일포함_전날제외', async () => {
  // Given: lastSyncDate 전날과 당일 기록. 파서 대역은 parseLogs 계약(시작 날짜 포함)대로 거른다
  const dayBefore = { record: { ...RECORD, date: '2026-10-07' }, runtime: { ...RUNTIME, date: '2026-10-07' } };
  const onDay = { record: { ...RECORD, date: LAST }, runtime: { ...RUNTIME, date: LAST } };
  const parseLogs = async ({ tokenFrom, runtimeFrom }) => ({
    records: [dayBefore.record, onDay.record].filter((r) => r.date >= tokenFrom),
    runtimes: [dayBefore.runtime, onDay.runtime].filter((r) => r.date >= runtimeFrom),
    allSourcesRead: true,
  });
  const fetchImpl = fakeFetch(RESULT_OK);

  // When
  await sync(memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION }), { parseLogs, fetchImpl });

  // Then: 당일은 다시 보내고 전날은 보내지 않는다
  assert.deepEqual(fetchImpl.bodies[0].records, [onDay.record]);
  assert.deepEqual(fetchImpl.bodies[0].runtimes, [onDay.runtime]);
});

test('범위_버전없음더높음더낮음_실행시간전체_토큰은lastSyncDate부터', async () => {
  for (const lastSyncVersion of [undefined, '2026.11.0', '2026.9.1']) {
    // Given: 버전 기록이 없거나(업데이트·지난 실행 미완료) 지금 버전과 다름(올림·내림)
    const config = lastSyncVersion ? { lastSyncDate: LAST, lastSyncVersion } : { lastSyncDate: LAST };
    const parseLogs = fakeParser();

    // When
    await sync(memoryConfig(config), { parseLogs });

    // Then: 실행시간은 전체 기간, 토큰은 지금처럼 lastSyncDate부터
    assert.deepEqual(parseLogs.ranges, [{ tokenFrom: LAST, runtimeFrom: null }], `lastSyncVersion=${lastSyncVersion}`);
  }
});

test('범위_lastSyncDate없음_토큰실행시간모두전체', async () => {
  // Given: 날짜가 없음(새 사용자·reset 후). 버전 기록이 같아도
  const parseLogs = fakeParser();

  // When
  await sync(memoryConfig({ lastSyncVersion: VERSION }), { parseLogs });

  // Then: 둘 다 전체 기간
  assert.deepEqual(parseLogs.ranges, [{ tokenFrom: null, runtimeFrom: null }]);
});

test('저장_보낼것없고모두읽음_요청없이날짜와버전기록', async () => {
  // Given: 새 기록이 없고 모든 도구를 읽음
  const store = memoryConfig({ lastSyncDate: LAST });
  const fetchImpl = fakeFetch(RESULT_OK);

  // When
  const lines = await sync(store, { parseLogs: fakeParser({ records: [], runtimes: [] }), fetchImpl });

  // Then: 요청 없이 날짜와 버전을 기록한다
  assert.equal(fetchImpl.bodies.length, 0);
  assert.ok(lines.includes('Nothing to sync.'));
  assert.deepEqual(store.current, { lastSyncDate: TODAY, lastSyncVersion: VERSION });
});

test('저장_rejected있어도_버전기록', async () => {
  // Given: 버전 기록이 없는 설정, 서버가 실행시간 일부를 거부(다시 보내도 다시 거부된다)
  const store = memoryConfig({ lastSyncDate: LAST });

  // When
  await sync(store, { fetchImpl: fakeFetch(RESULT_REJECTED) });

  // Then: 성공으로 보고 버전을 기록한다
  assert.equal(store.current.lastSyncVersion, VERSION);
});

test('오늘_시작시한번계산_자정을넘겨도시작일로저장', async (t) => {
  // Given: 23:59:59에 시작해 파싱 중 자정을 넘긴다
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 11, 23, 59, 59) });
  const parseLogs = async () => {
    t.mock.timers.setTime(new Date(2026, 9, 12, 0, 0, 5).getTime());
    return { records: [], runtimes: [], allSourcesRead: true };
  };
  const store = memoryConfig({});

  // When: 오늘을 넣지 않고 기본값을 쓴다
  await sync(store, { parseLogs, today: undefined });

  // Then: 시작한 날로 저장해 다음 sync가 그날을 다시 채운다
  assert.equal(store.current.lastSyncDate, '2026-10-11');
});

// ─── 6. 전송 ────────────────────────────────────────────────────────────────

test('후속묶음실패_경고1줄_종료코드0_실행시간미완료', async () => {
  for (const failure of [{ status: 500 }, new TypeError('fetch failed')]) {
    // Given: 실행시간 10,001개 중 두 번째(실행시간만 담은) 요청이 서버 오류 또는 네트워크 오류
    const store = memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION });
    const parseLogs = fakeParser({ runtimes: runtimesOf(10_001) });

    // When: 예외 없이 끝난다(index.js는 예외가 없으면 종료 코드 0)
    const lines = await sync(store, { parseLogs, fetchImpl: fakeFetch(RESULT_OK, failure) });

    // Then: 경고 1줄, 날짜는 오늘, 버전은 삭제
    assert.equal(warnings(lines).length, 1, String(failure.status ?? failure));
    assert.match(warnings(lines)[0], /next sync/);
    assert.deepEqual(store.current, { lastSyncDate: TODAY });
  }
});

test('결과본문없는2xx_경고1줄_실행시간미완료', async () => {
  // Given: 실행시간을 모르는 서버(롤백한 옛 API)가 빈 본문으로 200
  const store = memoryConfig({ lastSyncDate: LAST, lastSyncVersion: VERSION });

  // When
  const lines = await sync(store, { fetchImpl: fakeFetch({ status: 200 }) });

  // Then: 경고 1줄, 토큰은 성공(날짜 이동), 실행시간은 미완료(버전 삭제)
  assert.equal(warnings(lines).length, 1);
  assert.match(warnings(lines)[0], /did not confirm runtime records/);
  assert.deepEqual(store.current, { lastSyncDate: TODAY });
});

test('rejected있음_경고1줄', async () => {
  // Given: 서버가 실행시간 1개를 거부
  // When
  const lines = await sync(memoryConfig({}), { fetchImpl: fakeFetch(RESULT_REJECTED) });

  // Then: 재시도 없이 경고 1줄
  assert.equal(warnings(lines).length, 1);
  assert.match(warnings(lines)[0], /1 runtime record/);
});

test('설정저장_모든묶음뒤1회', async () => {
  // Given: 두 묶음으로 나뉘는 실행시간
  const events = [];
  const store = memoryConfig({});
  const fetchImpl = fakeFetch(RESULT_OK);

  // When
  await sync(store, {
    parseLogs: fakeParser({ runtimes: runtimesOf(10_001) }),
    fetchImpl: (...args) => { events.push('fetch'); return fetchImpl(...args); },
    writeConfig: (cfg) => { events.push('write'); store.writeConfig(cfg); },
  });

  // Then: 두 요청이 끝난 뒤 한 번만 저장
  assert.deepEqual(events, ['fetch', 'fetch', 'write']);
});

// ─── 7. 사용자 유형 흐름 ────────────────────────────────────────────────────

/** 같은 설정 파일로 이틀 연속 sync하고 각 실행의 파싱 범위를 돌려준다. */
async function syncTwice(store, { firstFetch = fakeFetch(RESULT_OK) } = {}) {
  const ranges = [];
  for (const [today, fetchImpl] of [[TODAY, firstFetch], [NEXT_DAY, fakeFetch(RESULT_OK)]]) {
    const parseLogs = fakeParser();
    await sync(store, { parseLogs, today, fetchImpl });
    ranges.push(...parseLogs.ranges);
  }
  return ranges;
}

test('새사용자_1회차둘다전체_2회차둘다lastSyncDate부터', async () => {
  // Given: 날짜·버전 기록이 없는 설정
  const store = fileConfig({ deviceId: DEVICE_ID });

  // When
  const ranges = await syncTwice(store);

  // Then
  assert.deepEqual(ranges, [
    { tokenFrom: null, runtimeFrom: null },
    { tokenFrom: TODAY, runtimeFrom: TODAY },
  ]);
});

test('1회차실행시간미완료_2회차실행시간전체', async () => {
  // Given: 지금 버전으로 보낸 기록이 있는 설정, 1회차 응답에 결과 본문이 없음(롤백한 옛 API)
  const store = fileConfig({ deviceId: DEVICE_ID, lastSyncDate: LAST, lastSyncVersion: VERSION });

  // When
  const ranges = await syncTwice(store, { firstFetch: fakeFetch({ status: 200 }) });

  // Then: 2회차는 토큰만 lastSyncDate부터, 실행시간은 전체
  assert.deepEqual(ranges, [
    { tokenFrom: LAST, runtimeFrom: LAST },
    { tokenFrom: TODAY, runtimeFrom: null },
  ]);
});

test('기존사용자업데이트_1회차실행시간만전체_2회차둘다lastSyncDate부터', async () => {
  // Given: 2026.8.1까지의 CLI가 남긴 lastSyncDate만 있는 설정
  const store = fileConfig({ deviceId: DEVICE_ID, lastSyncDate: LAST });

  // When
  const ranges = await syncTwice(store);

  // Then
  assert.deepEqual(ranges, [
    { tokenFrom: LAST, runtimeFrom: null },
    { tokenFrom: TODAY, runtimeFrom: TODAY },
  ]);
});

// ─── 8. 지원 종료 안내 ──────────────────────────────────────────────────────

test('Deprecation헤더_대화형_노란안내1줄', async (t) => {
  // Given: 색을 쓰는 대화형 실행, 두 묶음 응답 모두 Deprecation 헤더
  forceColor(t);

  // When
  const lines = await sync(memoryConfig({}), {
    interactive: true,
    parseLogs: fakeParser({ runtimes: runtimesOf(10_001) }),
    fetchImpl: fakeFetch(DEPRECATED),
  });

  // Then: 노란색 안내가 한 줄만
  const notices = lines.filter((line) => line.includes('deprecated'));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].startsWith('\u001b[33m'), JSON.stringify(notices[0]));
});

test('Deprecation헤더_헤드리스_sync.log용평문1줄', async (t) => {
  // Given: 스케줄러 실행(stdin이 TTY 아님). 래퍼가 stdout·stderr를 ~/.tokenphage/logs/sync.log로 보낸다
  forceColor(t);

  // When
  const lines = await sync(memoryConfig({}), { interactive: false, fetchImpl: fakeFetch(DEPRECATED) });

  // Then: 색 코드 없는 한 줄이 출력(sync.log)에 남는다
  const notices = lines.filter((line) => line.includes('deprecated'));
  assert.equal(notices.length, 1);
  assert.doesNotMatch(notices[0], /\u001b\[/);
});
