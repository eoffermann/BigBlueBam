/**
 * Gentle chat-notification blip — same zero-asset approach as ring-tone.ts
 * but a single soft "plip": one short sine at G5 with a quick octave-up
 * shimmer and fast decay. Synthesized once into a 16-bit PCM WAV blob and
 * played per incoming message at low volume.
 */

const SAMPLE_RATE = 22_050;
const DURATION_S = 0.22;

export function buildBlipWav(): Blob {
  const n = Math.floor(SAMPLE_RATE * DURATION_S);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-t / 0.05);
    samples[i] =
      0.4 *
      envelope *
      (Math.sin(2 * Math.PI * 784 * t) + 0.25 * Math.sin(2 * Math.PI * 1568 * t));
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, (v * 0x7fff) | 0, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let cachedUrl: string | null = null;

export function playChatBlip(): void {
  if (typeof window === 'undefined') return;
  try {
    if (!cachedUrl) {
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return;
      cachedUrl = URL.createObjectURL(buildBlipWav());
    }
    const audio = new Audio(cachedUrl);
    audio.volume = 0.25;
    void audio.play().catch(() => {
      // Autoplay blocked until first user interaction — fine, it's a nicety.
    });
  } catch {
    // never let a notification sound break the chat
  }
}
