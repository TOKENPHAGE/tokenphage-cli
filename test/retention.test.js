import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkClaudeRetention, applyRetentionSetting, FOREVER_DAYS, DEFAULT_CLEANUP_DAYS } from '../src/lib/retention.js';

// 테스트 목록 — 규칙은 하나: cleanupPeriodDays >= 99999면 통과, 아니면 설정 필요
// [checkClaudeRetention]
// 1. check_settings없음_설정필요                            (경계)
// 2. check_cleanupPeriodDays미설정또는짧음_설정필요          (경계)
// 3. check_99999이상_설정불필요                              (성공: 3650000 포함)
// 4. check_손상JSON_corrupted플래그와설정필요                (실패 입력)
// 5. check_projects보유dir우선_해당settings선택              (성공: OS별 경로 규칙)
//    + 각 케이스에서 currentValue(현재 설정값/미설정·손상이면 null) 단언
// [applyRetentionSetting]
// 6. apply_기존필드보존하며무조건99999_원자쓰기              (성공)
// 7. apply_손상JSON_수정하지않고false                        (실패 입력)
// 8. apply_settings없음_새로생성                             (경계)
// [constants]
// 9. constants_DEFAULT_CLEANUP_DAYS_기본30                   (성공)

let root;
const cleanupDirs = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tp-retention-'));
  cleanupDirs.push(root);
});
after(() => { for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true }); });

function makeClaudeDir(name, { settings, withProjects = true } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (withProjects) mkdirSync(join(dir, 'projects'), { recursive: true });
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings);
  return dir;
}

test('check_settings없음_설정필요', () => {
  // Given: settings.json이 없는 설정 디렉터리
  const dir = makeClaudeDir('a');

  // When
  const r = checkClaudeRetention([dir]);

  // Then
  assert.equal(r.needed, true);
  assert.equal(r.settingsPath, join(dir, 'settings.json'));
  assert.equal(r.currentValue, null);
});

test('check_cleanupPeriodDays미설정또는짧음_설정필요', () => {
  // Given / When / Then: 미설정과 99999 미만 값 모두 설정 대상
  const unset = checkClaudeRetention([makeClaudeDir('b', { settings: '{"theme":"dark"}' })]);
  assert.equal(unset.needed, true);
  assert.equal(unset.currentValue, null);

  const short = checkClaudeRetention([makeClaudeDir('c', { settings: '{"cleanupPeriodDays":60}' })]);
  assert.equal(short.needed, true);
  assert.equal(short.currentValue, 60);
});

test('check_99999이상_설정불필요', () => {
  // Given / When / Then: 정확히 99999와 그 이상(예: 3650000) 모두 통과
  const exact = checkClaudeRetention([makeClaudeDir('d', { settings: `{"cleanupPeriodDays":${FOREVER_DAYS}}` })]);
  assert.equal(exact.needed, false);
  assert.equal(exact.currentValue, FOREVER_DAYS);

  const bigger = checkClaudeRetention([makeClaudeDir('e', { settings: '{"cleanupPeriodDays":3650000}' })]);
  assert.equal(bigger.needed, false);
  assert.equal(bigger.currentValue, 3650000);
});

test('check_손상JSON_corrupted플래그와설정필요', () => {
  // Given
  const dir = makeClaudeDir('f', { settings: '{broken json' });

  // When
  const r = checkClaudeRetention([dir]);

  // Then
  assert.equal(r.needed, true);
  assert.equal(r.corrupted, true);
  assert.equal(r.currentValue, null);
});

test('check_projects보유dir우선_해당settings선택', () => {
  // Given: 첫 후보는 projects/ 없음(미사용 dir), 둘째 후보가 실사용 dir
  const unused = makeClaudeDir('g-unused', { withProjects: false, settings: `{"cleanupPeriodDays":${FOREVER_DAYS}}` });
  const active = makeClaudeDir('g-active', { settings: '{"cleanupPeriodDays":60}' });

  // When
  const r = checkClaudeRetention([unused, active]);

  // Then: projects/가 있는 active 쪽 settings를 본다
  assert.equal(r.settingsPath, join(active, 'settings.json'));
  assert.equal(r.needed, true);
  assert.equal(r.currentValue, 60);
});

test('apply_기존필드보존하며무조건99999_원자쓰기', () => {
  // Given: 다른 설정과 짧은 기존값이 있는 settings.json
  const dir = makeClaudeDir('h', { settings: '{"theme":"dark","env":{"X":"1"},"cleanupPeriodDays":60}' });
  const path = join(dir, 'settings.json');

  // When
  const ok = applyRetentionSetting(path);

  // Then: 무조건 99999로, 기존 필드 보존, tmp 파일 잔존 없음
  assert.equal(ok, true);
  const cfg = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(cfg.cleanupPeriodDays, FOREVER_DAYS);
  assert.equal(cfg.theme, 'dark');
  assert.deepEqual(cfg.env, { X: '1' });
  assert.equal(existsSync(path + '.tmp'), false);
});

test('apply_손상JSON_수정하지않고false', () => {
  // Given
  const dir = makeClaudeDir('i', { settings: '{broken json' });
  const path = join(dir, 'settings.json');

  // When
  const ok = applyRetentionSetting(path);

  // Then: 원본 그대로, false 반환
  assert.equal(ok, false);
  assert.equal(readFileSync(path, 'utf8'), '{broken json');
});

test('apply_settings없음_새로생성', () => {
  // Given: settings.json이 없는 dir
  const dir = makeClaudeDir('j');
  const path = join(dir, 'settings.json');

  // When
  const ok = applyRetentionSetting(path);

  // Then: 필드 하나짜리 JSON 생성
  assert.equal(ok, true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).cleanupPeriodDays, FOREVER_DAYS);
});

test('constants_DEFAULT_CLEANUP_DAYS_기본30', () => {
  // Given / When / Then: Claude Code 기본 보존일수 상수
  assert.equal(DEFAULT_CLEANUP_DAYS, 30);
});
