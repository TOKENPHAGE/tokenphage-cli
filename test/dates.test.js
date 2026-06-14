import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDateOf } from '../src/lib/dates.js';

// 테스트 목록
// 1. localDateOf_KST저녁경계타임스탬프_익일로귀속        (성공: P2 핵심 시나리오)
// 2. localDateOf_UTC타임존지정_UTC날짜그대로             (성공)
// 3. localDateOf_자정정각경계_타임존별로다른날짜          (경계)
// 4. localDateOf_시스템로컬기본값_Date게터와일치          (성공: 기본 경로)
// 5. localDateOf_파싱불가입력_null반환                   (실패 입력)

test('localDateOf_KST저녁경계타임스탬프_익일로귀속', () => {
  // Given: UTC 6/9 18:30 = KST 6/10 03:30 (새벽 작업 시간대)
  const ts = '2026-06-09T18:30:00.000Z';

  // When / Then: KST에선 6/10, UTC에선 6/9 — 기존 slice(0,10)은 6/9로 오귀속했다
  assert.equal(localDateOf(ts, 'Asia/Seoul'), '2026-06-10');
  assert.equal(localDateOf(ts, 'UTC'), '2026-06-09');
});

test('localDateOf_UTC타임존지정_UTC날짜그대로', () => {
  // Given: UTC 한낮 — 어떤 기준이든 같은 날
  assert.equal(localDateOf('2026-06-10T12:00:00.000Z', 'UTC'), '2026-06-10');
});

test('localDateOf_자정정각경계_타임존별로다른날짜', () => {
  // Given: KST 자정 정각 (UTC 15:00)
  const ts = '2026-06-09T15:00:00.000Z';

  // Then: KST는 6/10 시작, UTC는 아직 6/9
  assert.equal(localDateOf(ts, 'Asia/Seoul'), '2026-06-10');
  assert.equal(localDateOf(ts, 'UTC'), '2026-06-09');
});

test('localDateOf_시스템로컬기본값_Date게터와일치', () => {
  // Given: 임의 타임스탬프 — 기본 경로(시스템 로컬)는 Date 로컬 게터와 같아야 한다
  const ts = '2026-06-09T18:30:00.000Z';
  const d = new Date(ts);
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // When / Then
  assert.equal(localDateOf(ts), expected);
});

test('localDateOf_파싱불가입력_null반환', () => {
  // Given / When / Then: null, 빈 문자열, 쓰레기 입력 모두 null
  assert.equal(localDateOf(null), null);
  assert.equal(localDateOf(''), null);
  assert.equal(localDateOf('not-a-date'), null);
});
