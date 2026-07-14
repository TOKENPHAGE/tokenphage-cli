/**
 * CLI 업데이트 검사: TUI(대시보드) 진입 시 npm 레지스트리에서 latest를 1회 조회하고,
 * 현재 버전과 문자열이 다르면 업데이트가 있다고 판정한다.
 *
 * 설계 원칙
 *  - update 제안은 대화형 TUI에서만 뜬다. 비대화형(sync·스크립트)은 대상 아님 → 캐시/TTL 불필요.
 *  - checkLatestVersion()을 TUI 진입 시 1회 await로 호출(짧은 타임아웃), 결과를 세션 메모리에 담아 배너 판정에 쓴다.
 *  - 어떤 실패(네트워크·404·파싱·옵트아웃)도 조용히 null로 흘려보내 대시보드를 절대 막지 않는다.
 */

// 배포 패키지명 — 레지스트리 URL과 `npm i -g` 대상에서 공유한다.
export const PACKAGE_NAME = 'tokenphage';
// npm 레지스트리 latest 매니페스트(공개·무인증). { "version": "", ... } 반환, 미배포면 404.
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

const FETCH_TIMEOUT_MS = 1500; // TUI 진입 조회 상한 — 오프라인/지연 시 이 시간 후 배너 없이 진행

/** 업데이트 알림을 끄는 환경인지. 옵트아웃 env 또는 dev(TOKENPHAGE_API 세팅)면 조회·표시 모두 스킵. */
export function isUpdateNotifierDisabled() {
  return !!process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER || !!process.env.TOKENPHAGE_API;
}

/**
 * 조회한 latest와 현재 버전을 비교해 업데이트 정보를 반환한다. 순수 함수(네트워크·env·캐시 없음).
 * update 액션은 항상 `@latest`를 설치하므로 "설치본 ≠ latest"가 곧 "업데이트하면 바뀜"과 일치한다.
 * 프리릴리스 접미사(-BETA)도 파싱 없이 문자열 비교라 안전하다.
 * @param {string} currentVersion 현재 설치 버전(package.json)
 * @param {string|null|undefined} latest checkLatestVersion() 결과(조회 실패/옵트아웃 시 null)
 * @returns {{hasUpdate:boolean, latest?:string, current?:string}}
 */
export function getUpdateInfo(currentVersion, latest) {
  if (latest && latest !== currentVersion) {
    return { hasUpdate: true, latest, current: currentVersion };
  }
  return { hasUpdate: false };
}

/**
 * npm 레지스트리에서 latest 버전 문자열을 1회 조회한다. TUI 진입 시 한 번 await로 호출해 세션 동안 재사용한다.
 * 옵트아웃/실패(타임아웃·404·파싱)는 모두 null — 절대 throw하지 않는다.
 * @returns {Promise<string|null>}
 */
export async function checkLatestVersion() {
  if (isUpdateNotifierDisabled()) return null; // 옵트아웃/dev → 조회 스킵
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch {
    return null; // 네트워크 단절·abort·비JSON 등 — 조용히 무시
  } finally {
    clearTimeout(timer);
  }
}
