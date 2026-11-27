/**
 * Canonical Room VFS path validation, NFC normalization, case-folding, and
 * deterministic collision-suffix resolution.
 *
 * Pure TypeScript, zero dependencies; runs identically in Browser and Bun.
 */

import {
  VFS_PATH_MAX_SEGMENT_CHARS,
  VFS_PATH_MAX_SEGMENTS,
  VFS_PATH_MAX_UTF8_BYTES,
  VfsError,
} from './constants';

export const VFS_MAX_PATH_BYTES = VFS_PATH_MAX_UTF8_BYTES;
export const VFS_MAX_PATH_SEGMENTS = VFS_PATH_MAX_SEGMENTS;
export const VFS_MAX_SEGMENT_CODEPOINTS = VFS_PATH_MAX_SEGMENT_CHARS;

export const VFS_RESERVED_PREFIXES = ['.meshrooms', '.git'] as const;

const textEncoder = new TextEncoder();

// Unicode General Categories Cc (control) and Cf (format, including zero-width &
// bidi controls), explicit bidi/line/paragraph separators (\u2028, \u2029), plus
// invisible/confusable filler, NBSP, CGJ, and variation selector characters.
const CONTROL_OR_FORMAT_RE =
  /[\p{Cc}\p{Cf}\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C\u2028\u2029\u00A0\u034F\u115F\u1160\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;

// Characters forbidden inside any individual path segment (cross-platform safety).
const FORBIDDEN_SEGMENT_CHAR_RE = /[\\:*?"<>|]/;

// Windows reserved device names (case-insensitive, with or without extension),
// including superscript COM¹-³/LPT¹-³ and CONIN$/CONOUT$.
const WINDOWS_RESERVED_NAME_RE =
  /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:\s*\.|$)/i;

export type VfsPathErrorReason =
  | 'empty'
  | 'invalid-unicode'
  | 'too-long-bytes'
  | 'leading-or-trailing-slash'
  | 'empty-segment'
  | 'too-many-segments'
  | 'segment-too-long'
  | 'dot-segment'
  | 'nul-byte'
  | 'control-or-format-char'
  | 'forbidden-char'
  | 'leading-or-trailing-dot-or-space'
  | 'windows-reserved-name'
  | 'reserved-prefix';

export class VfsPathError extends VfsError {
  override readonly code = 'VFS_INVALID_PATH' as const;
  readonly reason: VfsPathErrorReason;
  readonly rawPath: string;

  constructor(reason: VfsPathErrorReason, message: string, rawPath: string) {
    super('VFS_INVALID_PATH', message, {
      status: 400,
      details: { reason, rawPath },
    });
    Object.defineProperty(this, 'name', { value: 'VfsPathError', configurable: true });
    this.reason = reason;
    this.rawPath = rawPath;
  }
}

export type VfsPathValidationResult =
  | {
      ok: true;
      normalized: string;
      folded: string;
      segments: string[];
      byteLength: number;
    }
  | {
      ok: false;
      code: 'VFS_INVALID_PATH';
      reason: VfsPathErrorReason;
      message: string;
    };

/** Returns true if the JS string contains any lone UTF-16 surrogate code unit. */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const cu = value.charCodeAt(i);
    if (cu >= 0xd800 && cu <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // Skip valid low surrogate
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Exact UTF-8 byte length of a valid Unicode string. */
export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Splits a valid Unicode string into Unicode scalar value (code-point) strings. */
function toCodePoints(value: string): string[] {
  return Array.from(value);
}

/**
 * Case-folded comparison key for deterministic sibling collision detection
 * across case-insensitive and case-sensitive filesystems.
 */
export function foldVfsPath(normalizedPath: string): string {
  return normalizedPath.toLocaleLowerCase('en-US');
}

/**
 * Validates and NFC-normalizes a Room VFS relative POSIX path without throwing.
 */
export function validateVfsPath(raw: string): VfsPathValidationResult {
  const fail = (reason: VfsPathErrorReason, message: string): VfsPathValidationResult => ({
    ok: false,
    code: 'VFS_INVALID_PATH',
    reason,
    message,
  });

  if (typeof raw !== 'string' || raw.length === 0) {
    return fail('empty', 'VFS path must be a non-empty string.');
  }

  if (hasLoneSurrogate(raw)) {
    return fail('invalid-unicode', 'VFS path contains an unpaired UTF-16 surrogate.');
  }

  const normalized = raw.normalize('NFC');
  if (normalized.length === 0) {
    return fail('empty', 'VFS path must be non-empty after normalization.');
  }

  if (normalized.includes('\0')) {
    return fail('nul-byte', 'VFS path must not contain NUL bytes.');
  }

  if (CONTROL_OR_FORMAT_RE.test(normalized)) {
    return fail(
      'control-or-format-char',
      'VFS path must not contain Unicode control, format, bidi, or line-separator characters.',
    );
  }

  const byteLength = utf8ByteLength(normalized);
  if (byteLength < 1 || byteLength > VFS_MAX_PATH_BYTES) {
    return fail(
      'too-long-bytes',
      `VFS path exceeds ${VFS_MAX_PATH_BYTES} UTF-8 bytes (got ${byteLength}).`,
    );
  }

  if (normalized.startsWith('/') || normalized.endsWith('/')) {
    return fail('leading-or-trailing-slash', 'VFS path must be relative without leading or trailing "/".');
  }

  const segments = normalized.split('/');
  if (segments.length > VFS_MAX_PATH_SEGMENTS) {
    return fail(
      'too-many-segments',
      `VFS path exceeds maximum depth of ${VFS_MAX_PATH_SEGMENTS} segments (got ${segments.length}).`,
    );
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) {
      return fail('empty-segment', 'VFS path must not contain empty segments ("//").');
    }

    if (seg === '.' || seg === '..') {
      return fail('dot-segment', `VFS path segment "${seg}" is not allowed.`);
    }

    const segFolded = seg.toLocaleLowerCase('en-US');
    if (segFolded === '.meshrooms' || segFolded === '.git') {
      return fail('reserved-prefix', `VFS path segment "${seg}" is reserved.`);
    }

    const cpCount = toCodePoints(seg).length;
    if (cpCount < 1 || cpCount > VFS_MAX_SEGMENT_CODEPOINTS) {
      return fail(
        'segment-too-long',
        `VFS path segment exceeds ${VFS_MAX_SEGMENT_CODEPOINTS} code points (got ${cpCount}).`,
      );
    }

    if (FORBIDDEN_SEGMENT_CHAR_RE.test(seg)) {
      return fail('forbidden-char', `VFS path segment "${seg}" contains a forbidden character.`);
    }

    if (seg.startsWith(' ') || seg.endsWith(' ') || seg.endsWith('.')) {
      return fail(
        'leading-or-trailing-dot-or-space',
        `VFS path segment "${seg}" must not have leading/trailing spaces or a trailing dot.`,
      );
    }

    if (WINDOWS_RESERVED_NAME_RE.test(seg)) {
      return fail(
        'windows-reserved-name',
        `VFS path segment "${seg}" uses a reserved Windows device name.`,
      );
    }
  }

  return {
    ok: true,
    normalized,
    folded: foldVfsPath(normalized),
    segments,
    byteLength,
  };
}

/**
 * Validates and returns the canonical NFC-normalized VFS path.
 * Throws `VfsPathError` (with `.code === 'VFS_INVALID_PATH'`) if invalid.
 */
export function normalizeVfsPath(raw: string): string {
  const result = validateVfsPath(raw);
  if (!result.ok) {
    throw new VfsPathError(result.reason, result.message, raw);
  }
  return result.normalized;
}

/** Truncates a string by whole Unicode code points to fit both code-point and UTF-8 byte caps. */
function truncateCodePoints(str: string, maxCp: number, maxBytes: number): string {
  if (maxCp <= 0 || maxBytes <= 0) return '';
  const cps = toCodePoints(str);
  let out = '';
  let usedBytes = 0;
  const limit = Math.min(cps.length, maxCp);
  for (let i = 0; i < limit; i++) {
    const cp = cps[i]!;
    const cpBytes = utf8ByteLength(cp);
    if (usedBytes + cpBytes > maxBytes) break;
    out += cp;
    usedBytes += cpBytes;
  }
  return out;
}

/**
 * Computes a deterministic sibling collision path:
 * - `name.ext` -> `name (conflict-<nodeId[0..8]>).ext`
 * - `name`     -> `name (conflict-<nodeId[0..8]>)`
 *
 * Clamps stem/extension (and, in extreme near-240B nested paths, parent
 * segments only if strictly necessary) so the returned path is ALWAYS valid
 * under `validateVfsPath`.
 */
export function conflictPath(path: string, nodeId: string): string {
  const normalized = normalizeVfsPath(path);
  const rawTag = typeof nodeId === 'string' ? nodeId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : '';
  const tag = rawTag.length > 0 ? rawTag : '00000000';

  const segments = normalized.split('/');
  const leaf = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1);

  const lastDot = leaf.lastIndexOf('.');
  // Dotfiles like `.gitignore` have lastDot === 0 -> treat entire leaf as stem, no extension.
  const origStem = lastDot > 0 ? leaf.slice(0, lastDot) : leaf;
  const origExt = lastDot > 0 ? leaf.slice(lastDot) : '';

  const spacedSuffix = ` (conflict-${tag})`;
  const bareSuffix = `conflict-${tag}`;
  const spacedSuffixCp = spacedSuffix.length; // ASCII
  const spacedSuffixBytes = spacedSuffix.length;
  const bareSuffixBytes = bareSuffix.length;

  let dirPrefix = dirSegments.length > 0 ? `${dirSegments.join('/')}/` : '';
  let availBytes = VFS_MAX_PATH_BYTES - utf8ByteLength(dirPrefix);

  // Extreme edge case: parent directories alone consume so much of the 240B
  // budget that even `conflict-<tag>` cannot fit in the leaf. Shrink parent
  // segments minimally from the right so the resulting path stays valid.
  if (availBytes < bareSuffixBytes) {
    const targetDirBytes = VFS_MAX_PATH_BYTES - bareSuffixBytes - 1; // 1 for trailing '/'
    const trimmedDirs = [...dirSegments];
    let dirBytes = utf8ByteLength(trimmedDirs.join('/'));
    for (let i = trimmedDirs.length - 1; i >= 0 && dirBytes > targetDirBytes; i--) {
      const seg = trimmedDirs[i]!;
      const segBytes = utf8ByteLength(seg);
      const excess = dirBytes - targetDirBytes;
      const keepBytes = Math.max(1, segBytes - excess);
      let shortened = truncateCodePoints(seg, VFS_MAX_SEGMENT_CODEPOINTS, keepBytes).replace(/[. ]+$/u, '');
      if (
        shortened.length === 0 ||
        shortened === '.' ||
        shortened === '..' ||
        shortened.startsWith(' ') ||
        WINDOWS_RESERVED_NAME_RE.test(shortened) ||
        shortened.toLocaleLowerCase('en-US') === '.meshrooms' ||
        shortened.toLocaleLowerCase('en-US') === '.git'
      ) {
        shortened = 'd';
      }
      trimmedDirs[i] = shortened;
      dirBytes = utf8ByteLength(trimmedDirs.join('/'));
    }
    dirPrefix = trimmedDirs.length > 0 ? `${trimmedDirs.join('/')}/` : '';
    availBytes = VFS_MAX_PATH_BYTES - utf8ByteLength(dirPrefix);
  }

  // Fit extension first (preserving extension whenever possible, reserving at
  // least room for the suffix and, when possible, >= 1 code point of stem).
  let ext = origExt;
  const maxExtCp = Math.max(0, VFS_MAX_SEGMENT_CODEPOINTS - spacedSuffixCp - 1);
  const maxExtBytes = Math.max(0, availBytes - spacedSuffixBytes - 1);
  if (ext.length > 0 && (toCodePoints(ext).length > maxExtCp || utf8ByteLength(ext) > maxExtBytes)) {
    // Try fitting bareSuffix + ext if stem cannot fit, otherwise truncate ext.
    if (toCodePoints(ext).length <= VFS_MAX_SEGMENT_CODEPOINTS - bareSuffix.length && utf8ByteLength(ext) <= availBytes - bareSuffixBytes) {
      const candidate = `${dirPrefix}${bareSuffix}${ext}`;
      const check = validateVfsPath(candidate);
      if (check.ok) return check.normalized;
    }
    ext = truncateCodePoints(ext, maxExtCp, maxExtBytes).replace(/[. ]+$/u, '');
    if (ext === '.') ext = '';
  }

  const extCp = toCodePoints(ext).length;
  const extBytes = utf8ByteLength(ext);

  const maxStemCp = VFS_MAX_SEGMENT_CODEPOINTS - spacedSuffixCp - extCp;
  const maxStemBytes = availBytes - spacedSuffixBytes - extBytes;

  let stem = truncateCodePoints(origStem, maxStemCp, maxStemBytes).replace(/ +$/u, '');

  let candidateLeaf: string;
  if (stem.length > 0) {
    candidateLeaf = `${stem}${spacedSuffix}${ext}`;
  } else {
    // No room for a non-empty stem before ` (conflict-xxxx)`; drop leading space.
    const fallbackExt =
      utf8ByteLength(bareSuffix + ext) <= availBytes &&
      bareSuffix.length + extCp <= VFS_MAX_SEGMENT_CODEPOINTS
        ? ext
        : '';
    candidateLeaf = `${bareSuffix}${fallbackExt}`;
  }

  const candidate = `${dirPrefix}${candidateLeaf}`;
  return normalizeVfsPath(candidate);
}
