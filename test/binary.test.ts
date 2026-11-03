import { describe, it, expect } from 'vitest';
import { isBinary } from '../src/binary';

describe('isBinary', () => {
  it('returns false for an empty buffer', () => {
    expect(isBinary(Buffer.alloc(0))).toBe(false);
  });

  it('returns false for a plain text buffer', () => {
    expect(isBinary(Buffer.from('hello world\n', 'utf8'))).toBe(false);
  });

  it('returns true when a NUL byte appears in the first 8000 bytes', () => {
    const buf = Buffer.alloc(100, 0x41); // 'A' × 100
    buf[50] = 0x00;
    expect(isBinary(buf)).toBe(true);
  });

  it('returns true when the very first byte is NUL', () => {
    const buf = Buffer.from([0x00, 0x41, 0x42]);
    expect(isBinary(buf)).toBe(true);
  });

  it('returns true when the byte at position 7999 is NUL (boundary)', () => {
    const buf = Buffer.alloc(8001, 0x41);
    buf[7999] = 0x00;
    expect(isBinary(buf)).toBe(true);
  });

  it('returns false when the NUL byte is at position 8000 (beyond the scan window)', () => {
    const buf = Buffer.alloc(8001, 0x41);
    buf[8000] = 0x00;
    expect(isBinary(buf)).toBe(false);
  });

  it('returns false for a buffer of exactly 8000 non-NUL bytes', () => {
    expect(isBinary(Buffer.alloc(8000, 0x41))).toBe(false);
  });

  it('returns false for high-byte UTF-8 content without NUL', () => {
    expect(isBinary(Buffer.from('こんにちは', 'utf8'))).toBe(false);
  });
});
