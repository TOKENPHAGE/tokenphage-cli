import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'path';
import { resolveClaudeDirs } from '../src/lib/paths.js';

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
