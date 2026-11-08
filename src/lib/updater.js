/**
 * 1-클릭 업데이트: 전역(npm i -g) 설치인지 감지해, 전역이면 최신버전을 설치하고,
 * 그 외(npx/로컬 의존성/git clone)면 정확한 수동 명령을, 전역 폴더에 쓸 권한이 없으면(sudo로 설치) sudo 명령을 안내한다.
 *
 * 현재 프로세스는 설치 직후에도 여전히 "구버전 코드"이므로(핫스왑 불가),
 * 성공 시 재실행을 안내하고 호출부(index.js)에서 프로세스를 종료한다.
 */
import { spawn, execFileSync } from 'child_process';
import { realpathSync, accessSync, constants } from 'fs';
import chalk from 'chalk';
import { accent } from '../gradient.js';
import { PACKAGE_NAME } from './update-check.js';

const isWin = process.platform === 'win32';
// Windows는 spawn('npm')이 ENOENT → npm.cmd를 쓴다. 또 최신 Node는 보안 패치(CVE-2024-27980) 이후
// .cmd 실행에 shell:true를 요구한다. 인자는 전부 고정 리터럴(아래 PACKAGE_NAME 상수)이라 인젝션 표면이 없다.
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const MANUAL_CMD = `npm install -g ${PACKAGE_NAME}@latest`;

/** npm 전역 설치 루트(`npm root -g`)를 반환한다. 실패하면 null. */
function globalRoot() {
  try {
    return execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8', shell: isWin }).trim();
  } catch {
    return null;
  }
}

/** 현재 실행 중인 CLI가 전역 npm 설치(.../lib/node_modules/...)면 전역 루트(realpath)를, 아니면 null을 반환한다. */
function globalInstallRoot() {
  try {
    const script = realpathSync(process.argv[1]);
    const root = globalRoot();
    if (!root) return null;
    const realRoot = realpathSync(root);
    return script.startsWith(realRoot) ? realRoot : null;
  } catch {
    return null; // 불확실하면 전역 아님으로 간주 → 수동 안내(잘못된 npm i -g 방지)
  }
}

/** 현재 계정에 dir 쓰기 권한이 없어(EACCES) sudo가 필요한지. 읽기 전용 FS(EROFS) 등은 sudo로도 안 풀려 false. */
function needsSudo(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return false;
  } catch (err) {
    return err.code === 'EACCES';
  }
}

/** `npm install -g <pkg>@latest`를 출력 스트리밍으로 실행한다. {ok, code?, err?} 반환. */
function npmInstallGlobal() {
  return new Promise((resolve) => {
    const child = spawn(npmCmd, ['install', '-g', `${PACKAGE_NAME}@latest`], {
      stdio: 'inherit',
      shell: isWin,
    });
    child.on('error', (err) => resolve({ ok: false, err }));      // ENOENT 등 실행 자체 실패
    child.on('close', (code) => resolve({ ok: code === 0, code })); // 종료 코드로 성공 판정
  });
}

/** 정확한 수동 업데이트 명령을 강조색으로 출력한다. */
function printManual() {
  console.log(accent(`  → ${MANUAL_CMD}`));
}

/**
 * 업데이트를 수행한다.
 * @param {string} latest 설치 대상 최신버전(표시용)
 * @returns {Promise<{updated:boolean}>} updated=true면 호출부가 재실행 안내 후 프로세스를 종료해야 한다.
 */
export async function runUpdate(latest) {
  const root = globalInstallRoot();
  // 전역 설치가 아니면 자동 업데이트가 위험/무의미 → 수동 명령만 안내.
  if (!root) {
    console.log(chalk.gray('  Not a global npm install — update manually:'));
    printManual();
    return { updated: false };
  }

  // 쓸 수 없는 전역 폴더면 npm은 EACCES로 실패하고 같은 명령의 재시도도 실패한다(Windows는 access가 ACL을 안 봐 제외).
  if (!isWin && needsSudo(root)) {
    console.log(chalk.yellow(`  No write permission to the global npm folder (${root}) — update with sudo:`));
    console.log(accent(`  → sudo ${MANUAL_CMD}`));
    return { updated: false };
  }

  console.log(accent(`  Updating to v${latest}...`));
  const result = await npmInstallGlobal();

  if (result.ok) {
    console.log(accent(`  ✓ Updated. Restart tokenphage to use v${latest}.`));
    return { updated: true };
  }

  // 실행 실패(npm 없음) vs 종료코드 실패(권한 등)를 구분해 안내.
  if (result.err) {
    console.log(chalk.yellow('  npm was not found or failed to launch.'));
  } else {
    console.log(chalk.yellow('  Update failed (permission?). Try again with the right permissions, or update manually:'));
  }
  printManual();
  return { updated: false };
}
