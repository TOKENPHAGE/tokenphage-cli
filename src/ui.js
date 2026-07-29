import chalk from 'chalk';
import gradient from 'gradient-string';
import { colorAt, PURPLE_STOPS, ACCENT_STOPS, accent } from './gradient.js';
import { selectWithEsc } from './animated-select.js';
import { input } from '@inquirer/prompts';
import { createRequire } from 'node:module';
import { getUpdateInfo, PACKAGE_NAME } from './lib/update-check.js';

// 버전은 package.json 단일 출처에서 읽는다 (index.js와 동일 패턴 — 하드코딩으로 인한 표기 불일치 방지).
const { version } = createRequire(import.meta.url)('../package.json');

const TOKEN_LINES = [
  '  ████████╗ ██████╗ ██╗  ██╗███████╗███╗  ██╗',
  '  ╚══██╔══╝██╔═══██╗██║ ██╔╝██╔════╝████╗ ██║',
  '     ██║   ██║   ██║█████╔╝ █████╗  ██╔██╗██║',
  '     ██║   ██║   ██║██╔═██╗ ██╔══╝  ██║╚████║',
  '     ██║   ╚██████╔╝██║  ██╗███████╗██║ ╚███║',
  '     ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚══╝',
];

const PHAGE_LINES = [
  '  ██████╗ ██╗  ██╗ █████╗  ██████╗ ███████╗',
  '  ██╔══██╗██║  ██║██╔══██╗██╔════╝ ██╔════╝',
  '  ██████╔╝███████║███████║██║  ███╗█████╗',
  '  ██╔═══╝ ██╔══██║██╔══██║██║   ██║██╔══╝',
  '  ██║     ██║  ██║██║  ██║╚██████╔╝███████╗',
  '  ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

// PHAGE 뒤에 붙는 느낌표 블록 (PHAGE 와 동일한 6줄 높이)
const EXCLAIM_LINES = [
  '  ██╗',
  '  ██║',
  '  ██║',
  '  ╚═╝',
  '  ██╗',
  '  ╚═╝',
];

// PHAGE 줄 정렬 폭 (E 글자 줄이 짧아 우측 패딩으로 느낌표 위치를 맞춘다)
const PHAGE_WIDTH = 43;

/** 라인을 세로 위치 i/n 의 좁은 색 범위로 그라데이션 + bold 처리해 반환. */
function paintLine(line, i, n, stops) {
  return chalk.bold(gradient([colorAt(i / n, stops), colorAt((i + 1) / n, stops)])(line));
}

/**
 * TOKENPHAGE 로고를 세로 보라 그라데이션으로 렌더링한다.
 * PHAGE 6줄 뒤에는 민트 시안 강조색 느낌표를 덧붙여, 보라 본문과 대비되는
 * 포인트를 준다. 각 영역은 자기 영역 기준의 세로 그라데이션을 갖는다.
 */
function renderLogo() {
  const all = [...TOKEN_LINES, ...PHAGE_LINES];
  const n = all.length;
  const tokenCount = TOKEN_LINES.length;
  const phageCount = PHAGE_LINES.length;

  return all
    .map((line, i) => {
      const body = paintLine(line, i, n, PURPLE_STOPS);
      if (i < tokenCount) return body;

      // PHAGE 영역: 우측을 폭에 맞춰 패딩한 뒤 민트 강조 느낌표를 덧붙인다.
      const phageIdx = i - tokenCount;
      const padded = chalk.bold(
        gradient([colorAt(i / n, PURPLE_STOPS), colorAt((i + 1) / n, PURPLE_STOPS)])(
          line.padEnd(PHAGE_WIDTH),
        ),
      );
      const exclaim = paintLine(EXCLAIM_LINES[phageIdx], phageIdx, phageCount, ACCENT_STOPS);
      return padded + exclaim;
    })
    .join('\n');
}

/** Decode JWT payload to extract username (no verification, display only). */
function decodeJwtUsername(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.username ?? null;
  } catch {
    return null;
  }
}

/** Print welcome screen: Tokenphage logo. */
export function printWelcome() {
  console.clear();

  const logo = renderLogo();

  console.log('\n' + logo);
  console.log();
  console.log(chalk.gray(`  AI token usage as a GitHub badge — v${version}`));
  console.log();
}

/**
 * First-run menu: prompt unauthenticated user to start Gist auth or exit.
 * @returns {'auth' | 'exit'}
 */
export async function promptFirstRun() {
  printWelcome();

  console.log(accent('  Not authenticated yet.'));
  console.log(chalk.gray('  Verify GitHub account ownership via a public Gist to get started.'));
  console.log();

  const action = await selectWithEsc({
    message: 'What would you like to do?',
    choices: [
      {
        name: 'Authenticate with Gist',
        value: 'auth',
        description: 'Create a public Gist to prove ownership and save your JWT',
      },
      {
        name: 'Exit',
        value: 'exit',
      },
    ],
  });

  return action;
}

/**
 * 인증된 사용자를 위한 대시보드 메뉴.
 * @param {{ token: string, lastSyncDate: string|null, hookInstalled: boolean, hookMeta: object|null }} cfg
 * @param {string|null} latest TUI 진입 시 조회한 npm 최신버전(조회 실패/옵트아웃 시 null)
 * @param {boolean} [hookUnverified] OS 스케줄러 등록 여부를 확인할 수 없었으면 true
 * @returns {'update' | 'sync' | 'install-hook' | 'uninstall-hook' | 'advanced' | 'exit'}
 */
export async function promptDashboard(cfg, latest, hookUnverified = false) {
  printWelcome();

  // TUI 진입 시 조회한 npm 최신버전과 현재 버전을 비교해, 다를 때만 민트 배너를 출력한다.
  const update = getUpdateInfo(version, latest);
  if (update.hasUpdate) {
    const bar = accent('  ┃ ');
    console.log(bar + accent(`⬆  Update available  v${update.current} → v${update.latest}`));
    console.log(bar + chalk.gray(`npm install -g ${PACKAGE_NAME}@latest`));
    console.log();
  }

  const username = decodeJwtUsername(cfg.token) ?? '(unknown)';
  const lastSync = cfg.lastSyncDate ?? 'never';
  // 설정 상태를 먼저 보고, 켜진 경우에만 검증 결과를 반영한다
  // (순서를 뒤집으면 방금 auto-sync를 끈 사용자에게도 "enabled"가 남는다).
  // 등록을 확인하지 못했거나 재등록이 실패했으면 초록으로 단정하지 않고 노랑으로 유보한다.
  const hookStatus = !cfg.hookInstalled
    ? chalk.yellow('  Auto-sync not configured')
    : hookUnverified
      ? chalk.yellow('  Auto-sync enabled') + chalk.gray(' (could not verify — see message above)')
      : chalk.green('  Auto-sync enabled') + chalk.gray(` (${cfg.hookMeta?.scheduleSpec ?? 'daily 04:00'})`);

  console.log(chalk.green('  Authenticated as ') + chalk.bold(`@${username}`));
  console.log(chalk.gray(`  Last sync: ${lastSync}`));
  console.log(hookStatus);
  console.log();

  const choices = [
    { name: 'Sync now', value: 'sync', description: 'Push local token data to the server' },
  ];

  // 새 버전이 있으면 최상단에 흐르는 강조(flow) Update 선택지를 추가한다.
  if (update.hasUpdate) {
    choices.unshift({
      name: `⬆ Update to v${update.latest}`,
      value: 'update',
      description: 'Download and install the latest version',
      flow: true,
    });
  }

  if (cfg.hookInstalled) {
    choices.push({ name: 'Disable auto-sync', value: 'uninstall-hook', flow: true });
  } else {
    choices.push({ name: 'Enable auto-sync', value: 'install-hook', description: 'Run sync daily at 04:00', flow: true });
  }

  choices.push({ name: 'Advanced settings', value: 'advanced', description: 'Reset data and other options' });
  choices.push({ name: 'Exit', value: 'exit' });

  const action = await selectWithEsc({ message: 'What would you like to do?', choices });
  return action;
}

/**
 * Advanced settings submenu. Esc exits immediately (selectWithEsc behavior),
 * so a 'Back' choice is provided for safe return to the dashboard.
 * @returns {Promise<'reset' | 'back'>}
 */
export async function promptAdvanced() {
  printWelcome();
  console.log(chalk.gray('  Advanced settings'));
  console.log();
  return selectWithEsc({
    message: 'Advanced settings',
    choices: [
      { name: 'Reset all data', value: 'reset', description: 'Delete ALL server-side token data and re-sync from scratch' },
      { name: 'Back', value: 'back' },
    ],
  });
}

/**
 * Confirm a full reset. Because this is irreversible, require typing the GitHub
 * username rather than a single keystroke.
 * @param {{ token: string }} cfg
 * @returns {Promise<boolean>} true when the typed username matches
 */
export async function confirmReset(cfg) {
  const username = decodeJwtUsername(cfg.token) ?? '';
  console.log();
  console.log(chalk.red.bold('  ⚠  WARNING: This is irreversible.'));
  console.log(chalk.red('  All token usage data on the server will be permanently deleted,'));
  console.log(chalk.red('  then re-synced from scratch.'));
  console.log(chalk.gray('  Your local Claude Code logs are NOT touched. Allowed once every 24 hours.'));
  console.log();
  const typed = await input({ message: `Type your GitHub username (${username}) to confirm:` });
  return username.length > 0 && typed.trim() === username;
}

/**
 * 작업 결과(성공/실패) 메시지를 사용자가 읽을 수 있도록 Enter 입력까지 대기한다.
 * 대시보드로 복귀하면 printWelcome()의 console.clear()로 화면이 지워지므로,
 * 그 전에 결과를 확인시키기 위한 용도다.
 */
export async function pauseForEnter() {
  console.log();
  await input({ message: chalk.gray('Press Enter to return to the menu') });
}

/**
 * 눈에 띄는 에러 배너를 좌측 빨강 바(blockquote) 스타일로 출력한다.
 * 상태색(빨강)으로 강조하고 제목·사유·다음 행동 힌트를 구조화해 보여준다.
 * 하이라이팅 규칙상 강조는 민트지만, 에러는 의미색(빨강)을 쓴다.
 * @param {string} title  짧은 제목 (예: 'Authentication failed')
 * @param {string} [detail] 상세 사유 (서버/에러 메시지)
 * @param {string} [hint]   다음 행동 안내 (선택)
 */
export function showError(title, detail, hint) {
  const bar = chalk.red('  ┃ ');
  const emptyBar = chalk.red('  ┃');
  console.log();
  console.log(bar + chalk.red.bold(`✖  ${title}`));
  if (detail) {
    console.log(emptyBar);
    console.log(bar + detail);
  }
  if (hint) {
    console.log(emptyBar);
    console.log(bar + chalk.gray(`→ ${hint}`));
  }
  console.log();
}
