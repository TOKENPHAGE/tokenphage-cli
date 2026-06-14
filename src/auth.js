import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const CONFIG_DIR = join(homedir(), '.tokenphage');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* ignored on Windows */ }
}

export function loadToken() { return loadConfig().token ?? null; }

export function saveToken(token) {
  saveConfig({ ...loadConfig(), token });
}

export function getOrCreateDeviceId() {
  const cfg = loadConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const deviceId = randomUUID();
  saveConfig({ ...cfg, deviceId });
  return deviceId;
}

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

export function getLastSyncDate() { return loadConfig().lastSyncDate ?? null; }

export function saveLastSyncDate(date) {
  saveConfig({ ...loadConfig(), lastSyncDate: date });
}

/** lastSyncDate를 제거해 다음 sync가 전체 히스토리를 재파싱하도록 한다. token/deviceId는 보존. */
export function clearLastSyncDate() {
  const { lastSyncDate: _omit, ...rest } = loadConfig();
  saveConfig(rest);
}

export const VERIFICATION_FILE = 'tokenphage.txt';

/**
 * Extract gist ID from a gist URL or raw ID.
 *   https://gist.github.com/octocat/abc123def456 → abc123def456
 *   https://gist.github.com/abc123def456         → abc123def456
 *   abc123def456                                    → abc123def456
 */
export function parseGistId(input) {
  if (!input) return '';
  const trimmed = input.trim();
  const match = trimmed.match(/gist\.github\.com\/(?:[^/]+\/)?([A-Za-z0-9]+)/);
  if (match) return match[1];
  return trimmed.replace(/^\/+|\/+$/g, '');
}

async function postJson(url, body) {
  // Node 18+ 전역 fetch 사용 (node-fetch 의존성 불필요).
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { ok: res.ok, status: res.status, body: parsed };
}

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
 * Gist-based auth: issue challenge → user creates gist → verify → return JWT.
 * Prompts for username if not provided.
 */
export async function gistLogin(apiBase, username) {
  if (!username) {
    username = await prompt('GitHub username: ');
  }
  if (!username) throw new Error('Username is required.');

  const challengeRes = await postJson(`${apiBase}/auth/challenge`, { username });
  if (!challengeRes.ok) {
    throw new Error(`Challenge request failed: ${challengeRes.status} ${JSON.stringify(challengeRes.body)}`);
  }
  const { challenge, expiresAt } = challengeRes.body ?? {};
  if (!challenge) {
    throw new Error(`Unexpected challenge response: ${JSON.stringify(challengeRes.body)}`);
  }

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

  try {
    const { default: open } = await import('open');
    await open('https://gist.github.com/new');
  } catch { /* browser open failure is ignored */ }

  const rawInput = await prompt('Gist URL or ID: ');
  const gistId = parseGistId(rawInput);
  if (!gistId) throw new Error('Could not parse a Gist ID from the input.');

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
