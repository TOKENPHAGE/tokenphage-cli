/**
 * CLI 업데이트 검사: npm 레지스트리에서 최신버전을 조회해 config.json에 캐시하고,
 * 현재 버전과 비교해 업데이트 여부를 판정한다.
 *
 * 설계 원칙
 *  - 화면(메인 대시보드)은 캐시(getUpdateInfo)만 읽어 즉시 렌더 → startup 지연 0.
 *  - 네트워크 조회(refreshCache)는 백그라운드/sync 시점에 돌아 캐시를 채우고, 결과는 "다음 렌더"에 반영된다.
 *  - 어떤 실패(네트워크·404·파싱·옵트아웃)도 조용히 흘려보내 본 기능(대시보드)을 절대 막지 않는다.
 */
import { loadConfig, saveUpdateCache } from '../auth.js';

// 배포 패키지명 — 레지스트리 URL과 `npm i -g` 대상에서 공유한다.
export const PACKAGE_NAME = 'tokenphage';
// npm 레지스트리 latest 매니페스트(공개·무인증). { "version": "", ... } 반환, 미배포면 404.
export const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h TTL — 하루 1회만 조회
const FETCH_TIMEOUT_MS = 2500;                 // 레지스트리 지연이 sync를 끌지 않도록 상한

/**
 * CalVer "YYYY.M.PATCH" 두 버전을 숫자 3파트로 비교한다.
 * @returns {-1|0|1} a<b → -1, a==b → 0, a>b → 1. 어느 한쪽이라도 비숫자(dev 등)면 0(=차이 없음)으로 안전 폴백.
 */
export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  // CalVer는 정확히 3파트여야 한다. 형식이 어긋나면(2파트/4파트/dev 등) 비교 불가로 보고 0(=업데이트 없음) 폴백.
  if (pa.length !== 3 || pb.length !== 3) return 0;
  for (let i = 0; i < 3; i++) {
    const x = pa[i];
    const y = pb[i];
    if (Number.isNaN(x) || Number.isNaN(y)) return 0; // 비CalVer → 비교 불가 → 업데이트 없음
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * 마지막 조회 이후 TTL(24h)이 지났는지 판정한다. now는 인자로 주입해 테스트 결정성을 확보한다.
 * @param {string|null} lastUpdateCheck 마지막 조회 ISO 시각 (없으면 null)
 * @param {number} now 현재 epoch ms
 * @returns {boolean} 조회가 필요하면 true
 */
export function shouldCheck(lastUpdateCheck, now) {
  if (!lastUpdateCheck) return true;
  const last = Date.parse(lastUpdateCheck);
  if (Number.isNaN(last)) return true; // 손상된 시각 → 재조회
  return now - last >= CHECK_INTERVAL_MS;
}

/** 업데이트 알림을 끄는 환경인지. 옵트아웃 env 또는 dev(TOKENPHAGE_API 세팅)면 조회·표시 모두 스킵. */
export function isUpdateNotifierDisabled() {
  return !!process.env.TOKENPHAGE_NO_UPDATE_NOTIFIER || !!process.env.TOKENPHAGE_API;
}

/**
 * 캐시(cfg.latestVersion)와 현재 버전을 비교해 업데이트 정보를 반환한다. 네트워크를 쓰지 않는 동기 함수.
 * @param {string} currentVersion 현재 설치 버전(package.json)
 * @param {object} cfg loadConfig() 결과(또는 동등한 객체)
 * @returns {{hasUpdate:boolean, latest?:string, current?:string}}
 */
export function getUpdateInfo(currentVersion, cfg) {
  if (isUpdateNotifierDisabled()) return { hasUpdate: false };
  const latest = cfg?.latestVersion;
  if (!latest) return { hasUpdate: false };
  if (compareVersion(latest, currentVersion) > 0) {
    return { hasUpdate: true, latest, current: currentVersion };
  }
  return { hasUpdate: false };
}

/** npm 레지스트리에서 latest 버전 문자열을 조회한다. 실패(타임아웃·404·파싱)는 모두 null. */
async function fetchLatestFromNpm() {
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

/**
 * TTL이 지났으면 npm 최신버전을 조회해 config 캐시를 갱신한다. 절대 throw하지 않는다.
 * @param {number} now 현재 epoch ms (Date.now()를 주입)
 */
export async function refreshCache(now) {
  try {
    if (isUpdateNotifierDisabled()) return;
    const cfg = loadConfig();
    if (!shouldCheck(cfg.lastUpdateCheck, now)) return;
    const latest = await fetchLatestFromNpm();
    if (!latest) return;
    saveUpdateCache(latest, new Date(now).toISOString());
  } catch {
    // 캐시 갱신 실패는 무해 — 다음 기회에 재시도한다.
  }
}
