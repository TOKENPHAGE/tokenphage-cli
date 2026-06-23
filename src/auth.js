import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// 로컬 설정 파일 경로: ~/.tokenphage/config.json (JWT·deviceId·sync 상태 보관)
const CONFIG_DIR = join(homedir(), '.tokenphage');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** config.json을 읽어 객체로 반환한다. 파일이 없거나 손상됐으면 빈 객체. */
export function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

/** config 객체를 config.json에 저장한다. JWT가 담기므로 소유자 전용(0600) 권한으로 기록한다. */
export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows는 chmod 미지원 — 무시 */ }
}

/** 저장된 JWT를 반환한다. 없으면 null. */
export function loadToken() {
  return loadConfig().token ?? null;
}

/** 다른 설정은 보존한 채 JWT만 갱신해 저장한다. */
export function saveToken(token) {
  saveConfig({ ...loadConfig(), token });
}

/** 기기 식별용 deviceId(UUID)를 반환한다. 없으면 새로 발급·저장한 뒤 반환한다. */
export function getOrCreateDeviceId() {
  const cfg = loadConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const deviceId = randomUUID();
  saveConfig({ ...cfg, deviceId });
  return deviceId;
}

/**
 * 훅 설치 상태를 설정에 기록한다.
 * 설치 시 설치 시각(ISO)과 메타데이터를 함께 저장하고, 해제 시 둘 다 null로 비운다.
 */
export function setHookInstalled(installed, meta = {}) {
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    hookInstalled: installed,
    hookInstalledAt: installed ? new Date().toISOString() : null,
    hookMeta: installed ? meta : null,
  });
}

/** config.json의 claudePaths(사용자 지정 Claude 디렉터리 목록)를 반환한다. 비배열이면 빈 배열. */
export function getCustomClaudePaths() {
  const paths = loadConfig().claudePaths;
  return Array.isArray(paths) ? paths : [];
}

/** 마지막 sync 완료 날짜(YYYY-MM-DD)를 반환한다. 없으면 null. */
export function getLastSyncDate() { return loadConfig().lastSyncDate ?? null; }

/** 마지막 sync 날짜를 저장한다. 다음 sync는 이 날짜 이후만 증분 파싱한다. */
export function saveLastSyncDate(date) {
  saveConfig({ ...loadConfig(), lastSyncDate: date });
}

/** lastSyncDate를 제거해 다음 sync가 전체 히스토리를 재파싱하도록 한다. token/deviceId는 보존. */
export function clearLastSyncDate() {
  const { lastSyncDate: _omit, ...rest } = loadConfig();
  saveConfig(rest);
}

/** 업데이트 캐시(npm 최신버전·마지막 조회시각)를 반환한다. 없으면 각각 null. */
export function getUpdateCache() {
  const cfg = loadConfig();
  return { latestVersion: cfg.latestVersion ?? null, lastUpdateCheck: cfg.lastUpdateCheck ?? null };
}

/** npm 최신버전과 조회시각(ISO)을 다른 설정을 보존한 채 갱신 저장한다. */
export function saveUpdateCache(latestVersion, lastUpdateCheck) {
  saveConfig({ ...loadConfig(), latestVersion, lastUpdateCheck });
}

// Gist 소유권 검증용 파일명 — 사용자가 이 이름으로 Gist를 만들어야 한다.
export const VERIFICATION_FILE = 'tokenphage.txt';

/**
 * Gist URL 또는 원본 ID에서 gist ID만 추출한다.
 *   https://gist.github.com/octocat/abc123def456 → abc123def456
 *   https://gist.github.com/abc123def456         → abc123def456
 *   abc123def456                                  → abc123def456
 */
export function parseGistId(input) {
  if (!input) return '';
  const trimmed = input.trim();
  // URL이면 (사용자명/) 뒤의 ID 토큰만 캡처하고, 그 외에는 앞뒤 슬래시만 제거한다.
  const match = trimmed.match(/gist\.github\.com\/(?:[^/]+\/)?([A-Za-z0-9]+)/);
  if (match) return match[1];
  return trimmed.replace(/^\/+|\/+$/g, '');
}

/** url에 JSON body를 POST하고 {ok, status, body}를 반환한다. 응답이 JSON이 아니면 {error: 원문}으로 감싼다. */
async function postJson(url, body) {
  // Node 18+ 전역 fetch 사용 (node-fetch 의존성 불필요).
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; } // 비JSON 응답 방어
  return { ok: res.ok, status: res.status, body: parsed };
}

/** 질문을 출력하고 표준입력 한 줄을 받아 trim한 문자열로 resolve한다. (readline 지연 로드) */
function prompt(question) {
  return import('readline').then(({ default: readline }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
    });
  });
}

/** ISO 문자열을 로컬 'YYYY-MM-DD HH:mm'로 포맷한다. */
function formatExpiry(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso; // 파싱 실패 시 원문 그대로 (방어)
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Gist 기반 로그인: 챌린지 발급 → 사용자가 Gist 생성 → 검증 → JWT 반환.
 * username이 없으면 입력을 요청한다.
 *
 * @param {string} apiBase API 서버 base URL
 * @param {string} [username] GitHub 사용자명 (생략 시 프롬프트로 입력)
 * @returns {Promise<string>} 발급된 JWT
 */
export async function gistLogin(apiBase, username) {
  if (!username) {
    username = await prompt('GitHub username: ');
  }
  if (!username) throw new Error('Username is required.');

  // 1) 서버에 챌린지 요청 — 사용자가 Gist에 적을 검증 문자열을 받는다.
  const challengeRes = await postJson(`${apiBase}/auth/challenge`, { username });
  if (!challengeRes.ok) {
    throw new Error(`Challenge request failed: ${challengeRes.status} ${JSON.stringify(challengeRes.body)}`);
  }
  const { challenge, expiresAt } = challengeRes.body ?? {};
  if (!challenge) {
    throw new Error(`Unexpected challenge response: ${JSON.stringify(challengeRes.body)}`);
  }

  // 2) 사용자에게 public Gist 생성 절차를 안내한다.
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Create a public Gist to prove ownership of your GitHub account.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`  1) Go to https://gist.github.com/new`);
  console.log(`  2) Filename:  ${VERIFICATION_FILE}`);
  console.log(`     Content:`);
  console.log('');
  console.log(`         ${challenge}`);
  console.log('');
  console.log(`  3) Click "Create public gist" (NOT Secret gist!)`);
  console.log(`  4) Paste the generated Gist URL or ID below`);
  console.log('');
  console.log(`  Expires: ${formatExpiry(expiresAt)}`);
  console.log('');

  // 브라우저로 Gist 작성 페이지를 자동으로 열어준다 (실패해도 위 안내대로 수동 진행 가능).
  try {
    const { default: open } = await import('open');
    await open('https://gist.github.com/new');
  } catch { /* 브라우저 자동 실행 실패는 무시 */ }

  // 3) 사용자가 만든 Gist의 URL/ID를 입력받아 ID만 추출한다.
  const rawInput = await prompt('Gist URL or ID: ');
  const gistId = parseGistId(rawInput);
  if (!gistId) throw new Error('Could not parse a Gist ID from the input.');

  // 4) 서버에 검증 요청 — Gist 내용이 챌린지와 일치하면 JWT를 발급받는다.
  const verifyRes = await postJson(`${apiBase}/auth/verify`, { username, gistId });
  if (!verifyRes.ok) {
    const err = verifyRes.body?.error ?? 'unknown';
    throw new Error(`Verification failed (${verifyRes.status}): ${err}`);
  }
  const { token, githubId, username: confirmedUsername } = verifyRes.body ?? {};
  if (!token) {
    throw new Error(`Verification response missing token: ${JSON.stringify(verifyRes.body)}`);
  }
  console.log('');
  console.log(`[OK] Authenticated as ${confirmedUsername} (github_id=${githubId})`);
  return token;
}
