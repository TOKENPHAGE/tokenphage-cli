#!/usr/bin/env node
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
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';

const API_BASE = process.env.TOKENPHAGE_API ?? 'https://api.tokenphage.com';

function requireToken() {
  const token = loadToken();
  if (!token) {
    showError('Not authenticated', 'No saved credentials found.',
      'Run `tokenphage login <github-username>` first.');
    process.exit(1);
  }
  return token;
}

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

async function runUninstallHook() {
  const result = await uninstallHook();
  setHookInstalled(false);
  console.log(result.removed ? '[OK] Removed' : '[OK] No schedule found');
}

// gist 인증 직후 1회: Claude Code의 자동 삭제 위험을 실제 설정값과 함께 안내하고,
// 동의(Y) 시 무조건 99999로 설정한다. 이미 99999 이상이면 조용히 통과한다.
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

async function runSync() {
  const token = requireToken();
  const deviceId = getOrCreateDeviceId();
  const today = localDateOf(new Date());

  // 최초(lastSyncDate 없음)면 fromDate=null → 전체 히스토리 파싱.
  // 이후엔 직전 sync일부터 오늘까지 증분만 파싱.
  const lastSyncDate = getLastSyncDate();
  const fromDate = lastSyncDate ?? null;

  console.log(`Parsing local JSONL... (${fromDate ?? 'beginning'} ~ ${today})`);
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

const program = new Command();
program.name('tokenphage').description('AI token usage as a GitHub README badge — Tokenphage').version('0.1.0');

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

    const { loadConfig } = await import('./auth.js');
    // 대시보드 루프: 액션 수행 후 메인으로 복귀, Exit/Esc 에서만 종료
    while (true) {
      const cfg = loadConfig();
      const action = await promptDashboard(cfg);
      if (action === 'exit') break;
      if (action === 'sync') await runSync();
      else if (action === 'install-hook') await runInstallHook();
      else if (action === 'uninstall-hook') await runUninstallHook();
      else if (action === 'advanced') await runAdvanced(API_BASE, cfg);
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') process.exit(0);
    showError('Unexpected error', err.message);
    process.exitCode = 1;
  }
});

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

program.command('sync')
  .description('Sync local Claude Code token usage to the server')
  .action(async () => {
    try { await runSync(); }
    catch (err) { showError('Sync failed', err.message); process.exitCode = 1; }
  });

program.command('install-hook')
  .description('Register a daily 04:00 auto-sync schedule (macOS launchd / Windows Task Scheduler)')
  .action(async () => {
    try { await runInstallHook(); }
    catch (err) { showError('Install-hook failed', err.message); process.exitCode = 1; }
  });

program.command('uninstall-hook')
  .description('Remove the auto-sync schedule (idempotent)')
  .action(async () => {
    try { await runUninstallHook(); }
    catch (err) { showError('Uninstall-hook failed', err.message); process.exitCode = 1; }
  });

program.parse();
