// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildChimeWav } from './ring-tone.js';

// Pins the synthesized ring tone: a valid 16-bit mono PCM WAV whose chime
// lives at the front of the buffer with trailing silence (so the overlay's
// audio.loop=true rings politely every ~2.6s instead of continuously).

describe('buildChimeWav', () => {
  it('produces a well-formed mono 16-bit PCM WAV with audible chime then silence', async () => {
    const blob = buildChimeWav();
    expect(blob.type).toBe('audio/wav');

    const buf = await blob.arrayBuffer();
    const view = new DataView(buf);
    const str = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint16(34, true)).toBe(16); // bit depth
    const rate = view.getUint32(24, true);
    const dataLen = view.getUint32(40, true);
    expect(buf.byteLength).toBe(44 + dataLen);
    // ~2.6 seconds of audio
    expect(dataLen / 2 / rate).toBeGreaterThan(2.4);
    expect(dataLen / 2 / rate).toBeLessThan(2.8);

    // Audible content in the first 200ms (the "ding")…
    let peakStart = 0;
    for (let i = 0; i < rate * 0.2; i++) {
      peakStart = Math.max(peakStart, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peakStart).toBeGreaterThan(0x7fff * 0.2);

    // …and near-silence in the final half second (the loop gap).
    let peakEnd = 0;
    const samples = dataLen / 2;
    for (let i = Math.floor(samples - rate * 0.5); i < samples; i++) {
      peakEnd = Math.max(peakEnd, Math.abs(view.getInt16(44 + i * 2, true)));
    }
    expect(peakEnd).toBeLessThan(0x7fff * 0.01);
  });
});
