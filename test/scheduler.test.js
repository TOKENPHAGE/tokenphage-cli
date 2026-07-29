import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyncPs1, buildTaskXml, buildCronBlock, removeCronBlock, upsertCronContent, classifyLaunchctlProbe, CRON_BEGIN, CRON_END } from '../src/scheduler.js';

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

// ─── linux cron (buildCronBlock / removeCronBlock / upsertCronContent) ───────
// 테스트 목록:
//  1. buildCronBlock_기본_04시00분식과래퍼호출 (성공)
//  2. buildCronBlock_공백경로_shSingleQuote로인용 (경계)
//  3. removeCronBlock_기존블록_우리블록만제거하고타인라인보존 (성공)
//  4. upsertCronContent_두번적용_블록은항상1개 (멱등/경계)
//  5. upsertCronContent_빈crontab_블록만+trailing_newline (경계)

test('buildCronBlock — 매일 04:00 스케줄과 sh 래퍼 호출을 담는다', () => {
  // Act
  const block = buildCronBlock('/home/u/.tokenphage/run-sync.sh', '/home/u/.tokenphage/logs/sync.log');

  // Assert
  assert.match(block, /^# BEGIN dev\.tokenphage\.sync/m);
  assert.match(block, /0 4 \* \* \* \/bin\/sh /);
  assert.match(block, />> '\/home\/u\/\.tokenphage\/logs\/sync\.log' 2>&1/);
  assert.match(block, /# END dev\.tokenphage\.sync$/m);
});

test('buildCronBlock — 공백 든 경로를 shSingleQuote로 안전 인용한다', () => {
  // Act
  const block = buildCronBlock('/home/My User/run-sync.sh', '/home/My User/sync.log');

  // Assert
  assert.match(block, /\/bin\/sh '\/home\/My User\/run-sync\.sh'/);
});

test('removeCronBlock — 우리 블록만 제거하고 타인 cron 라인은 보존한다', () => {
  // Arrange
  const existing = `0 * * * * /usr/bin/other\n${CRON_BEGIN}\n0 4 * * * /bin/sh x\n${CRON_END}\n30 2 * * * /usr/bin/keep`;

  // Act
  const out = removeCronBlock(existing);

  // Assert
  assert.match(out, /\/usr\/bin\/other/);
  assert.match(out, /\/usr\/bin\/keep/);
  assert.doesNotMatch(out, /run-sync|BEGIN dev\.tokenphage/);
});

test('upsertCronContent — 두 번 적용해도 블록은 항상 1개다(멱등)', () => {
  // Arrange
  const block = buildCronBlock('/w.sh', '/l.log');

  // Act
  const once = upsertCronContent('0 * * * * /usr/bin/other', block);
  const twice = upsertCronContent(once, block);

  // Assert
  assert.equal(once, twice);
  assert.equal((twice.match(/# BEGIN dev\.tokenphage\.sync/g) || []).length, 1);
  assert.match(twice, /\/usr\/bin\/other/); // 남의 라인 보존
  assert.ok(twice.endsWith('\n'));           // trailing newline
});

test('upsertCronContent — 빈 crontab이면 블록만 남고 개행으로 끝난다', () => {
  // Act
  const out = upsertCronContent('', buildCronBlock('/w.sh', '/l.log'));

  // Assert
  assert.match(out, /^# BEGIN/);
  assert.ok(out.endsWith('\n'));
});

test('buildCronBlock — 경로의 %를 \\%로 이스케이프해 cron 명령 절단을 막는다', () => {
  // Act: % 든 홈 경로
  const block = buildCronBlock('/home/user%40corp/run-sync.sh', '/l.log');

  // Assert: raw %가 아니라 \% 로 이스케이프되어 cron 파서가 개행으로 오해하지 않는다
  assert.match(block, /\/home\/user\\%40corp\/run-sync\.sh/);
});

test('buildCronBlock — 경로에 개행이 있으면 단일 엔트리 불가라 throw한다', () => {
  // Act / Assert
  assert.throws(() => buildCronBlock('/home/a\nb/run-sync.sh', '/l.log'), /개행/);
});

test('removeCronBlock — END 없는 고아 BEGIN이면 삭제 없이 사용자 라인을 보존한다', () => {
  // Arrange: BEGIN만 있고 END 없음 + 뒤에 사용자 작업 (손상 상태)
  const orphan = `${CRON_BEGIN}\n0 4 * * * /bin/sh x\n30 2 * * * /usr/bin/critical-backup`;

  // Act
  const out = removeCronBlock(orphan);

  // Assert: 파괴적 삭제 대신 사용자 라인 보존
  assert.match(out, /\/usr\/bin\/critical-backup/);
});

// ─── classifyLaunchctlProbe ──────────────────────────────────────────────────
// 테스트 목록:
//  1. classifyLaunchctlProbe_종료코드별_113만미등록으로판정 (성공/경계)

test('classifyLaunchctlProbe — 113만 확정 미등록이고 나머지는 판정 불가다', () => {
  // Given / When / Then: 113(서비스 없음)만 재등록 대상이다.
  assert.equal(classifyLaunchctlProbe({ status: 113 }), 'missing');

  // 112(도메인 없음 — SSH 등)는 예약이 살아있을 수 있어 건드리면 안 된다.
  assert.equal(classifyLaunchctlProbe({ status: 112 }), 'unknown');

  // launchctl 자체가 없거나 timeout(SIGTERM → status null)이면 판정할 수 없다.
  assert.equal(classifyLaunchctlProbe({ code: 'ENOENT' }), 'unknown');
  assert.equal(classifyLaunchctlProbe({ status: null, signal: 'SIGTERM' }), 'unknown');
});

// ─── export 가드 ─────────────────────────────────────────────────────────────

test('순수 빌더가 함수로 export되어 테스트 가능하다', () => {
  assert.equal(typeof buildSyncPs1, 'function');
  assert.equal(typeof buildTaskXml, 'function');
  assert.equal(typeof buildCronBlock, 'function');
  assert.equal(typeof removeCronBlock, 'function');
  assert.equal(typeof upsertCronContent, 'function');
  assert.equal(typeof classifyLaunchctlProbe, 'function');
});
