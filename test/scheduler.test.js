import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPs1, buildTaskXml } from '../src/scheduler.js';

// 순수 빌더만 검증한다 — schtasks/launchctl 호출이나 파일 쓰기가 없어 OS 무관하게 돈다.

const SCRIPT = 'C:\\Users\\dev\\app\\src\\index.js';
const LOG = 'C:\\Users\\dev\\.tokenphage\\logs\\sync.log';

// ─── buildSyncPs1 ────────────────────────────────────────────────────────────

test('buildSyncPs1 — node 탐색 체인을 PATH → nvm → fnm → volta 순서로 담는다', () => {
  // Act
  const ps1 = buildSyncPs1(SCRIPT, LOG);

  // Assert: 각 분기가 존재하고
  assert.match(ps1, /Get-Command node/);     // 1) PATH
  assert.match(ps1, /NVM_SYMLINK/);           // 2) nvm-windows
  assert.match(ps1, /node-versions/);         // 3) fnm
  assert.match(ps1, /VOLTA_HOME/);            // 4) volta
  assert.match(ps1, /nodejs\\node\.exe/);     // 5) 표준 설치

  // PATH 분기가 버전 매니저 분기보다 앞선다(권위 순서 고정).
  assert.ok(ps1.indexOf('Get-Command node') < ps1.indexOf('NVM_SYMLINK'));
  assert.ok(ps1.indexOf('NVM_SYMLINK') < ps1.indexOf('node-versions'));
});

test('buildSyncPs1 — $SCRIPT/$LOG를 단일인용 리터럴로 임베드하고 내부 따옴표를 이중화한다', () => {
  // Arrange: 공백과 작은따옴표가 든 경로
  const tricky = "C:\\Users\\Park's Files\\app\\src\\index.js";

  // Act
  const ps1 = buildSyncPs1(tricky, LOG);

  // Assert: 'C:\Users\Park''s Files\app\src\index.js' 형태
  assert.match(ps1, /\$SCRIPT = 'C:\\Users\\Park''s Files\\app\\src\\index\.js'/);
});

test('buildSyncPs1 — node/스크립트 미발견 시 로그 기록 후 exit 127', () => {
  // Act
  const ps1 = buildSyncPs1(SCRIPT, LOG);

  // Assert
  assert.match(ps1, /Test-Path -LiteralPath \$SCRIPT/);
  assert.match(ps1, /exit 127/);
  assert.match(ps1, /node 바이너리를 찾지 못했습니다/);
});

test('buildSyncPs1 — 해석된 node로 sync를 실행하고 모든 스트림을 로그에 append', () => {
  // Act
  const ps1 = buildSyncPs1(SCRIPT, LOG);

  // Assert
  assert.match(ps1, /\$env:Path = \(Split-Path -Parent \$node\)/); // PATH 보강
  assert.match(ps1, /& \$node \$SCRIPT sync \*>> \$LOG/);          // 실행 + append
  assert.match(ps1, /exit \$LASTEXITCODE/);
});

test('buildSyncPs1 — CRLF로 정규화되고 하드코딩 연도가 없다', () => {
  // Act
  const ps1 = buildSyncPs1(SCRIPT, LOG);

  // Assert
  assert.ok(ps1.includes('\r\n'));
  assert.doesNotMatch(ps1, /\b20\d{2}\b/); // 날짜/연도 하드코딩 없음
});

// ─── buildTaskXml ────────────────────────────────────────────────────────────

const PS1_PATH = 'C:\\Users\\dev\\.tokenphage\\run-sync.ps1';

test('buildTaskXml — Exec가 powershell.exe로 래퍼를 호출한다', () => {
  // Act
  const xml = buildTaskXml(PS1_PATH, new Date('2030-07-15T00:00:00'));

  // Assert
  assert.match(xml, /<Command>powershell\.exe<\/Command>/);
  assert.match(xml, /-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File/);
  assert.match(xml, /run-sync\.ps1/);
});

test('buildTaskXml — StartBoundary가 주입된 날짜 기준으로 동적 생성된다', () => {
  // Act
  const xml = buildTaskXml(PS1_PATH, new Date('2030-07-15T00:00:00'));

  // Assert: 주입 날짜 + 04:00, 과거 하드코딩 없음
  assert.match(xml, /<StartBoundary>2030-07-15T04:00:00<\/StartBoundary>/);
  assert.doesNotMatch(xml, /2026-01-01/);
});

test('buildTaskXml — 날짜를 바꾸면 StartBoundary도 바뀐다(하드코딩 아님 증명)', () => {
  // Act
  const a = buildTaskXml(PS1_PATH, new Date('2027-03-09T00:00:00'));
  const b = buildTaskXml(PS1_PATH, new Date('2031-11-30T00:00:00'));

  // Assert
  assert.match(a, /<StartBoundary>2027-03-09T04:00:00<\/StartBoundary>/);
  assert.match(b, /<StartBoundary>2031-11-30T04:00:00<\/StartBoundary>/);
});

test('buildTaskXml — 스케줄/주체 설정은 그대로 유지된다', () => {
  // Act
  const xml = buildTaskXml(PS1_PATH, new Date('2030-07-15T00:00:00'));

  // Assert
  assert.match(xml, /<DaysInterval>1<\/DaysInterval>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
});

test('buildTaskXml — ps1 경로의 XML 특수문자를 이스케이프한다', () => {
  // Arrange: & 가 든 경로
  const amp = 'C:\\R&D\\.tokenphage\\run-sync.ps1';

  // Act
  const xml = buildTaskXml(amp, new Date('2030-07-15T00:00:00'));

  // Assert: 원시 & 는 없고 &amp; 로 인코딩
  assert.match(xml, /R&amp;D/);
  assert.doesNotMatch(xml, /R&D/);
});

test('buildTaskXml — UTF-16LE+BOM 인코딩이 원본 XML로 라운드트립된다', () => {
  // Arrange
  const xml = buildTaskXml(PS1_PATH, new Date('2030-07-15T00:00:00'));

  // Act: installWindows와 동일한 인코딩 절차
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]);

  // Assert
  assert.equal(buf[0], 0xFF);
  assert.equal(buf[1], 0xFE);
  assert.equal(buf.subarray(2).toString('utf16le'), xml);
});

// ─── export 가드 ─────────────────────────────────────────────────────────────

test('순수 빌더가 함수로 export되어 테스트 가능하다', () => {
  assert.equal(typeof buildSyncPs1, 'function');
  assert.equal(typeof buildTaskXml, 'function');
});
