/** Task board widths beside the conversation. browser.css repeats these bounds so the first paint is already clamped. */
export const BOARD_MIN = 300, BOARD_DEFAULT = 380, BOARD_STEP = 24, CONVERSATION_MIN = 360;
const BOARD_KEY = 'meshrooms:board-width';

/** At most 70% of the viewport and never so wide the conversation drops below its minimum; the board minimum wins. */
export function boardLimits(available: number, viewport: number) {
  return { min: BOARD_MIN, max: Math.max(BOARD_MIN, Math.floor(Math.min(viewport * 0.7, available - CONVERSATION_MIN))) };
}
export function clampBoardWidth(width: number, available: number, viewport: number) {
  const { min, max } = boardLimits(available, viewport);
  return Math.round(Math.min(max, Math.max(min, width)));
}
export function parseBoardWidth(value: string | null | undefined) {
  const width = Number(value);
  return value && Number.isFinite(width) && width >= BOARD_MIN ? Math.round(width) : BOARD_DEFAULT;
}
export function savedBoardWidth() {
  try { return parseBoardWidth(localStorage.getItem(BOARD_KEY)); } catch { return BOARD_DEFAULT; }
}
/** `undefined` forgets the choice, so the default applies again. */
export function saveBoardWidth(width: number | undefined) {
  try { if (width === undefined) localStorage.removeItem(BOARD_KEY); else localStorage.setItem(BOARD_KEY, String(width)); } catch { /* storage may be unavailable */ }
}
