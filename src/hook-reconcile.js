/**
 * auto-sync 등록 정합성 복구.
 * 설정(config.json)은 켜짐인데 OS 스케줄러에서 예약이 사라진 경우를 감지해 다시 등록한다.
 *
 * index.js가 아니라 별 모듈인 이유: index.js는 최상단에서 program.parse()를 실행하므로
 * 테스트가 import하는 순간 CLI가 시동된다. lib/가 아닌 이유는 ui.js에 의존해
 * 순수 로직 계층 규약에 맞지 않기 때문이다.
 */
import { loadConfig, setHookInstalled } from './auth.js';
import { installHook, probeHookRegistration } from './scheduler.js';
import { showError, pauseForEnter } from './ui.js';

const ISSUE_HINT =
  'Log: ~/.tokenphage/logs/sync.log — please report it: https://github.com/TOKENPHAGE/tokenphage-cli/issues';

/**
 * 설정은 auto-sync 켜짐인데 OS 스케줄러에 등록이 없으면 재등록한다.
 *
 * 헤드리스에서는 절대 재등록하지 않는다 — installMac()이 첫 단계로
 * launchctlBootout()을 호출하는데, 그 프로세스가 바로 해당 launchd job이라 자기 자신을 내려
 * SIGTERM으로 죽고 plist 작성에 도달하지 못한다. 그래서 호출 위치에만 의존하지 않고
 * 함수 안에서 isTTY를 직접 확인해 구조적으로 막는다.
 *
 * 의존성은 전부 기본값으로 실제 구현이 배선돼 있다 — 호출부는 인자 없이 부르고 테스트만 대체한다.
 * @param {{interactive?: boolean, readConfig?: Function, probe?: Function, install?: Function,
 *          persist?: Function, onError?: Function, onPause?: Function}} [deps]
 * @returns {Promise<boolean>} 등록을 초록으로 단정할 수 없으면 true (확인 불가 또는 재등록 실패)
 */
export async function reconcileHookRegistration({
  interactive = Boolean(process.stdin.isTTY),
  readConfig = loadConfig,
  probe = probeHookRegistration,
  install = installHook,
  persist = setHookInstalled,
  onError = showError,
  onPause = pauseForEnter,
} = {}) {
  if (!interactive) return false;                          // 헤드리스: 자기 예약을 건드리지 않는다
  if (readConfig().hookInstalled !== true) return false;   // 꺼짐(사용자 의사): 조회조차 하지 않는다

  const state = probe();
  if (state === 'registered') return false;
  if (state === 'unknown') return true;                    // 판정 불가에서 재등록하면 정상 예약을 깬다

  try {
    persist(true, await install());                        // installHook은 멱등이라 그대로 재사용한다
    return false;
  } catch (err) {
    onError('Auto-sync re-registration failed', err.message, ISSUE_HINT);
    await onPause();
    return true;                                           // 실패했으므로 초록으로 단정하지 않는다
  }
}
