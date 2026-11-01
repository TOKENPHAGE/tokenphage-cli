import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumRuntimes } from '../src/runtime/timeline.js';

// 테스트 목록 (공통 합산기 — 타임라인 규칙은 이 파일에서만 검사한다)
// 1. sumRuntimes_터미널2개와서브에이전트5개각1시간_7시간                (해피)
// 2. sumRuntimes_턴안간격경계_299999와300000은그대로300001은300000       (경곗값)
// 3. sumRuntimes_턴끝이후와다음질문직전이벤트_0으로계산                  (엣지)
// 4. sumRuntimes_자정을넘는간격_밀리초단위로두날짜에나눔                 (엣지)
// 5. sumRuntimes_서머타임바뀌는날자정_달력자정에서나눔                   (엣지, TZ 고정)
// 6. sumRuntimes_시간순이뒤섞인입력_정렬한결과와같음                     (엣지)
// 7. sumRuntimes_이벤트1개짜리단위_결과없음                              (엣지)
// 8. sumRuntimes_턴첫간격_직전턴모델아닌첫응답모델에귀속                 (엣지)
// 9. sumRuntimes_synthetic응답_건너뛰고직전실제모델유지                  (엣지)
// 10. sumRuntimes_소수밀리초입력_정수로반올림                            (경곗값)

const SOURCE = 'claude';

/** 2026-06-{day} 로컬 시각(epoch ms). 로컬 생성자라 실행 타임존과 무관하게 같은 날짜가 된다. */
function at(h, m, s = 0, ms = 0, day = 10) {
  return new Date(2026, 5, day, h, m, s, ms).getTime();
}

function unit(events) {
  return { source: SOURCE, events };
}

function totalOf(rows) {
  return rows.reduce((sum, r) => sum + r.runtimeMs, 0);
}

/** 1시간 동안 5분(상한과 같은 간격)마다 응답이 오는 턴 하나짜리 실행 단위. */
function hourOfWork(startMs, model = 'claude-opus-4-1') {
  const events = [{ t: startMs, start: true }];
  for (let k = 1; k <= 12; k++) events.push({ t: startMs + k * 300_000, reply: true, model });
  return unit(events);
}

test('sumRuntimes_터미널2개와서브에이전트5개각1시간_7시간', () => {
  // Given: 터미널 2개가 각 1시간, 그중 한 세션이 띄운 서브에이전트 5개가 같은 시간대에 각 1시간
  const units = [
    hourOfWork(at(9, 0)),
    hourOfWork(at(10, 0)),
    ...Array.from({ length: 5 }, () => hourOfWork(at(10, 0))),
  ];

  // When
  const rows = sumRuntimes(units);

  // Then: 겹친 시간도 실행 단위마다 따로 더해 7시간
  assert.deepEqual(rows, [{ date: '2026-06-10', source: SOURCE, model: 'claude-opus-4-1', runtimeMs: 25_200_000 }]);
});

test('sumRuntimes_턴안간격경계_299999와300000은그대로300001은300000', () => {
  // Given / When / Then: 간격 하나는 시작 시점부터 5분까지만 센다
  for (const [gap, expected] of [[299_999, 299_999], [300_000, 300_000], [300_001, 300_000]]) {
    const rows = sumRuntimes([unit([
      { t: at(9, 0), start: true },
      { t: at(9, 0) + gap, reply: true, model: 'm' },
    ])]);
    assert.equal(totalOf(rows), expected, `gap=${gap}`);
  }
});

test('sumRuntimes_턴끝이후와다음질문직전이벤트_0으로계산', () => {
  // Given: 첫 질문 전 기록, 마지막 응답 뒤 훅 요약, 다음 질문 직전 첨부가 섞인 두 턴
  const rows = sumRuntimes([unit([
    { t: at(8, 59, 30) },
    { t: at(9, 0, 0), start: true },
    { t: at(9, 0, 10), reply: true, model: 'm' },
    { t: at(9, 0, 20) },
    { t: at(9, 3, 50) },
    { t: at(9, 4, 0), start: true },
    { t: at(9, 4, 10), reply: true, model: 'm' },
  ])]);

  // Then: 질문부터 마지막 응답까지(10초 + 10초)만 남는다
  assert.equal(totalOf(rows), 20_000);
});

test('sumRuntimes_자정을넘는간격_밀리초단위로두날짜에나눔', () => {
  // Given: 23:59:59.999에 시작해 00:00:00.001에 응답 / 자정 정각에 응답
  const crossing = sumRuntimes([unit([
    { t: at(23, 59, 59, 999), start: true },
    { t: at(0, 0, 0, 1, 11), reply: true, model: 'm' },
  ])]);
  const endsAtMidnight = sumRuntimes([unit([
    { t: at(23, 59, 59, 999), start: true },
    { t: at(0, 0, 0, 0, 11), reply: true, model: 'm' },
  ])]);

  // Then: 23:59:59.999까지는 그날, 00:00:00.000부터는 다음 날
  assert.deepEqual(crossing, [
    { date: '2026-06-10', source: SOURCE, model: 'm', runtimeMs: 1 },
    { date: '2026-06-11', source: SOURCE, model: 'm', runtimeMs: 1 },
  ]);
  assert.deepEqual(endsAtMidnight, [{ date: '2026-06-10', source: SOURCE, model: 'm', runtimeMs: 1 }]);
});

test('sumRuntimes_서머타임바뀌는날자정_달력자정에서나눔', (t) => {
  // Given: 서머타임이 있는 타임존으로 고정(23시간·25시간인 날)
  const originalTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const zoneApplied = new Date(2026, 2, 7, 12).getTimezoneOffset() === 300
      && new Date(2026, 2, 9, 12).getTimezoneOffset() === 240;
    if (!zoneApplied) {
      t.skip('이 플랫폼은 실행 중 TZ 변경을 지원하지 않는다');
      return;
    }
    const gapAround = (y, m, d) => sumRuntimes([unit([
      { t: new Date(y, m, d, 23, 58).getTime(), start: true },
      { t: new Date(y, m, d + 1, 0, 2).getTime(), reply: true, model: 'm' },
    ])]);

    // When: 봄(3/8, 23시간)과 가을(11/1, 25시간) 서머타임 전환일 밤 23:58 ~ 다음 날 00:02
    const spring = gapAround(2026, 2, 8);
    const fall = gapAround(2026, 10, 1);

    // Then: 24시간을 더한 시각이 아니라 달력 자정에서 2분씩 나뉜다
    assert.deepEqual(spring.map((r) => [r.date, r.runtimeMs]), [['2026-03-08', 120_000], ['2026-03-09', 120_000]]);
    assert.deepEqual(fall.map((r) => [r.date, r.runtimeMs]), [['2026-11-01', 120_000], ['2026-11-02', 120_000]]);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('sumRuntimes_시간순이뒤섞인입력_정렬한결과와같음', () => {
  // Given: 같은 이벤트를 시간순과 뒤섞인 순서로 준비
  const ordered = [
    { t: at(9, 0, 0), start: true },
    { t: at(9, 0, 5) },
    { t: at(9, 0, 30), reply: true, model: 'a' },
    { t: at(9, 1, 0), reply: true, model: 'b' },
    { t: at(9, 1, 40), reply: true },
  ];
  const shuffled = [ordered[3], ordered[0], ordered[4], ordered[2], ordered[1]];

  // When / Then
  assert.deepEqual(sumRuntimes([unit(shuffled)]), sumRuntimes([unit(ordered)]));
  assert.equal(totalOf(sumRuntimes([unit(shuffled)])), 100_000);
});

test('sumRuntimes_이벤트1개짜리단위_결과없음', () => {
  // Given / When / Then: 간격이 없으면 줄도 없다
  assert.deepEqual(sumRuntimes([unit([{ t: at(9, 0), start: true, model: 'm' }])]), []);
});

test('sumRuntimes_턴첫간격_직전턴모델아닌첫응답모델에귀속', () => {
  // Given: 직전 턴은 b 모델, 다음 턴은 첨부 기록 뒤 a 모델이 처음 응답
  const rows = sumRuntimes([unit([
    { t: at(9, 0, 0), start: true },
    { t: at(9, 0, 10), reply: true, model: 'b' },
    { t: at(9, 1, 0), start: true },
    { t: at(9, 1, 5) },
    { t: at(9, 1, 10), reply: true, model: 'a' },
    { t: at(9, 1, 20), reply: true, model: 'a' },
  ])]);

  // Then: 질문부터 첫 응답까지(10초)는 a에 들어간다
  assert.deepEqual(rows.map((r) => [r.model, r.runtimeMs]), [['b', 10_000], ['a', 20_000]]);
});

test('sumRuntimes_synthetic응답_건너뛰고직전실제모델유지', () => {
  // Given: 실제 모델 응답 뒤 <synthetic> 응답과 도구 결과 / <synthetic>뿐인 단위
  const rows = sumRuntimes([
    unit([
      { t: at(9, 0, 0), start: true },
      { t: at(9, 0, 10), reply: true, model: 'a' },
      { t: at(9, 0, 20), reply: true, model: '<synthetic>' },
      { t: at(9, 0, 30), reply: true },
    ]),
    unit([
      { t: at(9, 5, 0), start: true },
      { t: at(9, 5, 10), reply: true, model: '<synthetic>' },
    ]),
  ]);

  // Then: <synthetic> 뒤 간격도 a에 들어가고, 모델을 알 수 없는 시간은 버린다
  assert.deepEqual(rows.map((r) => [r.model, r.runtimeMs]), [['a', 30_000]]);
});

test('sumRuntimes_소수밀리초입력_정수로반올림', () => {
  // Given: 소수 ms 시각(서버는 정수 ms만 받는다)
  const rows = sumRuntimes([unit([
    { t: at(9, 0) + 0.25, start: true },
    { t: at(9, 0) + 1000.75, reply: true, model: 'm' },
  ])]);

  // Then
  assert.equal(rows[0].runtimeMs, 1001);
  assert.ok(Number.isInteger(rows[0].runtimeMs));
});
