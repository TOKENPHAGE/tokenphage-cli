import {
  createPrompt,
  useState,
  useEffect,
  useKeypress,
  usePrefix,
  makeTheme,
  isEnterKey,
  isUpKey,
  isDownKey,
} from '@inquirer/core';
import chalk from 'chalk';
import { flowText, accent } from './gradient.js';

// 애니메이션 타이밍: PERIOD(ms)마다 한 프레임, CYCLE 프레임에 그라데이션 한 바퀴.
// 80ms × 24 ≈ 1.9초/바퀴 — PERIOD는 깜빡임/CPU 안전선(80ms)을 유지
const PERIOD = 80;
const CYCLE = 24;

// 흐르는 애니메이션 활성 조건. 비TTY·NO_COLOR·dumb 터미널·색 미지원이거나
// TOKENPHAGE_NO_ANIM=1(reduced-motion 옵트아웃)이면 정적으로 폴백한다.
const ANIM_ENABLED =
  process.stdout.isTTY === true &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  chalk.level > 0 &&
  process.env.TOKENPHAGE_NO_ANIM !== '1';

// 메뉴(입력창 없음) 표시 중 터미널 커서를 숨기기 위한 DECTCEM 시퀀스.
const HIDE_CURSOR = '\x1B[?25l';
const SHOW_CURSOR = '\x1B[?25h';
// 커서 복원(비TTY면 무시). 종료/언마운트 모든 경로에서 호출.
const showCursor = () => { if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR); };

/**
 * Esc 즉시 종료 + (선택적) 흐르는 그라데이션을 지원하는 커스텀 select.
 * choice에 `flow: true`가 있으면 커서 위치와 무관하게 항상 그라데이션이 흐른다.
 * pagination/disabled/검색은 메뉴 항목이 적어 의도적으로 생략한다.
 */
export const selectWithEsc = createPrompt((config, done) => {
  const { message, choices } = config;
  const theme = makeTheme(config.theme);
  const [status, setStatus] = useState('idle');
  const [active, setActive] = useState(0);
  const [frame, setFrame] = useState(0);

  const prefix = usePrefix({ status, theme });
  const hasFlow = choices.some((choice) => choice.flow);

  // 흐르는 그라데이션 타이머. flow 항목이 있고 애니메이션이 켜졌을 때만 가동.
  // 시간 기반 phase라 useState 업데이터 함수 미지원 제약을 피하고 drift도 없다.
  useEffect(() => {
    if (status === 'done' || !ANIM_ENABLED || !hasFlow) return undefined;
    const id = setInterval(() => {
      setFrame(Math.floor(Date.now() / PERIOD) % CYCLE);
    }, PERIOD);
    return () => clearInterval(id);
  }, [status]);

  // 메뉴 표시 중에는 입력창이 없으므로 터미널 커서를 숨긴다.
  // done()/정상 종료 시 언마운트 cleanup으로 복원된다. Esc 경로는 키 핸들러에서 별도 복원.
  useEffect(() => {
    if (process.stdout.isTTY) process.stdout.write(HIDE_CURSOR);
    return () => showCursor();
  }, []);

  useKeypress((key) => {
    if (key.name === 'escape') {
      showCursor();    // process.exit는 useEffect cleanup을 건너뛰므로 명시 복원
      process.exit(0); // 기존 selectWithEsc 동작 유지: Esc는 즉시 종료
    } else if (isEnterKey(key)) {
      setStatus('done');
      done(choices[active].value);
    } else if (isUpKey(key)) {
      setActive((active - 1 + choices.length) % choices.length);
    } else if (isDownKey(key)) {
      setActive((active + 1) % choices.length);
    }
  });

  const header = `${prefix} ${theme.style.message(message, status)}`;

  // 완료 시: 선택값 한 줄만 남기고 리스트/설명은 지운다.
  if (status === 'done') {
    const selected = choices[active];
    return `${header} ${accent(selected.short ?? selected.name)}`;
  }

  const phase = frame / CYCLE;
  const lines = choices.map((choice, i) => {
    const isActive = i === active;
    const pointer = isActive ? accent('❯ ') : '  ';

    let label;
    if (choice.flow && ANIM_ENABLED) {
      label = flowText(choice.name, phase); // 흐르는 그라데이션 (커서 무관)
    } else if (choice.flow || isActive) {
      label = accent(choice.name); // 애니 꺼진 flow 항목 / 커서 항목 → 정적 민트
    } else {
      label = choice.name; // 그 외 → 평문
    }
    return pointer + label;
  });

  const activeChoice = choices[active];
  const bottom = activeChoice?.description ? accent(activeChoice.description) : '';

  return [`${header}\n${lines.join('\n')}`, bottom];
});
