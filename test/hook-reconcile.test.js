import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { probeHookRegistration } from '../src/scheduler.js';
import { reconcileHookRegistration } from '../src/hook-reconcile.js';

// auto-sync 등록 정합성 복구의 회귀 테스트.
// execFileSync 대역(run)과 platform을 주입하므로 실제 서브프로세스를 띄우지 않고
// mac/windows/linux 분기가 모두 돈다(ubuntu 단독 CI에서도 동일하게 통과).
//
// 테스트 목록:
//  [조회 - mac]     1. probe_mac등록됨_registered
//                   2. probe_mac113_missing (없는 서비스)
//                   3. probe_mac112_unknown (도메인 없음·SSH)
//                   4. probe_mac명령부재_unknown
//                   5. probe_mac_라벨과도메인을완전일치로조회
//                   6. probe_mac_타임아웃을지정한다
//  [조회 - windows] 7. probe_win등록됨_registered
//                   8. probe_win종료코드1_missing
//                   9. probe_win그외실패_unknown
//                  10. probe_win_작업명완전일치조회
//  [조회 - linux]  11. probe_linux블록있음_registered
//                  12. probe_linux남의항목만_missing
//                  13. probe_linux빈crontab_missing
//                  14. probe_linux읽기실패_unknown
//                  15. probe_linux_타임아웃을지정한다
//  [조회 - 기타]   16. probe_미지원OS_unknown
//  [CLI 시작]      17. reconcile_헤드리스_조회도재등록도안함
//                  18. reconcile_설정꺼짐_조회조차안함
//                  19. reconcile_등록됨_재등록안함
//                  20. reconcile_미등록_재등록하고설정저장
//                  21. reconcile_판정불가_재등록안하고true반환
//                  22. reconcile_재등록실패_에러안내후true반환
//  [배선 가드]     23. index_reconcile를대화형진입에서만호출한다

const TASK_LABEL = 'dev.tokenphage.sync';
const WIN_TASK = 'tokenphage-sync';
const CRON_BLOCK = `# BEGIN ${TASK_LABEL} (managed by tokenphage-cli — do not edit)\n0 4 * * * /bin/sh '/home/u/.tokenphage/run-sync.sh'\n# END ${TASK_LABEL}`;
const INSTALL_META = { platform: 'darwin', method: 'launchd', scheduleSpec: 'daily 04:00' };

/** execFileSync 대역: 호출 인자를 기록하고 미리 정한 결과(정상 반환 또는 throw)를 돌려준다. */
function fakeRun({ stdout = '', throws = null } = {}) {
  const calls = [];
  const run = (file, args, opts) => {
    calls.push({ file, args, opts });
    if (throws) throw throws;
    return stdout;
  };
  run.calls = calls;
  return run;
}

/** status/code를 가진 execFileSync 스타일 에러를 만든다. */
function execError({ status, code, signal, stderr = '' }) {
  return Object.assign(new Error('fake exec failure'), { status, code, signal, stderr });
}

// ─── 조회: macOS ─────────────────────────────────────────────────────────────

test('probeHookRegistration(mac) — 조회가 성공하면 registered다', () => {
  // Given: launchctl print가 정상 종료하는 환경
  const run = fakeRun();

  // When / Then
  assert.equal(probeHookRegistration({ platform: 'darwin', run }), 'registered');
});

test('probeHookRegistration(mac) — 113(없는 서비스)만 확정 미등록이다', () => {
  // Given: launchctl이 113으로 실패
  const run = fakeRun({ throws: execError({ status: 113 }) });

  // When / Then: 재등록 대상
  assert.equal(probeHookRegistration({ platform: 'darwin', run }), 'missing');
});

test('probeHookRegistration(mac) — 112(도메인 없음)는 판정 불가다', () => {
  // Given: SSH 등 비 GUI 세션에서 gui/<uid> 도메인에 접근 못 하는 상황
  const run = fakeRun({ throws: execError({ status: 112 }) });

  // When / Then: 예약이 살아있을 수 있으므로 건드리지 않는다
  assert.equal(probeHookRegistration({ platform: 'darwin', run }), 'unknown');
});

test('probeHookRegistration(mac) — 명령 부재·타임아웃은 판정 불가다', () => {
  // Given / When / Then: launchctl 자체가 없거나 timeout(SIGTERM → status null)
  assert.equal(
    probeHookRegistration({ platform: 'darwin', run: fakeRun({ throws: execError({ code: 'ENOENT' }) }) }),
    'unknown');
  assert.equal(
    probeHookRegistration({ platform: 'darwin', run: fakeRun({ throws: execError({ status: null, signal: 'SIGTERM' }) }) }),
    'unknown');
});

test('probeHookRegistration(mac) — 라벨과 도메인을 완전 일치로 조회한다', () => {
  // Given: 같은 홈에 dev.tokenphage.db-tunnel 같은 다른 작업이 있을 수 있다
  const run = fakeRun();

  // When
  probeHookRegistration({ platform: 'darwin', run });

  // Then: print + gui/<uid>/<정확한 라벨> 형태여야 한다 (prefix·glob 금지)
  const [{ file, args }] = run.calls;
  assert.equal(file, 'launchctl');
  assert.equal(args[0], 'print');
  assert.match(args[1], new RegExp(`^gui/\\d+/${TASK_LABEL.replace(/\./g, '\\.')}$`));
});

test('probeHookRegistration(mac) — 조회에 타임아웃을 지정한다', () => {
  // Given / When: 조회는 CLI 시작을 블로킹하므로 반드시 타임아웃이 있어야 한다
  const run = fakeRun();
  probeHookRegistration({ platform: 'darwin', run });

  // Then
  assert.ok(run.calls[0].opts.timeout > 0);
});

// ─── 조회: Windows ───────────────────────────────────────────────────────────

test('probeHookRegistration(win) — 조회가 성공하면 registered다', () => {
  // Given / When / Then
  assert.equal(probeHookRegistration({ platform: 'win32', run: fakeRun() }), 'registered');
});

test('probeHookRegistration(win) — 종료코드 1은 미등록이다', () => {
  // Given: schtasks가 작업을 못 찾으면 1로 종료한다
  const run = fakeRun({ throws: execError({ status: 1 }) });

  // When / Then
  assert.equal(probeHookRegistration({ platform: 'win32', run }), 'missing');
});

test('probeHookRegistration(win) — 그 외 실패는 판정 불가다', () => {
  // Given / When / Then: 명령 부재나 예상 못 한 코드로 재등록을 시도하지 않는다
  assert.equal(
    probeHookRegistration({ platform: 'win32', run: fakeRun({ throws: execError({ code: 'ENOENT' }) }) }),
    'unknown');
  assert.equal(
    probeHookRegistration({ platform: 'win32', run: fakeRun({ throws: execError({ status: 5 }) }) }),
    'unknown');
});

test('probeHookRegistration(win) — 작업명을 완전 일치로 조회한다', () => {
  // Given / When
  const run = fakeRun();
  probeHookRegistration({ platform: 'win32', run });

  // Then: /Query /TN <정확한 작업명>
  const [{ file, args, opts }] = run.calls;
  assert.equal(file, 'schtasks');
  assert.deepEqual(args, ['/Query', '/TN', WIN_TASK]);
  assert.equal(opts.windowsHide, true); // 헤드리스에서 창이 뜨지 않게
});

// ─── 조회: Linux ─────────────────────────────────────────────────────────────

test('probeHookRegistration(linux) — 우리 블록이 있으면 registered다', () => {
  // Given: crontab에 관리 블록이 존재
  const run = fakeRun({ stdout: CRON_BLOCK });

  // When / Then
  assert.equal(probeHookRegistration({ platform: 'linux', run }), 'registered');
});

test('probeHookRegistration(linux) — 남의 항목만 있으면 미등록이다', () => {
  // Given: 사용자의 다른 cron만 존재
  const run = fakeRun({ stdout: '0 * * * * /usr/bin/other\n' });

  // When / Then
  assert.equal(probeHookRegistration({ platform: 'linux', run }), 'missing');
});

test('probeHookRegistration(linux) — 빈 crontab은 미등록이다', () => {
  // Given: crontab -l이 'no crontab for user'로 실패 (확정된 빈 상태)
  const run = fakeRun({ throws: execError({ status: 1, stderr: 'no crontab for u' }) });

  // When / Then
  assert.equal(probeHookRegistration({ platform: 'linux', run }), 'missing');
});

test('probeHookRegistration(linux) — 읽기 실패는 판정 불가다', () => {
  // Given: 권한·I/O 오류 → readCrontab이 fail-closed로 throw
  const run = fakeRun({ throws: execError({ status: 1, code: 'EACCES', stderr: 'permission denied' }) });

  // When / Then: 예외가 밖으로 새지 않고 unknown으로 흡수돼야 한다
  assert.equal(probeHookRegistration({ platform: 'linux', run }), 'unknown');
});

test('probeHookRegistration(linux) — 조회에 타임아웃을 지정한다', () => {
  // Given / When: 설치 경로와 달리 조회는 CLI 시작을 블로킹한다
  const run = fakeRun({ stdout: CRON_BLOCK });
  probeHookRegistration({ platform: 'linux', run });

  // Then
  assert.ok(run.calls[0].opts.timeout > 0);
});

// ─── 조회: 미지원 OS ─────────────────────────────────────────────────────────

test('probeHookRegistration — 미지원 OS는 throw 대신 판정 불가다', () => {
  // Given / When / Then: 조회 실패로 CLI가 죽지 않아야 한다
  const run = fakeRun();
  assert.equal(probeHookRegistration({ platform: 'aix', run }), 'unknown');
  assert.equal(run.calls.length, 0); // 서브프로세스도 띄우지 않는다
});

// ─── CLI 시작 시 동작 ────────────────────────────────────────────────────────

/** reconcile 의존성 대역. 호출 여부를 세어 부수효과를 검증한다. */
function reconcileDeps({ hookInstalled = true, probe = 'missing', installThrows = null } = {}) {
  const seen = { probe: 0, install: 0, persist: [], errors: [], pauses: 0 };
  return {
    deps: {
      readConfig: () => ({ hookInstalled }),
      probe: () => { seen.probe += 1; return probe; },
      install: async () => {
        seen.install += 1;
        if (installThrows) throw installThrows;
        return INSTALL_META;
      },
      persist: (installed, meta) => seen.persist.push([installed, meta]),
      onError: (title, detail, hint) => seen.errors.push({ title, detail, hint }),
      onPause: async () => { seen.pauses += 1; },
    },
    seen,
  };
}

test('reconcile — 헤드리스에서는 조회도 재등록도 하지 않는다', async () => {
  // Given: 스케줄러가 부른 sync (비 TTY). 여기서 재등록하면 자기 예약을 bootout해 SIGTERM으로 죽는다.
  const { deps, seen } = reconcileDeps({ probe: 'missing' });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: false });

  // Then
  assert.equal(unverified, false);
  assert.equal(seen.probe, 0);
  assert.equal(seen.install, 0);
});

test('reconcile — 설정이 꺼져 있으면 조회조차 하지 않는다', async () => {
  // Given: 사용자가 auto-sync를 끈 상태
  const { deps, seen } = reconcileDeps({ hookInstalled: false, probe: 'missing' });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: true });

  // Then: 의사를 존중하고, 불필요한 서브프로세스도 띄우지 않는다
  assert.equal(unverified, false);
  assert.equal(seen.probe, 0);
  assert.equal(seen.install, 0);
});

test('reconcile — 이미 등록돼 있으면 아무것도 하지 않는다', async () => {
  // Given
  const { deps, seen } = reconcileDeps({ probe: 'registered' });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: true });

  // Then
  assert.equal(unverified, false);
  assert.equal(seen.install, 0);
});

test('reconcile — 미등록이면 재등록하고 설정을 저장한다', async () => {
  // Given: config는 켜짐인데 OS 스케줄러에서 사라진 상태 (이 기능이 막아야 하는 장애)
  const { deps, seen } = reconcileDeps({ probe: 'missing' });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: true });

  // Then: 조용히 복구되고 초록으로 표시할 수 있다
  assert.equal(unverified, false);
  assert.equal(seen.install, 1);
  assert.deepEqual(seen.persist, [[true, INSTALL_META]]);
  assert.equal(seen.errors.length, 0);
});

test('reconcile — 판정 불가면 재등록하지 않고 유보 상태를 알린다', async () => {
  // Given: launchctl 부재·SSH 세션 등
  const { deps, seen } = reconcileDeps({ probe: 'unknown' });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: true });

  // Then: 살아있는 예약을 깨지 않고, 초록으로 단정하지도 않는다
  assert.equal(unverified, true);
  assert.equal(seen.install, 0);
});

test('reconcile — 재등록이 실패하면 안내 후 초록으로 단정하지 않는다', async () => {
  // Given: 권한 문제로 installHook이 throw
  const { deps, seen } = reconcileDeps({ probe: 'missing', installThrows: new Error('permission denied') });

  // When
  const unverified = await reconcileHookRegistration({ ...deps, interactive: true });

  // Then: 실패를 숨기지 않는다 (false를 반환하면 대시보드가 "enabled"를 초록으로 거짓 표시한다)
  assert.equal(unverified, true);
  assert.equal(seen.errors.length, 1);
  assert.match(seen.errors[0].hint, /issues/);        // 이슈 링크 안내
  assert.match(seen.errors[0].hint, /sync\.log/);     // 로그 경로 안내
  assert.equal(seen.pauses, 1);                       // 사용자가 읽을 시간을 준다
});

// ─── 배선 가드 ───────────────────────────────────────────────────────────────

test('index.js — reconcile을 대화형 진입에서만 호출한다', () => {
  // Given: 가장 위험한 회귀는 이 호출이 runSync로 옮겨지는 것이다
  //        (헤드리스에서 자기 예약을 bootout → SIGTERM 자살).
  //        함수 안 isTTY 가드가 1차 방어이고, 이 테스트는 위치 이동을 잡는 트립와이어다.
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const runSyncBody = src.slice(src.indexOf('async function runSync('), src.indexOf('async function runAdvanced('));

  // When / Then: runSync 안에는 호출이 없어야 한다
  assert.doesNotMatch(runSyncBody, /reconcileHookRegistration/);
  assert.match(src, /reconcileHookRegistration\(\)/); // 대화형 진입부에는 있어야 한다
});
