// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { BureauAudioSink, isPlayableAudioSource } from './audio-sink.js';

// The sink is the fix for "I see their video but hear nothing": LiveKit
// never auto-plays subscribed audio, so every remote audio track must be
// attached into the DOM. These tests drive the sink with fake rooms /
// tracks (no real WebRTC) and pin the reconciliation contract.

function fakeTrack() {
  const attach = vi.fn((): HTMLMediaElement => document.createElement('audio'));
  const detach = vi.fn();
  return { attach, detach };
}

function fakeRoom(
  participants: Array<{
    pubs: Array<{
      trackSid: string | null;
      source: Track.Source;
      kind: Track.Kind;
      track: ReturnType<typeof fakeTrack> | null;
    }>;
  }>,
) {
  const remoteParticipants = new Map(
    participants.map((p, i) => [
      `p${i}`,
      {
        audioTrackPublications: new Map(p.pubs.map((pub, j) => [`pub${i}-${j}`, pub])),
      },
    ]),
  );
  return { remoteParticipants } as never;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('isPlayableAudioSource', () => {
  it('plays remote microphones and screen-share audio', () => {
    expect(isPlayableAudioSource(Track.Source.Microphone, Track.Kind.Audio, false)).toBe(true);
    expect(isPlayableAudioSource(Track.Source.ScreenShareAudio, Track.Kind.Audio, false)).toBe(true);
  });

  it('plays unknown-source audio (SIP/ingest) but never video sources', () => {
    expect(isPlayableAudioSource(Track.Source.Unknown, Track.Kind.Audio, false)).toBe(true);
    expect(isPlayableAudioSource(Track.Source.Camera, Track.Kind.Video, false)).toBe(false);
    expect(isPlayableAudioSource(Track.Source.ScreenShare, Track.Kind.Video, false)).toBe(false);
  });

  it('never plays local tracks (echo)', () => {
    expect(isPlayableAudioSource(Track.Source.Microphone, Track.Kind.Audio, true)).toBe(false);
  });
});

describe('BureauAudioSink.sync', () => {
  it('attaches a subscribed remote mic into a hidden body-level container', () => {
    const sink = new BureauAudioSink();
    const track = fakeTrack();
    sink.sync(
      fakeRoom([
        { pubs: [{ trackSid: 'TR_a', source: Track.Source.Microphone, kind: Track.Kind.Audio, track }] },
      ]),
    );
    expect(track.attach).toHaveBeenCalledTimes(1);
    const container = document.querySelector('[data-bureau-audio-sink]');
    expect(container).not.toBeNull();
    expect(container!.querySelector('[data-bureau-audio="TR_a"]')).not.toBeNull();
    expect(sink.size).toBe(1);
  });

  it('is idempotent — repeated syncs do not re-attach', () => {
    const sink = new BureauAudioSink();
    const track = fakeTrack();
    const room = fakeRoom([
      { pubs: [{ trackSid: 'TR_a', source: Track.Source.Microphone, kind: Track.Kind.Audio, track }] },
    ]);
    sink.sync(room);
    sink.sync(room);
    sink.sync(room);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(sink.size).toBe(1);
  });

  it('skips publications that are not yet subscribed (track null)', () => {
    const sink = new BureauAudioSink();
    sink.sync(
      fakeRoom([
        { pubs: [{ trackSid: 'TR_a', source: Track.Source.Microphone, kind: Track.Kind.Audio, track: null }] },
      ]),
    );
    expect(sink.size).toBe(0);
  });

  it('detaches when a track disappears (unsubscribe / participant left)', () => {
    const sink = new BureauAudioSink();
    const track = fakeTrack();
    sink.sync(
      fakeRoom([
        { pubs: [{ trackSid: 'TR_a', source: Track.Source.Microphone, kind: Track.Kind.Audio, track }] },
      ]),
    );
    expect(sink.size).toBe(1);
    sink.sync(fakeRoom([{ pubs: [] }]));
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(sink.size).toBe(0);
    expect(document.querySelector('[data-bureau-audio="TR_a"]')).toBeNull();
  });

  it('handles multiple participants and mixed sources', () => {
    const sink = new BureauAudioSink();
    const mic1 = fakeTrack();
    const mic2 = fakeTrack();
    const shareAudio = fakeTrack();
    sink.sync(
      fakeRoom([
        { pubs: [{ trackSid: 'TR_1', source: Track.Source.Microphone, kind: Track.Kind.Audio, track: mic1 }] },
        {
          pubs: [
            { trackSid: 'TR_2', source: Track.Source.Microphone, kind: Track.Kind.Audio, track: mic2 },
            { trackSid: 'TR_3', source: Track.Source.ScreenShareAudio, kind: Track.Kind.Audio, track: shareAudio },
          ],
        },
      ]),
    );
    expect(sink.size).toBe(3);
  });

  it('detachAll removes every element and the container', () => {
    const sink = new BureauAudioSink();
    const track = fakeTrack();
    sink.sync(
      fakeRoom([
        { pubs: [{ trackSid: 'TR_a', source: Track.Source.Microphone, kind: Track.Kind.Audio, track }] },
      ]),
    );
    sink.detachAll();
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(sink.size).toBe(0);
    expect(document.querySelector('[data-bureau-audio-sink]')).toBeNull();
  });

  it('survives a track whose attach throws (mid-teardown race)', () => {
    const sink = new BureauAudioSink();
    const bad = {
      attach: vi.fn(() => {
        throw new Error('track ended');
      }),
      detach: vi.fn(),
    };
    expect(() =>
      sink.sync(
        fakeRoom([
          { pubs: [{ trackSid: 'TR_x', source: Track.Source.Microphone, kind: Track.Kind.Audio, track: bad }] },
        ]),
      ),
    ).not.toThrow();
    expect(sink.size).toBe(0);
  });
});
