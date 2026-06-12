// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildBlipWav } from './chat-blip.js';

// The chat notification blip: a valid, SHORT, gentle mono WAV — loud
// enough to register at the front, fully decayed by the end (no click).

describe('buildBlipWav', () => {
  it('produces a brief mono 16-bit PCM WAV with fast decay', async () => {
    const blob = buildBlipWav();
    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const str = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1); // mono
    const rate = view.getUint32(24, true);
    const samples = view.getUint32(40, true) / 2;
    expect(samples / rate).toBeLessThan(0.35); // a blip, not a ring

    let peakStart = 0;
    for (let i = 0; i < rate * 0.05; i++) {
      peakStart = Math.max(peakStart, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peakStart).toBeGreaterThan(0x7fff * 0.15);

    let peakEnd = 0;
    for (let i = Math.floor(samples * 0.9); i < samples; i++) {
      peakEnd = Math.max(peakEnd, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peakEnd).toBeLessThan(0x7fff * 0.05);
  });
});
