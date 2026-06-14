import { join, resolve } from 'path';

// Claude 설정 디렉터리 후보를 우선순위 순으로 만든다.
// 순서: 기본(~/.claude) → XDG($XDG_CONFIG_HOME/claude, 기본 ~/.config/claude) → 사용자 지정.

function expandTilde(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return p;
}

/**
 * Claude 설정 디렉터리 후보 목록을 우선순위 순으로 반환한다.
 * @param {{ home: string, xdgConfigHome?: string, customPaths?: string[] }} opts
 *   home: 사용자 홈, xdgConfigHome: $XDG_CONFIG_HOME, customPaths: config.json의 claudePaths
 * @returns {string[]} normalize·중복 제거된 절대 경로 목록
 */
export function resolveClaudeDirs({ home, xdgConfigHome, customPaths } = {}) {
  const xdgBase = typeof xdgConfigHome === 'string' && xdgConfigHome.trim()
    ? xdgConfigHome
    : join(home, '.config');

  // 외부 입력(config.json) 검증: 문자열 배열만 인정, 그 외는 통째로 무시
  const custom = Array.isArray(customPaths)
    ? customPaths.filter((p) => typeof p === 'string' && p.trim())
    : [];

  const candidates = [
    join(home, '.claude'),
    join(xdgBase, 'claude'),
    ...custom.map((p) => expandTilde(p.trim(), home)),
  ];

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
