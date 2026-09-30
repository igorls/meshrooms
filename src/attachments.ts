import type { Attachment } from './room';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 4;
export const MAX_ROOM_ATTACHMENTS = 512;
export const MAX_ROOM_ATTACHMENT_BYTES = 512 * 1024 * 1024;
/** Uploads not yet sent in a message, per author and room. */
export const MAX_PENDING_ATTACHMENTS = 8;
/** Unsent uploads older than this are dropped at startup. */
export const PENDING_ATTACHMENT_MS = 24 * 60 * 60 * 1000;

/** Canonical field order, so fingerprints of messages carrying attachments agree across nodes. */
export function normalizeAttachment({ id, name, type, kind, size, width, height }: Attachment): Attachment {
  return { id, name, type, kind, size, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

type Sniffed = { type: string; kind: Attachment['kind']; width?: number; height?: number };

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, text: string) => [...text].every((c, j) => b[i + j] === c.charCodeAt(0));
const size = (width: number, height: number) => width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : {};

function jpegSize(b: Uint8Array) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = u16be(b, i + 2);
    // Start-of-frame markers, excluding DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return size(u16be(b, i + 7), u16be(b, i + 5));
    if (length < 2) return {};
    i += 2 + length;
  }
  return {};
}
function webpSize(b: Uint8Array) {
  if (ascii(b, 12, 'VP8X')) return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
  if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1); }
  if (ascii(b, 12, 'VP8 ')) return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  return {};
}

/**
 * The stored type comes from the bytes, never from the uploader's claim. Only raster formats a browser
 * renders safely are treated as images; everything else (including SVG) is served as a download.
 */
export function sniff(bytes: Uint8Array): Sniffed {
  if (bytes.length >= 24 && ascii(bytes, 0, '\x89PNG\r\n\x1a\n') && ascii(bytes, 12, 'IHDR')) return { type: 'image/png', kind: 'image', ...size(u32be(bytes, 16), u32be(bytes, 20)) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', kind: 'image', ...jpegSize(bytes) };
  if (bytes.length >= 10 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return { type: 'image/gif', kind: 'image', ...size(u16le(bytes, 6), u16le(bytes, 8)) };
  if (bytes.length >= 30 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return { type: 'image/webp', kind: 'image', ...webpSize(bytes) };
  if (bytes.length >= 5 && ascii(bytes, 0, '%PDF-')) return { type: 'application/pdf', kind: 'file' };
  if (!bytes.includes(0)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return { type: 'text/plain', kind: 'file' }; } catch { /* Binary. */ }
  }
  return { type: 'application/octet-stream', kind: 'file' };
}

/** A display name without paths or control characters. The name never determines storage or type. */
export function cleanName(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value : '';
  const base = raw.split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || fallback;
}

export function defaultName(type: string, time = new Date()) {
  const stamp = time.toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' }[type] || 'bin';
  return `${type.startsWith('image/') ? 'screenshot' : 'file'}-${stamp}.${extension}`;
}
