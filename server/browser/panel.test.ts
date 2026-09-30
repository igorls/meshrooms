import { expect, test } from 'bun:test';
import { BOARD_DEFAULT, BOARD_MIN, boardLimits, clampBoardWidth, parseBoardWidth } from '../../src/browser/panel';

test('the task board stays within 70% of the viewport and leaves the conversation 360 px', () => {
  // 1440 px window with the full sidebar: the workspace is 1224 px, so the conversation limit decides.
  expect(boardLimits(1224, 1440)).toEqual({ min: BOARD_MIN, max: 864 });
  // A wide workspace is capped by the viewport instead.
  expect(boardLimits(2000, 2000).max).toBe(1400);
  expect(clampBoardWidth(1000, 1224, 1440)).toBe(864);
  expect(clampBoardWidth(120, 1224, 1440)).toBe(BOARD_MIN);
  expect(clampBoardWidth(512.4, 1224, 1440)).toBe(512);
  // Too little room for both: the minimum wins, and the stylesheet lets the board replace the conversation.
  expect(boardLimits(600, 800)).toEqual({ min: BOARD_MIN, max: BOARD_MIN });
  expect(clampBoardWidth(500, 600, 800)).toBe(BOARD_MIN);
});

test('saved widths fall back to the default unless they are usable numbers', () => {
  expect(parseBoardWidth('512')).toBe(512);
  expect(parseBoardWidth('512.6')).toBe(513);
  for (const value of [null, undefined, '', 'wide', 'NaN', 'Infinity', '12', '-400']) expect(parseBoardWidth(value)).toBe(BOARD_DEFAULT);
});
