import chalk from 'chalk';

// 로고 세로 그라데이션 색 스톱 (위: 밝은 라벤더 보라 → 아래: 미디엄 퍼플)
export const PURPLE_STOPS = [
  [221, 198, 255], // #DDC6FF
  [165, 124, 255], // #A57CFF
  [110, 70, 168],  // #6E46A8
];

// 느낌표 강조 그라데이션 색 스톱 (위: 밝은 민트 → 아래: 진한 민트 시안)
export const ACCENT_STOPS = [
  [94, 234, 212], // #5EEAD4
  [45, 212, 191], // #2DD4BF
];

// 흐르는 그라데이션 색 스톱 (쨍한 노랑 → 흰색 → 쨍한 노랑). 양 끝이 같아 매끄럽게 순환한다.
export const FLOW_STOPS = [
  [255, 214, 0],   // #FFD600
  [255, 255, 255], // #FFFFFF
  [255, 214, 0],   // #FFD600
];

// CLI 공용 하이라이트 색 — 느낌표 강조색(민트 시안)과 통일.
// 메뉴 선택 하이라이트, 강조 텍스트 등 모든 하이라이팅은 이 색을 사용한다.
export const ACCENT_HEX = '#5EEAD4';
export const accent = (text) => chalk.hex(ACCENT_HEX)(text);

/** 두 RGB 색 사이를 t(0~1) 비율로 선형 보간해 hex 문자열로 반환. */
function lerpHex(from, to, t) {
  const ch = (a, b) => Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
  return `#${ch(from[0], to[0])}${ch(from[1], to[1])}${ch(from[2], to[2])}`;
}

/** 0~1 위치를 다색 스톱 위에서 보간해 hex 색을 반환. */
export function colorAt(t, stops) {
  const seg = t * (stops.length - 1);
  const idx = Math.min(Math.floor(seg), stops.length - 2);
  return lerpHex(stops[idx], stops[idx + 1], seg - idx);
}

/**
 * 문자열의 각 문자에 위상(phase) offset을 줘 시간에 따라 흐르는 그라데이션을 입힌다.
 * 문자 위치(i/n)에 phase를 더해 0~1로 wrap한 뒤 colorAt으로 색을 구한다.
 * @param {string} text  대상 문자열
 * @param {number} phase 0~1 위상 offset (프레임/시간 기반으로 증가시키면 흐르는 효과)
 * @param {number[][]} stops 색 스톱 배열 (기본 FLOW_STOPS)
 * @returns {string} ANSI 색이 입혀진 문자열
 */
export function flowText(text, phase, stops = FLOW_STOPS) {
  const chars = [...text]; // 유니코드 안전 분해
  const n = Math.max(chars.length, 1);
  return chars
    .map((char, i) => {
      const t = (((i / n) + phase) % 1 + 1) % 1; // 음수 방지 wrap
      return chalk.hex(colorAt(t, stops))(char);
    })
    .join('');
}
