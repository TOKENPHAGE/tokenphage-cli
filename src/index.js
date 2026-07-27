#!/usr/bin/env node
/**
 * tokenphage CLI 진입점 (package.json "bin"이 가리키는 파일).
 * 구조: ① 상단 import(의존성) → ② 중단 run* 함수 정의(명령별 동작) → ③ 하단에서 commander로 명령을 등록하고
 *       맨 끝 program.parse()가 argv를 해석해 실제 시동을 건다.
 */
import { Command } from 'commander';
import { parseAll } from './parser.js';
import { loadToken, saveToken, getOrCreateDeviceId, gistLogin, setHookInstalled, getLastSyncDate, saveLastSyncDate, clearLastSyncDate } from './auth.js';
import { syncRecords, resetData } from './sync.js';
import { installHook, uninstallHook } from './scheduler.js';
import { promptFirstRun, promptDashboard, promptAdvanced, confirmReset, pauseForEnter, showError } from './ui.js';
import { accent } from './gradient.js';
import { localDateOf } from './lib/dates.js';
import { claudeDirCandidates } from './parser.js';
import { checkClaudeRetention, applyRetentionSetting, DEFAULT_CLEANUP_DAYS } from './lib/retention.js';
import { checkLatestVersion, getUpdateInfo } from './lib/update-check.js';
import { runUpdate } from './lib/updater.js';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { createRequire } from 'node:module';

// API 서버 주소: 환경변수 우선, 없으면 운영 기본값 (dev는 TOKENPHAGE_API로 주입)
const API_BASE = process.env.TOKENPHAGE_API ?? 'https://api.tokenphage.com';

// package.json의 version 조회
// createRequire는 import.meta.url 기준 상대경로를 해석하고, JSON import와 달리 Node 20에서도 경고 없이 동작한다.
const { version } = createRequire(import.meta.url)('../package.json');

/** 저장된 JWT를 반환한다. 없으면 로그인 안내를 출력하고 프로세스를 종료(exit 1)한다. */
function requireToken() {
  const token = loadToken();
  if (!token) {
    showError('Not authenticated', 'No saved credentials found.',
      'Run `tokenphage login <github-username>` first.');
    process.exit(1);
  }
  return token;
}

/** install-hook 명령 본체: 자동 sync 스케줄을 등록하고 설치 상태를 저장한 뒤 초기 sync까지 수행한다. */
async function runInstallHook() {
  requireToken();
  const result = await installHook();
  setHookInstalled(true, result);
  console.log(`[OK] ${result.method} registered. Runs ${result.scheduleSpec}.`);
  console.log(`     Log: ${result.logPath}`);
  console.log(`     Artifact: ${result.artifactPath}`);
  console.log('');
  console.log('Running initial sync...');
  await runSync();
}

/** uninstall-hook 명령 본체: 자동 sync 스케줄을 제거하고 설치 상태를 해제한다(스케줄이 없어도 정상 처리). */
async function runUninstallHook() {
  const result = await uninstallHook();
  setHookInstalled(false);
  console.log(result.removed ? '[OK] Removed' : '[OK] No schedule found');
}

/**
 * gist 인증 직후 1회: Claude Code의 자동 삭제 위험을 실제 설정값과 함께 안내하고,
 * 동의(Y) 시 무조건 99999로 설정한다. 이미 99999 이상이면 조용히 통과한다.
 */
async function promptRetentionSetup() {
  const check = checkClaudeRetention(claudeDirCandidates());
  if (!check.needed) return;

  const printManualGuide = () => {
    console.log(`    → To set it manually, add ${accent('"cleanupPeriodDays": 99999')} to ${accent(check.settingsPath)}`);
  };

  console.log('');
  console.log(`  ${chalk.bold.red('⚠  Token history can be auto-deleted')}`);
  console.log('');

  // 설정 파일이 손상돼 현재값을 신뢰할 수 없으면 자동 설정 없이 수동 안내로 폴백.
  if (check.corrupted) {
    console.log(`     ${check.settingsPath} could not be parsed — skipping automatic setup.`);
    printManualGuide();
    return;
  }

  // 라벨을 색 없이 padEnd로 먼저 정렬한 뒤 값/강조에만 accent를 입힌다 (ANSI 코드가 폭 계산을 깨지 않도록).
  const labelWidth = 'Current setting'.length;
  const contIndent = ' '.repeat(3 + labelWidth + 3); // 라벨 다음 줄(연속 줄)을 값 위치에 맞추는 들여쓰기
  const row = (label, value, highlightLabel = false) => {
    const shown = highlightLabel ? accent(label) : label;
    const pad = ' '.repeat(Math.max(0, labelWidth - label.length));
    return `   ${shown}${pad} : ${value}`;
  };

  // 실제 cleanupPeriodDays 값 표시. 미설정이면 Claude Code 기본값(30) + (default) 표기.
  const currentDesc = check.currentValue === null
    ? `delete after ${accent(`${DEFAULT_CLEANUP_DAYS} days`)} ${chalk.dim('(default)')}`
    : `delete after ${accent(`${check.currentValue} days`)}`;

  console.log(row('Current setting', currentDesc));
  console.log(row('Risk', 'deleted sessions are lost forever and'));
  console.log(`${contIndent}go ${accent('MISSING')} from your token stats`);
  console.log(row('Fix (Yes)', 'keep history forever — count every token', true));
  console.log('');

  let agreed;
  try {
    agreed = await confirm({
      message: `${accent('Keep history forever?')} (updates ${accent(check.settingsPath)})`,
      default: true,
    });
  } catch (err) {
    if (err.name === 'ExitPromptError') process.exit(0); // Ctrl+C
    throw err;
  }

  if (!agreed) {
    printManualGuide();
    return;
  }

  if (applyRetentionSetting(check.settingsPath)) {
    console.log(`    ${chalk.green('✓')} Set ${accent('cleanupPeriodDays: 99999')} — history is now kept forever.`);
  } else {
    console.log(`    ${chalk.yellow('!')} Could not update the file automatically.`);
    printManualGuide();
  }
}

/** sync 명령 본체: 로컬 로그를 파싱(최초=전체 / 이후=증분)해 서버로 업로드하고, 마지막 sync 날짜를 갱신한다. */
async function runSync() {
  const token = requireToken();
  const deviceId = getOrCreateDeviceId();
  const today = localDateOf(new Date());

  // 최초(lastSyncDate 없음)면 fromDate=null → 전체 히스토리 파싱.
  // 이후엔 직전 sync일부터 오늘까지 증분만 파싱.
  const lastSyncDate = getLastSyncDate();
  const fromDate = lastSyncDate ?? null;

  console.log(`Parsing local logs... (${fromDate ?? 'beginning'} ~ ${today})`);
  const records = await parseAll(fromDate);
  console.log(`${records.length} records aggregated (date×model)`);
  if (records.length === 0) {
    console.log('Nothing to sync.');
    saveLastSyncDate(today);
    return;
  }

  console.log('Uploading to server...');
  await syncRecords(API_BASE, token, deviceId, records);
  saveLastSyncDate(today);
  console.log('Done! Badge will update shortly.');
}

/**
 * 고급 메뉴 본체: 현재는 'reset'(전체 초기화)만 처리한다.
 * 확인 → 서버 데이터 삭제 → 로컬 워터마크 제거 → 전체 재-sync 순으로 진행하며, 각 단계 실패를 명확히 안내한다.
 * @param {string} apiBase API 서버 base URL
 * @param {object} cfg 현재 설정(JWT 포함)
 */
async function runAdvanced(apiBase, cfg) {
  const sub = await promptAdvanced();
  if (sub !== 'reset') return; // 'back' → 메시지 없이 즉시 대시보드 복귀
  const confirmed = await confirmReset(cfg); // Ctrl+C는 ExitPromptError로 바깥 핸들러가 종료 처리
  if (!confirmed) {
    console.log(accent('  Reset cancelled.'));
    await pauseForEnter();
    return;
  }
  const token = cfg.token;
  if (!token) {
    showError('Not authenticated', 'No saved credentials found.',
      'Authenticate again from the main menu.');
    await pauseForEnter();
    return;
  }
  // 1단계: 서버 데이터 삭제. 실패(쿨다운 429 등) 시 삭제된 데이터가 없으므로 그대로 종료.
  try {
    console.log('  Resetting server data...');
    await resetData(apiBase, token);
  } catch (err) {
    showError('Reset failed', err.message, 'No data was deleted. Please try again later.');
    await pauseForEnter();
    return;
  }
  // 2단계: 로컬 워터마크 제거 후 전체 재-sync. 재-sync가 실패해도 서버 삭제는 이미 완료됐음을 명확히 안내.
  clearLastSyncDate();
  console.log(accent('  [OK] Server data reset.') + ' Re-syncing from scratch...');
  try {
    await runSync();
    console.log(accent('  [OK] Reset complete — your data was rebuilt from scratch.'));
  } catch (err) {
    showError('Re-sync failed', err.message,
      'Your server data was reset. Run `tokenphage sync` to rebuild your badge.');
  }
  await pauseForEnter();
}

// ========================================== START - CLI =========================================
const program = new Command();
program.name('tokenphage').description('AI token usage as a GitHub README badge — Tokenphage').version(version);

// 기본 동작: 인자 없이 `tokenphage` 실행 시.
// 미인증이면 인증 루프 → 보존 설정 → 초기 sync를 먼저 거치고, 그 뒤 대시보드 루프로 진입한다.
program.action(async () => {
  if (!process.stdin.isTTY) {
    program.help();
    return;
  }
  try {
    if (!loadToken()) {
      // 인증 루프: 실패해도 CLI를 죽이지 않고 알림 후 메뉴로 복귀(재시도/종료 선택 가능)
      while (true) {
        const action = await promptFirstRun();
        if (action !== 'auth') return; // Exit 선택 → 종료
        try {
          const jwt = await gistLogin(API_BASE);
          saveToken(jwt);
          console.log('     → Saved to ~/.tokenphage/config.json');
          break; // 인증 성공 → 루프 탈출
        } catch (err) {
          if (err.name === 'ExitPromptError') process.exit(0); // Ctrl+C
          showError('Authentication failed', err.message,
            'Make sure your Gist is public and owned by your GitHub account, then try again.');
          await pauseForEnter(); // 사용자가 읽고 → 다시 메뉴로 복귀
        }
      }
      // 인증 성공 → 보존 설정 안내 (첫 sync 전에 잡아야 이후 기록이 전부 보호됨)
      await promptRetentionSetup();
      // 초기 전체 sync (실패해도 죽지 않고 대시보드로 진행)
      try {
        console.log('');
        console.log('Running initial full sync...');
        await runSync();
      } catch (err) {
        if (err.name === 'ExitPromptError') process.exit(0);
        showError('Initial sync failed', err.message,
          'You are authenticated — you can run sync later from the menu.');
        await pauseForEnter();
      }
    }

    // 인증 이후 메뉴는 최신 설정이 필요하므로 여기서 동적 import (상단 정적 import과 별개)
    const { loadConfig } = await import('./auth.js');
    // TUI 진입 시 npm 최신버전을 1회 조회(짧은 타임아웃). 세션 동안 재사용해 배너/메뉴에 반영한다.
    const latest = await checkLatestVersion();
    // 대시보드 루프: 액션 수행 후 메인으로 복귀, Exit/Esc 에서만 종료
    while (true) {
      const cfg = loadConfig();
      const action = await promptDashboard(cfg, latest);
      if (action === 'exit') break;
      if (action === 'sync') await runSync();
      else if (action === 'install-hook') await runInstallHook();
      else if (action === 'uninstall-hook') await runUninstallHook();
      else if (action === 'advanced') await runAdvanced(API_BASE, cfg);
      else if (action === 'update') {
        // 업데이트 성공 시 현재 프로세스는 여전히 구버전 코드 → 재실행 안내 후 종료.
        const { hasUpdate } = getUpdateInfo(version, latest);
        if (hasUpdate) {
          const result = await runUpdate(latest);
          await pauseForEnter();
          if (result.updated) process.exit(0);
        }
      }
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') process.exit(0);
    showError('Unexpected error', err.message);
    process.exitCode = 1;
  }
});

// ── 명시적 서브커맨드: `tokenphage <command>` 형태로 직접 호출하며, 위에서 정의한 run* 함수를 실행한다 ──

// login [username]: Gist로 GitHub 소유권 증명 → JWT 저장 → 보존 설정 → 초기 sync. (대화형 터미널 필요)
program.command('login [username]')
  .description('Prove GitHub account ownership via a public Gist and save the JWT')
  .action(async (username) => {
    if (!process.stdin.isTTY) {
      showError('Interactive terminal required', 'The login command needs an interactive terminal.');
      process.exit(1);
    }
    try {
      const token = await gistLogin(API_BASE, username);
      saveToken(token);
      console.log('     → Saved to ~/.tokenphage/config.json');
      await promptRetentionSetup();
      console.log('');
      console.log('Running initial full sync...');
      await runSync();
    } catch (err) {
      showError('Login failed', err.message);
      process.exitCode = 1;
    }
  });

// sync: 로컬 Claude Code/Codex/opencode 로그를 파싱해 서버로 업로드한다(배지 갱신). 미인증이면 안내 후 종료.
program.command('sync')
  .description('Sync local token usage (Claude Code, Codex, opencode) to the server')
  .action(async () => {
    try { await runSync(); }
    catch (err) { showError('Sync failed', err.message); process.exitCode = 1; }
  });

// install-hook: 매일 04:00 자동 sync 스케줄을 OS별(macOS launchd / Windows Task Scheduler)로 등록한다.
program.command('install-hook')
  .description('Register a daily 04:00 auto-sync schedule (macOS launchd / Windows Task Scheduler / Linux cron)')
  .action(async () => {
    try { await runInstallHook(); }
    catch (err) { showError('Install-hook failed', err.message); process.exitCode = 1; }
  });

// uninstall-hook: 자동 sync 스케줄을 제거한다(스케줄이 없어도 안전한 멱등 동작).
program.command('uninstall-hook')
  .description('Remove the auto-sync schedule (idempotent)')
  .action(async () => {
    try { await runUninstallHook(); }
    catch (err) { showError('Uninstall-hook failed', err.message); process.exitCode = 1; }
  });

program.parse(); // argv를 해석해 알맞은 .action()으로 분기 — CLI 실제 시동 지점
