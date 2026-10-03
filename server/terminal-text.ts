/**
 * Text bound for a terminal or a log a person reads, made inert. Room text and harness output can carry escape sequences
 * that move the cursor, rewrite or hide lines, retitle the window or smuggle a link (ESC, CSI, OSC, DCS), and Unicode
 * bidi overrides that make a line read differently from what it holds. All of those are removed; newlines and tabs stay.
 * JSON output needs none of this (JSON.stringify escapes control characters), so data there is left intact.
 */
export function terminalSafe(text: string): string {
  return text
    // OSC (ESC ]) up to BEL or ST, and DCS, SOS, PM, APC (ESC P X ^ _) up to ST, including an unterminated one.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, '')
    // CSI (ESC [) with its parameters and final byte.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Any other escape sequence, or a lone ESC.
    .replace(/\x1b[ -/]*[0-~]?/g, '')
    // C0 controls but tab and newline, DEL, and C1 controls (0x9b is CSI on its own).
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    // Bidi embeddings, overrides and isolates.
    .replace(/[‪-‮⁦-⁩]/g, '');
}
