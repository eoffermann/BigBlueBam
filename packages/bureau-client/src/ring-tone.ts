/**
 * Synthesized Bureau ring tone.
 *
 * The IncomingCallOverlay accepts a `ringtoneUrl` and loops it while a ring
 * is on screen — but the suite never shipped an audio asset, so rings were
 * silent. Rather than vendoring a licensed sound file into every SPA
 * bundle, we synthesize a short two-tone chime (the classic doorbell minor
 * third, E5 → C5, with a soft octave harmonic and exponential decay) into a
 * 16-bit PCM WAV at module scope and hand the overlay a blob: URL. The
 * buffer is 2.6 s long with trailing silence, so the overlay's
 * `audio.loop = true` produces a polite ding-dong every 2.6 s instead of a
 * continuous wall of sound.
 *
 * Zero network, zero binary assets in the repo, no licensing questions.
 */

const SAMPLE_RATE = 22_050; // plenty for a chime; halves the buffer size
const DURATION_S = 2.6;

function buildChimeSamples(): Float32Array {
  const n = Math.floor(SAMPLE_RATE * DURATION_S);
  const samples = new Float32Array(n);

  const note = (freq: number, startS: number, durS: number, amp: number) => {
    const s0 = Math.floor(startS * SAMPLE_RATE);
    const s1 = Math.min(n, Math.floor((startS + durS) * SAMPLE_RATE));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / SAMPLE_RATE;
      // Bell-ish: fundamental + quieter octave, exponential decay.
      const envelope = Math.exp(-t / 0.16);
      samples[i] =
        (samples[i] ?? 0) +
        amp *
          envelope *
          (Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(4 * Math.PI * freq * t));
    }
  };

  note(659.25, 0.0, 0.9, 0.5); // E5 — "ding"
  note(523.25, 0.32, 1.1, 0.5); // C5 — "dong"
  return samples;
}

export function buildChimeWav(): Blob {
  const samples = buildChimeSamples();
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, (v * 0x7fff) | 0, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let cachedUrl: string | null = null;

/**
 * Blob URL of the synthesized chime, built once per page. Returns null in
 * non-browser environments (SSR, tests without URL.createObjectURL).
 */
export function getRingToneUrl(): string | null {
  if (typeof window === 'undefined') return null;
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  if (!cachedUrl) {
    try {
      cachedUrl = URL.createObjectURL(buildChimeWav());
    } catch {
      return null;
    }
  }
  return cachedUrl;
}
