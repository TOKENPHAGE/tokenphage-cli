import { localDateOf } from '../lib/dates.js';

// 공통 타임라인 합산기. 세 소스의 추출기가 만든 실행 단위를 같은 규칙으로 더한다.
//  - 실행 단위마다 이벤트를 시간순으로 정렬하고, 턴(시작 ~ 마지막 응답·도구 결과) 안의 간격만 센다.
//  - 간격 하나는 시작 시점부터 GAP_CAP_MS까지만 센다.
//  - 로컬 자정에서 나눠 날짜별로 넣고, 간격이 시작될 때 일하던 모델에 귀속한다.

/** 간격 하나에서 세는 최대 길이(ms). */
const GAP_CAP_MS = 300_000;

/**
 * 실행시간 계산용 이벤트.
 * @typedef {object} RuntimeEvent
 * @property {number} t 시각(epoch ms)
 * @property {boolean} [start] 턴 시작
 * @property {boolean} [reply] AI 응답 또는 도구 결과(턴 끝 후보)
 * @property {string|null} [model] 이 이벤트에서 일한 모델
 */

/**
 * 메인 세션·서브에이전트처럼 따로 계산해서 더하는 실행 단위.
 * @typedef {{ source: 'claude'|'codex'|'opencode', events: RuntimeEvent[] }} RuntimeUnit
 */

/** <synthetic>처럼 '<'로 시작하는 값은 모델로 치지 않는다(토큰 파서와 같은 기준). */
function isRealModel(model) {
  return typeof model === 'string' && model !== '' && !model.startsWith('<');
}

// (날짜, 소스, 모델)별 누적기. 직전에 쓴 날짜 범위를 캐시해 자정 계산을 줄인다.
function createBuckets() {
  const totals = new Map();
  let dayStart = Infinity;
  let dayEnd = -Infinity;
  let date = '';

  // 자정은 달력 연산으로 구해 서머타임 전환일(23·25시간)도 맞게 나눈다.
  const moveTo = (ms) => {
    const d = new Date(ms);
    dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    date = localDateOf(d);
  };

  const add = (source, model, from, to) => {
    for (let a = from; a < to;) {
      if (a < dayStart || a >= dayEnd) moveTo(a);
      const b = dayEnd > a ? Math.min(to, dayEnd) : to; // 날짜 계산이 어긋나도 반복이 멈추게 한다
      const key = `${date}\u0000${source}\u0000${model}`;
      const row = totals.get(key);
      if (row) row.runtimeMs += b - a;
      else totals.set(key, { date, source, model, runtimeMs: b - a });
      a = b;
    }
  };

  const rows = () => Array.from(totals.values(), (row) => ({ ...row, runtimeMs: Math.round(row.runtimeMs) }))
    .filter((row) => row.runtimeMs > 0);

  return { add, rows };
}

// 턴 [from, to] 안의 간격을 더하고, 다음 턴에 넘길 마지막 실제 모델을 돌려준다.
// 첫 간격은 첫 응답의 모델, 이후 간격은 간격이 시작될 때의 모델에 넣는다.
function sumTurn(events, from, to, carried, source, buckets) {
  let model = carried;
  for (let k = from; k <= to; k++) {
    if (isRealModel(events[k].model)) { model = events[k].model; break; }
  }
  for (let k = from; k < to; k++) {
    if (isRealModel(events[k].model)) model = events[k].model;
    if (model === null) continue; // 모델을 알 수 없는 시간은 귀속할 곳이 없다
    const begin = events[k].t;
    buckets.add(source, model, begin, Math.min(events[k + 1].t, begin + GAP_CAP_MS));
  }
  return isRealModel(events[to].model) ? events[to].model : model;
}

function sumUnit(unit, buckets) {
  const events = (unit.events ?? []).filter((e) => Number.isFinite(e?.t)).sort((x, y) => x.t - y.t);
  let carried = null;
  let i = events.findIndex((e) => e.start);
  if (i < 0) return;
  while (i < events.length) {
    let next = i + 1;
    while (next < events.length && !events[next].start) next++;
    let last = next - 1;
    while (last >= i && !events[last].reply) last--;
    if (last >= i) carried = sumTurn(events, i, last, carried, unit.source, buckets);
    i = next;
  }
}

/**
 * 실행시간 줄을 (날짜, 소스, 모델) 키로 더해 모은다.
 * @param {Map<string, { date: string, source: string, model: string, runtimeMs: number }>} totals 누적 대상
 * @param {Array<{ date: string, source: string, model: string, runtimeMs: number }>} rows
 */
export function addRuntimeRows(totals, rows) {
  for (const row of rows) {
    const key = `${row.date}\u0000${row.source}\u0000${row.model}`;
    const current = totals.get(key);
    if (current) current.runtimeMs += row.runtimeMs;
    else totals.set(key, { ...row });
  }
}

/**
 * 실행 단위들의 이벤트로 (날짜, 소스, 모델)별 실행시간을 계산한다.
 * @param {RuntimeUnit[]} units
 * @returns {Array<{ date: string, source: string, model: string, runtimeMs: number }>} runtimeMs는 0 초과 정수
 */
export function sumRuntimes(units) {
  const buckets = createBuckets();
  for (const unit of units) sumUnit(unit, buckets);
  return buckets.rows();
}
