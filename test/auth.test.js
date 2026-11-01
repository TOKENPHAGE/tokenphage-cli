import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGistId, VERIFICATION_FILE, clearSyncState } from '../src/auth.js';

test('parseGistId — raw ID', () => {
  assert.equal(parseGistId('abc123def456'), 'abc123def456');
});

test('parseGistId — URL with user prefix', () => {
  assert.equal(
    parseGistId('https://gist.github.com/octocat/abc123def456'),
    'abc123def456'
  );
});

test('parseGistId — URL without user prefix', () => {
  assert.equal(parseGistId('https://gist.github.com/abc123def456'), 'abc123def456');
});

test('parseGistId — URL with /edit suffix', () => {
  assert.equal(
    parseGistId('https://gist.github.com/octocat/abc123def456/edit'),
    'abc123def456'
  );
});

test('parseGistId — surrounding whitespace', () => {
  assert.equal(parseGistId('  abc123def456  '), 'abc123def456');
});

test('parseGistId — surrounding slashes', () => {
  assert.equal(parseGistId('/abc123def456/'), 'abc123def456');
});

test('parseGistId — empty input → empty string', () => {
  assert.equal(parseGistId(''), '');
  assert.equal(parseGistId(null), '');
  assert.equal(parseGistId(undefined), '');
});

test('parseGistId — http (not https) URL', () => {
  assert.equal(
    parseGistId('http://gist.github.com/octocat/abc123def456'),
    'abc123def456'
  );
});

test('VERIFICATION_FILE constant', () => {
  assert.equal(VERIFICATION_FILE, 'tokenphage.txt');
});

test('clearSyncState_reset_lastSyncDate와lastSyncVersion모두삭제_나머지보존', () => {
  // Given: sync 상태 두 값과 인증·기기 정보가 있는 설정
  const config = { token: 'a.b.c', deviceId: 'device-1', lastSyncDate: '2026-10-10', lastSyncVersion: '2026.10.0' };
  let saved;

  // When
  clearSyncState({ readConfig: () => ({ ...config }), writeConfig: (cfg) => { saved = cfg; } });

  // Then: 두 값만 지워 다음 sync가 토큰·실행시간을 처음부터 보낸다
  assert.deepEqual(saved, { token: 'a.b.c', deviceId: 'device-1' });
});
