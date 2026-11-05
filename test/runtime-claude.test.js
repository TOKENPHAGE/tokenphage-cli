import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { parseClaudeFiles } from '../src/parsers/claude.js';
import { createClaudeRuntimeCollector } from '../src/runtime/claude.js';

// 테스트 목록 (Claude 로그 해석 — 턴 경계·중복 제거·모델만 본다. 타임라인 규칙은 runtime-timeline 테스트)
// 1. claude추출_메인서브에이전트워크플로파일_합산하고source는claude          (해피)
// 2. claude추출_깨진JSON줄_건너뛰고나머지계산                               (실패)
// 3. claude추출_promptId가바뀌는user레코드_턴시작                            (엣지)
// 4. claude추출_질문직전첨부와훅기록_턴에안들어감                            (엣지)
// 5. claude추출_중단표시압축요약로컬명령_턴시작아님                          (엣지, promptId 있음·없음)
// 6. claude추출_task_notification과peer_턴시작                              (엣지, promptId 있음·없음)
// 7. claude추출_포크복사본_파일순서와상관없이원본만1회                       (엣지)
// 8. claude추출_포크의포크_앞복사본을가리켜도원본까지따라가1회               (엣지)
// 9. claude추출_resume복사본같은uuid_1회                                     (엣지)
// 10. claude추출_journal_jsonl_제외                                          (엣지)
// 11. claude추출_세션중모델전환_구간별모델                                   (엣지)
// 12. claude추출_서브에이전트파일_promptId가바뀌어도첫레코드부터한턴         (엣지)
// 13. claude추출_수집중예외_던지지않고실패로보고                              (실패)
// 14. claude추출_사용자폴더이름에subagents_메인파일로판별                    (엣지)

// 실제 로그에서 범주별 대표 줄을 허용 목록 키만 남겨 뽑은 모양(값은 자리표시자).
const SHAPES = {
  humanPrompt: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    origin: {
      kind: "human"
    },
    message: {
      role: "user",
      content: ""
    }
  },
  humanPromptArray: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: ""
        }
      ]
    }
  },
  assistant: {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        {
          type: "thinking"
        }
      ]
    }
  },
  syntheticAssistant: {
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    message: {
      role: "assistant",
      model: "<synthetic>",
      content: [
        {
          type: "text",
          text: ""
        }
      ]
    }
  },
  toolResult: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    toolUseResult: {},
    message: {
      role: "user",
      content: [
        {
          type: "tool_result"
        }
      ]
    }
  },
  attachmentHook: {
    type: "attachment",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    attachment: {
      type: "hook_success"
    }
  },
  systemStopHook: {
    type: "system",
    subtype: "stop_hook_summary",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x"
  },
  systemTurnDuration: {
    type: "system",
    subtype: "turn_duration",
    isMeta: false,
    isSidechain: false,
    durationMs: 19300,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x"
  },
  interrupted: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "[Request interrupted by user]"
        }
      ]
    }
  },
  compactSummary: {
    type: "user",
    isCompactSummary: true,
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: ""
    }
  },
  localCaveat: {
    type: "user",
    isMeta: true,
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: "<local-command-caveat></local-command-caveat>"
    }
  },
  localCommand: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: "<command-name>/cmd</command-name>"
    }
  },
  localStdout: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: "<local-command-stdout></local-command-stdout>"
    }
  },
  taskNotification: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    origin: {
      kind: "task-notification"
    },
    message: {
      role: "user",
      content: "<task-notification></task-notification>"
    }
  },
  peer: {
    type: "user",
    isMeta: true,
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    origin: {
      kind: "peer"
    },
    message: {
      role: "user",
      content: ""
    }
  },
  forkCopy: {
    type: "user",
    isSidechain: false,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    origin: {
      kind: "human"
    },
    forkedFrom: {
      sessionId: "session-orig",
      messageUuid: "uuid-orig"
    },
    message: {
      role: "user",
      content: ""
    }
  },
  subagentUser: {
    type: "user",
    isSidechain: true,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: ""
    }
  },
  subagentAssistant: {
    type: "assistant",
    isSidechain: true,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    message: {
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        {
          type: "thinking"
        }
      ]
    }
  },
  subagentToolResult: {
    type: "user",
    isSidechain: true,
    timestamp: "2026-06-10T00:00:00.000Z",
    uuid: "uuid-x",
    promptId: "prompt-x",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result"
        }
      ]
    }
  }
};
const MODEL = SHAPES.assistant.message.model;

let root;
let caseSeq = 0;
let uuidSeq = 0;
before(() => { root = mkdtempSync(join(tmpdir(), 'tp-rt-claude-')); });
after(() => { rmSync(root, { recursive: true, force: true }); });

/** 2026-06-10 09:00 로컬 기준 s초 뒤의 UTC ISO 시각(실제 로그와 같은 형식). */
function at(s) {
  return new Date(2026, 5, 10, 9, 0, s).toISOString();
}

function rec(shape, s, fields = {}) {
  return { ...structuredClone(SHAPES[shape]), timestamp: at(s), uuid: `u${uuidSeq++}`, ...fields };
}
function ask(s, promptId, shape = 'humanPrompt') {
  return rec(shape, s, { promptId });
}
function answer(s, model = MODEL, fields = {}) {
  const r = rec('assistant', s, fields);
  r.message.model = model;
  return r;
}
function toolResult(s, promptId) {
  return rec('toolResult', s, { promptId });
}
/** promptId가 없던 옛 버전 모양으로 바꾼다. */
function legacy(record) {
  const { promptId: _p, ...rest } = record;
  if (rest.origin?.kind === 'human') delete rest.origin;
  return rest;
}

function projectDir() {
  return join(root, `case${caseSeq++}`, 'projects', '-proj');
}
function write(dir, relPath, lines) {
  const file = join(dir, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
}

async function runtimeOf(files) {
  const collector = createClaudeRuntimeCollector();
  await parseClaudeFiles(files, collector.onRecord);
  return collector.result();
}
const total = (rows) => rows.reduce((sum, r) => sum + r.runtimeMs, 0);

test('claude추출_메인서브에이전트워크플로파일_합산하고source는claude', async () => {
  // Given: 메인 10초, 서브에이전트 20초, 워크플로 에이전트 30초
  const dir = projectDir();
  const files = [
    write(dir, 'sess-1.jsonl', [ask(0, 'p1'), answer(10)]),
    write(dir, 'sess-1/subagents/agent-a1.jsonl', [rec('subagentUser', 2, { promptId: 'p1' }), rec('subagentAssistant', 22)]),
    write(dir, 'sess-1/subagents/workflows/wf_1/agent-b1.jsonl', [
      rec('subagentUser', 5, { promptId: 'p1' }), rec('subagentToolResult', 20, { promptId: 'p1' }), rec('subagentAssistant', 35),
    ]),
  ];

  // When
  const { source, ok, rows } = await runtimeOf(files);

  // Then: 실행 단위마다 계산해 더하고 source는 읽은 로그로 정해진다
  assert.equal(source, 'claude');
  assert.equal(ok, true);
  assert.deepEqual(rows, [{ date: '2026-06-10', source: 'claude', model: MODEL, runtimeMs: 60_000 }]);
});

test('claude추출_사용자폴더이름에subagents_메인파일로판별', async () => {
  // Given: Claude 설정 폴더가 이름이 subagents인 폴더 아래 있고, 두 턴 사이 70초 쉼
  const dir = join(root, `case${caseSeq++}`, 'subagents', '.claude', 'projects', '-proj');
  const files = [write(dir, 's.jsonl', [ask(0, 'p1'), answer(10), ask(80, 'p2'), answer(90)])];

  // When
  const { rows } = await runtimeOf(files);

  // Then: projects/ 아래 경로로만 판별해 메인 파일로 보고, 턴 사이 쉼은 세지 않는다
  assert.equal(total(rows), 20_000);
});

test('claude추출_깨진JSON줄_건너뛰고나머지계산', async () => {
  // Given: 턴 중간에 깨진 줄과 빈 줄
  const files = [write(projectDir(), 's.jsonl', [ask(0, 'p1'), '{broken json', answer(10), toolResult(20, 'p1'), '', answer(30)])];

  // When
  const { ok, rows } = await runtimeOf(files);

  // Then: 깨진 줄만 건너뛰고 실패로 치지 않는다
  assert.equal(ok, true);
  assert.equal(total(rows), 30_000);
});

test('claude추출_promptId가바뀌는user레코드_턴시작', async () => {
  // Given: 같은 promptId의 도구 결과는 턴 안, 새 promptId의 질문은 새 턴(사이 70초 쉼)
  const files = [write(projectDir(), 's.jsonl', [
    ask(0, 'p1'), answer(10), toolResult(20, 'p1'), answer(30),
    ask(100, 'p2'), answer(110),
  ])];

  // When / Then: 30초 + 10초(쉬는 70초는 빠지고, 도구 결과에서 턴이 끊기지 않는다)
  assert.equal(total((await runtimeOf(files)).rows), 40_000);
});

test('claude추출_질문직전첨부와훅기록_턴에안들어감', async () => {
  // Given: 응답 뒤 훅 요약·turn_duration, 다음 질문 직전 첨부(파일 순서는 질문 뒤지만 시각은 앞선 것 포함)
  const files = [write(projectDir(), 's.jsonl', [
    ask(0, 'p1'), answer(10), rec('systemStopHook', 11), rec('systemTurnDuration', 11), rec('attachmentHook', 95),
    ask(100, 'p2'), rec('attachmentHook', 99), answer(110),
  ])];

  // When / Then: 첨부·시스템 기록은 응답이 아니라 턴 끝을 늘리지 않는다
  assert.equal(total((await runtimeOf(files)).rows), 20_000);
});

test('claude추출_중단표시압축요약로컬명령_턴시작아님', async () => {
  // Given: 턴 안에 중단 표시·압축 요약·로컬 명령 출력, promptId 없는 명령 레코드가 끼어 있다
  const withPromptId = [
    ask(0, 'p1'), answer(10),
    rec('interrupted', 20, { promptId: 'p1' }), answer(30),
    rec('compactSummary', 40, { promptId: 'p1' }), answer(50),
    rec('localStdout', 60, { promptId: 'p1' }), answer(70),
    legacy(rec('localCommand', 80)), answer(90),
  ];
  const withoutPromptId = [
    legacy(ask(0)), answer(10),
    legacy(rec('interrupted', 20)), answer(30),
    legacy(rec('compactSummary', 40)), answer(50),
    legacy(rec('localStdout', 60)), answer(70),
    legacy(rec('localCaveat', 80)), answer(90),
    legacy(ask(200)), answer(210),
  ];

  // When
  const modern = await runtimeOf([write(projectDir(), 's.jsonl', withPromptId)]);
  const old = await runtimeOf([write(projectDir(), 's.jsonl', withoutPromptId)]);

  // Then: 턴이 끊기지 않아 90초, 옛 버전은 사람이 입력한 질문에서만 새 턴(+10초)
  assert.equal(total(modern.rows), 90_000);
  assert.equal(total(old.rows), 100_000);
});

test('claude추출_task_notification과peer_턴시작', async () => {
  // Given: 응답 뒤 190초씩 쉬고 작업 완료 알림, 다른 세션 메시지가 도착
  const records = [
    ask(0, 'p1'), answer(10),
    rec('taskNotification', 200, { promptId: 't1' }), answer(210),
    rec('peer', 400, { promptId: 'peer1' }), answer(410),
  ];

  // When
  const modern = await runtimeOf([write(projectDir(), 's.jsonl', records)]);
  const old = await runtimeOf([write(projectDir(), 's.jsonl', records.map((r) => (r.type === 'user' ? legacy(r) : r)))]);

  // Then: 각각 새 턴이라 쉬는 시간은 빠지고 10초씩 3턴
  assert.equal(total(modern.rows), 30_000);
  assert.equal(total(old.rows), 30_000);
});

test('claude추출_포크복사본_파일순서와상관없이원본만1회', async () => {
  // Given: 원본 세션(10초)과, 그 기록을 새 uuid로 복사한 뒤 새 턴(10초)을 이어간 포크 세션
  const dir = projectDir();
  const original = write(dir, 'orig.jsonl', [ask(0, 'p1', 'humanPrompt'), answer(10)].map((r, i) => ({ ...r, uuid: `o${i}` })));
  const fork = write(dir, 'fork.jsonl', [
    rec('forkCopy', 0, { promptId: 'p1', forkedFrom: { sessionId: 'orig', messageUuid: 'o0' } }),
    answer(10, MODEL, { forkedFrom: { sessionId: 'orig', messageUuid: 'o1' } }),
    ask(100, 'p2'), answer(110),
  ]);

  // When
  const forward = await runtimeOf([original, fork]);
  const backward = await runtimeOf([fork, original]);
  const forkOnly = await runtimeOf([fork]);

  // Then: 복사본은 원본과 같은 것으로 1회만, 원본이 없으면 복사본을 1회 센다
  assert.equal(total(forward.rows), 20_000);
  assert.equal(total(backward.rows), 20_000);
  assert.equal(total(forkOnly.rows), 20_000);
});

test('claude추출_포크의포크_앞복사본을가리켜도원본까지따라가1회', async () => {
  // Given: 원본 → 포크1(복사 + 새 턴) → 포크2(포크1을 복사 + 새 턴). 포크2의 복사본은 포크1의 복사본 uuid를 가리킨다
  const dir = projectDir();
  const from = (messageUuid) => ({ forkedFrom: { sessionId: 'x', messageUuid } });
  const original = write(dir, 'o.jsonl', [ask(0, 'p1', 'humanPrompt'), answer(10)].map((r, i) => ({ ...r, uuid: `o${i}` })));
  const fork1 = write(dir, 'f1.jsonl', [
    rec('forkCopy', 0, { uuid: 'f0', promptId: 'p1', ...from('o0') }), answer(10, MODEL, { uuid: 'f1', ...from('o1') }),
    ask(100, 'p2'), answer(110, MODEL, { uuid: 'n1' }),
  ].map((r) => (r.promptId === 'p2' ? { ...r, uuid: 'n0' } : r)));
  const fork2 = write(dir, 'f2.jsonl', [
    rec('forkCopy', 0, { uuid: 'g0', promptId: 'p1', ...from('f0') }), answer(10, MODEL, { uuid: 'g1', ...from('f1') }),
    rec('forkCopy', 100, { uuid: 'g2', promptId: 'p2', ...from('n0') }), answer(110, MODEL, { uuid: 'g3', ...from('n1') }),
    ask(200, 'p3'), answer(210),
  ]);

  // When
  const { rows } = await runtimeOf([fork2, fork1, original]);

  // Then: 원본 10초 + 포크1 새 턴 10초 + 포크2 새 턴 10초
  assert.equal(total(rows), 30_000);
});

test('claude추출_resume복사본같은uuid_1회', async () => {
  // Given: 이전 파일의 기록을 같은 uuid로 다시 담고 새 턴을 이어간 파일
  const dir = projectDir();
  const copied = [ask(0, 'p1'), answer(10)];
  const earlier = write(dir, 'a.jsonl', copied);
  const resumed = write(dir, 'b.jsonl', [...copied, ask(100, 'p2'), answer(110)]);

  // When / Then: 어느 파일을 먼저 읽어도 10초 + 10초
  assert.equal(total((await runtimeOf([earlier, resumed])).rows), 20_000);
  assert.equal(total((await runtimeOf([resumed, earlier])).rows), 20_000);
});

test('claude추출_journal_jsonl_제외', async () => {
  // Given: 워크플로 폴더의 journal.jsonl에 시각 있는 기록이 있어도
  const dir = projectDir();
  const files = [
    write(dir, 's.jsonl', [ask(0, 'p1'), answer(10)]),
    write(dir, 's/subagents/workflows/wf_1/journal.jsonl', [rec('subagentUser', 0), rec('subagentAssistant', 50)]),
  ];

  // When / Then: 실행 단위가 아니라 메인 10초만
  assert.equal(total((await runtimeOf(files)).rows), 10_000);
});

test('claude추출_세션중모델전환_구간별모델', async () => {
  // Given: 첫 턴은 sonnet, 다음 턴은 기본 모델로 바꿔 질문
  const files = [write(projectDir(), 's.jsonl', [
    ask(0, 'p1'), answer(10, 'claude-sonnet-4-6'), toolResult(20, 'p1'), answer(30, 'claude-sonnet-4-6'),
    ask(100, 'p2'), answer(110), toolResult(120, 'p2'), answer(140),
  ])];

  // When
  const { rows } = await runtimeOf(files);

  // Then: assistant의 message.model별로 나뉜다
  assert.deepEqual(rows.map((r) => [r.model, r.runtimeMs]), [['claude-sonnet-4-6', 30_000], [MODEL, 40_000]]);
});

test('claude추출_수집중예외_던지지않고실패로보고', () => {
  // Given: 읽는 순간 예외가 나는 레코드(토큰 파서의 줄 처리에 예외가 번지면 안 된다)
  const collector = createClaudeRuntimeCollector();
  const hostile = { type: 'user', get timestamp() { throw new Error('boom'); } };

  // When / Then
  assert.doesNotThrow(() => collector.onRecord(hostile, 's.jsonl'));
  assert.equal(collector.result().ok, false);
});

test('claude추출_서브에이전트파일_promptId가바뀌어도첫레코드부터한턴', async () => {
  // Given: 서브에이전트 파일 안에서 promptId가 바뀌고, 시각이 가장 이른 첨부가 파일 중간에 있다
  const files = [write(projectDir(), 's/subagents/agent-a1.jsonl', [
    rec('subagentUser', 0, { promptId: 'p1' }), rec('attachmentHook', -5), rec('subagentAssistant', 10),
    rec('subagentUser', 100, { promptId: 'p2' }), rec('subagentAssistant', 110),
  ])];

  // When / Then: 가장 이른 기록(-5초)부터 마지막 응답(110초)까지 한 턴
  assert.equal(total((await runtimeOf(files)).rows), 115_000);
});
