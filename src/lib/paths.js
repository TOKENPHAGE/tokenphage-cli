import { join, resolve } from 'path';

// AI 도구별 로컬 디렉터리 후보를 우선순위 순으로 만든다.
//  - Claude: 설정(config) 디렉터리. 기본(~/.claude) → XDG($XDG_CONFIG_HOME/claude) → 사용자 지정.
//  - opencode: 데이터(data) 디렉터리. XDG($XDG_DATA_HOME, 기본 ~/.local/share)/opencode → 사용자 지정.
//    (opencode는 세션을 <data>/opencode/storage/... 에 저장하므로 config가 아니라 data home 기준이다.)

function expandTilde(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

// 후보 경로들을 절대경로로 normalize하고 순서를 유지한 채 중복을 제거한다.
function normalizeUnique(candidates) {
  const seen = new Set();
  const dirs = [];
  for (const candidate of candidates) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    dirs.push(normalized);
  }
  return dirs;
}

// 외부 입력(config.json 등)의 customPaths를 검증한다: 문자열 배열만 인정, 틸드는 home으로 확장.
function cleanCustomPaths(customPaths, home) {
  if (!Array.isArray(customPaths)) return [];
  return customPaths
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => expandTilde(p.trim(), home));
}

/**
 * Claude 설정 디렉터리 후보 목록을 우선순위 순으로 반환한다.
 * 순서: 기본(~/.claude) → XDG($XDG_CONFIG_HOME/claude, 기본 ~/.config/claude) → 사용자 지정.
 * @param {{ home: string, xdgConfigHome?: string, customPaths?: string[] }} opts
 *   home: 사용자 홈, xdgConfigHome: $XDG_CONFIG_HOME, customPaths: config.json의 claudePaths
 * @returns {string[]} normalize·중복 제거된 절대 경로 목록
 */
export function resolveClaudeDirs({ home, xdgConfigHome, customPaths } = {}) {
  const xdgBase = typeof xdgConfigHome === 'string' && xdgConfigHome.trim()
    ? xdgConfigHome
    : join(home, '.config');

  return normalizeUnique([
    join(home, '.claude'),
    join(xdgBase, 'claude'),
    ...cleanCustomPaths(customPaths, home),
  ]);
}

/**
 * opencode 데이터 디렉터리 후보 목록을 우선순위 순으로 반환한다.
 * 순서: XDG($XDG_DATA_HOME/opencode, 기본 ~/.local/share/opencode) → 사용자 지정.
 * Claude(config home 기준)와 달리 data home 기준임에 주의.
 * @param {{ home: string, xdgDataHome?: string, customPaths?: string[] }} opts
 *   home: 사용자 홈, xdgDataHome: $XDG_DATA_HOME, customPaths: 사용자 지정 opencode 디렉터리
 * @returns {string[]} normalize·중복 제거된 절대 경로 목록
 */
export function resolveOpencodeDirs({ home, xdgDataHome, customPaths } = {}) {
  const xdgBase = typeof xdgDataHome === 'string' && xdgDataHome.trim()
    ? xdgDataHome
    : join(home, '.local', 'share');

  return normalizeUnique([
    join(xdgBase, 'opencode'),
    ...cleanCustomPaths(customPaths, home),
  ]);
}
