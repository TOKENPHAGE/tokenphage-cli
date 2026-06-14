import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

// Claude Code의 cleanupPeriodDays(트랜스크립트 보존 기간) 검사·설정.
// 규칙은 하나: 99999 이상이면 통과, 아니면 동의를 받아 무조건 99999로 설정한다.
// (0=off는 Claude Code가 거부하므로 큰 값으로 무력화하는 방식)
// 손상된 설정 파일은 절대 건드리지 않는다.

export const FOREVER_DAYS = 99999;

// Claude Code가 cleanupPeriodDays 미설정 시 적용하는 기본 보존 일수.
// 미설정 사용자에게 "실제로 무슨 일이 일어나는지"를 보여주기 위한 표시용 상수.
export const DEFAULT_CLEANUP_DAYS = 30;

// 후보 중 실제 사용 중인 설정 디렉터리: projects/가 존재하는 첫 dir, 없으면 첫 후보.
function pickActiveClaudeDir(claudeDirs) {
  return claudeDirs.find((dir) => existsSync(join(dir, 'projects'))) ?? claudeDirs[0];
}

/**
 * 사용 중인 Claude 설정 디렉터리의 cleanupPeriodDays가 99999 이상인지 검사한다.
 * @param {string[]} claudeDirs resolveClaudeDirs() 결과 (우선순위 순)
 * @returns {{ needed: boolean, settingsPath: string, corrupted: boolean, currentValue: number | null }}
 *   needed: 설정이 필요한지(99999 미만/미설정/손상), corrupted: settings.json 파싱 실패 여부,
 *   currentValue: 현재 설정된 cleanupPeriodDays 숫자값 (미설정·파일없음·손상이면 null — 호출부가 기본값으로 표시)
 */
export function checkClaudeRetention(claudeDirs) {
  const settingsPath = join(pickActiveClaudeDir(claudeDirs), 'settings.json');

  if (!existsSync(settingsPath)) {
    return { needed: true, settingsPath, corrupted: false, currentValue: null };
  }
  try {
    const value = JSON.parse(readFileSync(settingsPath, 'utf8')).cleanupPeriodDays;
    const currentValue = typeof value === 'number' ? value : null;
    const isForever = currentValue !== null && currentValue >= FOREVER_DAYS;
    return { needed: !isForever, settingsPath, corrupted: false, currentValue };
  } catch {
    return { needed: true, settingsPath, corrupted: true, currentValue: null };
  }
}

/**
 * settings.json의 cleanupPeriodDays를 무조건 99999로 설정한다 (다른 필드 보존, 원자 쓰기).
 * @param {string} settingsPath checkClaudeRetention()이 돌려준 settings.json 경로
 * @returns {boolean} 성공 여부 — 손상 JSON이면 수정하지 않고 false
 */
export function applyRetentionSetting(settingsPath) {
  let config = {};
  if (existsSync(settingsPath)) {
    try {
      config = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return false; // 손상 파일은 건드리지 않는다
    }
  }

  try {
    const next = { ...config, cleanupPeriodDays: FOREVER_DAYS };
    const tmpPath = settingsPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmpPath, settingsPath); // 같은 디렉터리 내 rename = 원자적 교체
    return true;
  } catch {
    return false; // 권한 문제 등 — 호출부가 수동 안내로 폴백
  }
}
