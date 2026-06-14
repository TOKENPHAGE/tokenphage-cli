import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGistId, VERIFICATION_FILE } from '../src/auth.js';

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
