import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'path';
import { resolveClaudeDirs, resolveOpencodeDirs } from '../src/lib/paths.js';

// 테스트 목록
// 1. resolveClaudeDirs_기본입력_기본과XDG순서보장            (성공)
// 2. resolveClaudeDirs_XDG_CONFIG_HOME지정_지정경로사용      (성공)
// 3. resolveClaudeDirs_커스텀경로추가_마지막순서에붙음        (성공)
// 4. resolveClaudeDirs_중복경로_한번만반환                   (경계)
// 5. resolveClaudeDirs_틸드경로_home으로확장                 (경계)
// 6. resolveClaudeDirs_비배열customPaths_무시                (실패 입력)

const HOME = '/Users/tester';

test('resolveClaudeDirs_기본입력_기본과XDG순서보장', () => {
  // Given / When: XDG 미설정, 커스텀 없음
  const dirs = resolveClaudeDirs({ home: HOME });

  // Then: ~/.claude → ~/.config/claude 순서
  assert.deepEqual(dirs, [
    resolve(join(HOME, '.claude')),
    resolve(join(HOME, '.config', 'claude')),
  ]);
});

test('resolveClaudeDirs_XDG_CONFIG_HOME지정_지정경로사용', () => {
  // Given / When
  const dirs = resolveClaudeDirs({ home: HOME, xdgConfigHome: '/xdg/config' });

  // Then: XDG 자리에 지정 경로가 들어간다
  assert.deepEqual(dirs, [
    resolve(join(HOME, '.claude')),
    resolve('/xdg/config/claude'),
  ]);
});

test('resolveClaudeDirs_커스텀경로추가_마지막순서에붙음', () => {
  // Given / When
  const dirs = resolveClaudeDirs({ home: HOME, customPaths: ['/backup/claude'] });

  // Then: 우선순위는 기본 → XDG → 커스텀
  assert.equal(dirs.length, 3);
  assert.equal(dirs[2], resolve('/backup/claude'));
});

test('resolveClaudeDirs_중복경로_한번만반환', () => {
  // Given: 커스텀이 기본 경로와 동일 (표기만 다름)
  const dirs = resolveClaudeDirs({ home: HOME, customPaths: [`${HOME}/.claude/`, `${HOME}/.claude`] });

  // Then: normalize 후 중복 제거 → 기본 2개만
  assert.equal(dirs.length, 2);
});

test('resolveClaudeDirs_틸드경로_home으로확장', () => {
  // Given / When
  const dirs = resolveClaudeDirs({ home: HOME, customPaths: ['~/claude-backup'] });

  // Then
  assert.equal(dirs[2], resolve(join(HOME, 'claude-backup')));
});

test('resolveClaudeDirs_비배열customPaths_무시', () => {
  // Given / When: 문자열·객체 등 잘못된 타입과 빈 문자열 요소
  const asString = resolveClaudeDirs({ home: HOME, customPaths: '/not/an/array' });
  const withJunk = resolveClaudeDirs({ home: HOME, customPaths: ['', '  ', 42, null, '/ok/path'] });

  // Then: 비배열은 통째로 무시, 배열 내 비문자열·공백은 걸러짐
  assert.equal(asString.length, 2);
  assert.equal(withJunk.length, 3);
  assert.equal(withJunk[2], resolve('/ok/path'));
});

// resolveOpencodeDirs 테스트 목록
// 1. resolveOpencodeDirs_기본입력_XDGdata하위opencode           (성공)
// 2. resolveOpencodeDirs_XDG_DATA_HOME지정_지정경로사용         (성공)
// 3. resolveOpencodeDirs_커스텀경로_틸드확장및기본과중복제거     (경계)
// 4. resolveOpencodeDirs_비배열customPaths_무시                 (실패 입력)

test('resolveOpencodeDirs_기본입력_XDGdata하위opencode', () => {
  // Given / When: XDG_DATA_HOME 미설정
  const dirs = resolveOpencodeDirs({ home: HOME });

  // Then: ~/.local/share/opencode 하나 (Claude와 달리 data home 기준)
  assert.deepEqual(dirs, [resolve(join(HOME, '.local', 'share', 'opencode'))]);
});

test('resolveOpencodeDirs_XDG_DATA_HOME지정_지정경로사용', () => {
  // Given / When
  const dirs = resolveOpencodeDirs({ home: HOME, xdgDataHome: '/xdg/data' });

  // Then: 지정 data home 하위 opencode
  assert.deepEqual(dirs, [resolve('/xdg/data/opencode')]);
});

test('resolveOpencodeDirs_커스텀경로_틸드확장및기본과중복제거', () => {
  // Given: 커스텀에 틸드 경로 + 기본과 동일한 경로(중복)
  const dirs = resolveOpencodeDirs({ home: HOME, customPaths: ['~/oc-backup', `${HOME}/.local/share/opencode`] });

  // Then: 기본 → 틸드확장 커스텀 순, 기본과 겹치는 커스텀은 제거
  assert.deepEqual(dirs, [
    resolve(join(HOME, '.local', 'share', 'opencode')),
    resolve(join(HOME, 'oc-backup')),
  ]);
});

test('resolveOpencodeDirs_비배열customPaths_무시', () => {
  // Given / When: 비배열과 잡음 섞인 배열
  const asString = resolveOpencodeDirs({ home: HOME, customPaths: '/nope' });
  const withJunk = resolveOpencodeDirs({ home: HOME, customPaths: ['', 7, null, '/ok'] });

  // Then: 비배열은 무시(기본 1개), 배열 내 비문자열·공백은 걸러짐(기본 + /ok)
  assert.equal(asString.length, 1);
  assert.deepEqual(withJunk, [resolve(join(HOME, '.local', 'share', 'opencode')), resolve('/ok')]);
});
