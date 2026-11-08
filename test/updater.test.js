import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runUpdate } from '../src/lib/updater.js';

// 테스트 목록 — 실제 npm 대신 PATH의 가짜 npm과 임시 전역 폴더로 runUpdate를 돌린다
// 1. update_전역폴더쓰기불가_npm실행없이sudo안내   (실패 입력: #33 재현)
// 2. update_전역폴더쓰기가능_npm설치후updated       (성공: 자동 설치 유지)
// 3. update_전역설치아님_npm실행없이수동안내         (경계: 전역 아님 판정 유지)

const SKIP_WIN = process.platform === 'win32' ? 'Windows는 sh 가짜 npm을 실행할 수 없다' : false;
const SKIP_ROOT = process.getuid?.() === 0 ? 'root는 쓰기 권한 검사를 항상 통과한다' : false;

const cleanupDirs = [];
after(() => { for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true }); });

/** npm 전역 설치 모양(<root>/tokenphage, <base>/bin의 bin 링크)과 `root -g`·`install -g`에만 답하는 가짜 npm을 만든다. */
function fakeGlobalInstall() {
  const base = mkdtempSync(join(tmpdir(), 'tp-updater-'));
  cleanupDirs.push(base);
  const root = join(base, 'lib', 'node_modules');
  const entry = join(root, 'tokenphage', 'src', 'index.js');
  const bin = join(base, 'bin');
  const marker = join(base, 'npm-install-ran');
  mkdirSync(join(root, 'tokenphage', 'src'), { recursive: true });
  writeFileSync(entry, '');
  mkdirSync(bin);
  symlinkSync(entry, join(bin, 'tokenphage'));
  // PATH가 bin 하나뿐이라 sh 내장 명령만 쓴다
  writeFileSync(join(bin, 'npm'), [
    '#!/bin/sh',
    'case "$*" in',
    `  'root -g') echo '${root}' ;;`,
    `  'install -g tokenphage@latest') : > '${marker}' ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  return { base, root, bin, marker, script: join(bin, 'tokenphage') };
}

/** PATH·argv[1]·console.log를 바꿔 runUpdate를 부르고 결과와 출력을 돌려준다. */
async function runWith(bin, script) {
  const saved = { path: process.env.PATH, argv1: process.argv[1], log: console.log };
  const lines = [];
  process.env.PATH = bin; // 실제 npm을 찾을 수 없게 한다
  process.argv[1] = script;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    return { result: await runUpdate('9.9.9'), out: lines.join('\n') };
  } finally {
    process.env.PATH = saved.path;
    process.argv[1] = saved.argv1;
    console.log = saved.log;
  }
}

test('update_전역폴더쓰기불가_npm실행없이sudo안내', { skip: SKIP_WIN || SKIP_ROOT }, async (t) => {
  // Given: sudo로 설치해 현재 계정이 쓸 수 없는 전역 폴더
  const g = fakeGlobalInstall();
  chmodSync(g.root, 0o555);
  t.after(() => chmodSync(g.root, 0o755)); // 단언이 실패해도 되돌려야 임시 폴더를 지울 수 있다

  // When
  const { result, out } = await runWith(g.bin, g.script);

  // Then
  assert.deepEqual(result, { updated: false }); // 수정 전에는 npm을 실행해 updated true
  assert.ok(out.includes('sudo npm install -g tokenphage@latest'), out); // 사용자가 그대로 복사해 실행하는 명령
  assert.equal(existsSync(g.marker), false); // 같은 계정으로 실패할 npm install은 돌리지 않는다
});

test('update_전역폴더쓰기가능_npm설치후updated', { skip: SKIP_WIN }, async () => {
  // Given: 사용자 소유 전역 폴더, 실행 경로는 npm이 만드는 bin 링크
  const g = fakeGlobalInstall();

  // When
  const { result, out } = await runWith(g.bin, g.script);

  // Then
  assert.deepEqual(result, { updated: true });
  assert.equal(existsSync(g.marker), true); // 가짜 npm이 install -g tokenphage@latest 인자로 불렸다
  assert.ok(!out.includes('sudo'), out);
});

test('update_전역설치아님_npm실행없이수동안내', { skip: SKIP_WIN }, async () => {
  // Given: npx·git clone처럼 전역 폴더 밖에서 실행
  const g = fakeGlobalInstall();
  const outside = join(g.base, 'elsewhere.js');
  writeFileSync(outside, '');

  // When
  const { result, out } = await runWith(g.bin, outside);

  // Then
  assert.deepEqual(result, { updated: false });
  assert.equal(existsSync(g.marker), false); // 전역이 아니면 npm i -g를 돌리지 않는다
  assert.ok(out.includes('npm install -g tokenphage@latest'), out);
  assert.ok(!out.includes('sudo'), out);
});
