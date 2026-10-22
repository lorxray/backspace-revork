import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
import { changeScreenShare, publishScreenShare, replaceScreenShareSource, stopScreenShare } from './screenShare';
import { serializeScreenShareUpdate } from './screenShareUpdateQueue';
import { getLastScreenShareSource, rememberScreenShareSource } from './lastScreenShareSource';

const playSound = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound }) } }));
vi.mock('./hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('./livekitInternals', () => ({ getPublisherPC: () => null, getMediaStreamTrack: (track: { mediaStreamTrack: MediaStreamTrack }) => track.mediaStreamTrack }));

const tracks: Capture[] = [];
class Capture extends EventTarget {
  id = `capture-${tracks.length}`;
  readyState = 'live';
  contentHint = '';
  enabled = true;
  stop = vi.fn(() => { this.readyState = 'ended'; });
  applyConstraints = vi.fn().mockResolvedValue(undefined);
  getSettings = () => ({ width: 1920, height: 1080, frameRate: 60 });
  getConstraints = () => ({});
  clone = vi.fn(() => new Capture(this.kind, this.source));
  constructor(readonly kind: 'video' | 'audio', readonly source: string) { super(); tracks.push(this); }
}

function capture(source: string, audio = true) {
  return new MediaStream([new Capture('video', source), ...(audio ? [new Capture('audio', source)] : [])] as unknown as MediaStreamTrack[]);
}

function localTrack(raw: Capture) {
  const backups = new Map<string, { mediaStreamTrack: Capture; sender: { replaceTrack: ReturnType<typeof vi.fn> } }>();
  const track = { kind: raw.kind, mediaStreamTrack: raw, simulcastCodecs: backups, replaceTrack: vi.fn() };
  track.replaceTrack.mockImplementation(async (next: Capture) => { track.mediaStreamTrack = next; });
  return track;
}

type Publication = { source: string; trackSid: string; track: ReturnType<typeof localTrack> };
function makeRoom() {
  const publications = new Map<string, Publication>();
  const participant = {
    getTrackPublication: (source: string) => publications.get(source),
    getTrackPublications: () => [...publications.values()],
    publishTrack: vi.fn(async (raw: Capture, opts: { source: string }) => {
      const publication = { source: opts.source, trackSid: `publication-${opts.source}`, track: localTrack(raw) };
      publications.set(opts.source, publication); return publication;
    }),
    unpublishTrack: vi.fn(async (target: Capture | Publication['track'], stop = true) => {
      for (const [key, publication] of publications) {
        if (publication.track !== target && publication.track.mediaStreamTrack !== target) continue;
        publications.delete(key);
        if (stop) { publication.track.mediaStreamTrack.stop(); for (const backup of publication.track.simulcastCodecs.values()) backup.mediaStreamTrack.stop(); }
      }
    }),
    publishData: vi.fn().mockResolvedValue(undefined),
  };
  return { state: ConnectionState.Connected, localParticipant: participant, publications };
}

let room: ReturnType<typeof makeRoom>;
beforeEach(async () => {
  playSound.mockClear();
  vi.useFakeTimers(); tracks.length = 0;
  vi.stubGlobal('MediaStream', class {
    constructor(private readonly tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  });
  room = makeRoom();
  useScreenShareSetupStore.setState({ isOpen: false, isStarting: false, mode: 'start' });
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isLiveKitConnected: true,
    screenShareConfig: { height: 1080, fps: 60, mode: 'gaming', customBitrateKbps: 10000, codec: 'h264', shareAudio: true },
  });
  await room.localParticipant.publishTrack(new Capture('audio', 'microphone'), { source: Track.Source.Microphone });
  expect(await publishScreenShare(room as never, capture('old'))).toBe(true);
  const video = room.publications.get(Track.Source.ScreenShare)!.track;
  video.simulcastCodecs.set('vp8', { mediaStreamTrack: video.mediaStreamTrack.clone(), sender: { replaceTrack: vi.fn().mockResolvedValue(undefined) } });
  room.localParticipant.publishTrack.mockClear(); room.localParticipant.unpublishTrack.mockClear(); room.localParticipant.publishData.mockClear();
});
afterEach(async () => {
  await stopScreenShare(room as never);
  for (const track of tracks) track.stop();
  vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('replace the capture without restarting the share', () => {
  it('opens the source chooser while the existing stream continues', async () => {
    await changeScreenShare(room as never);
    expect(useScreenShareSetupStore.getState()).toMatchObject({ isOpen: true, mode: 'replace' });
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(tracks.filter(track => track.readyState === 'live')).toHaveLength(4);
  });

  it('keeps publication IDs, watches, microphone and system audio, and releases all old capture branches', async () => {
    const video = room.publications.get(Track.Source.ScreenShare)!;
    const audio = room.publications.get(Track.Source.ScreenShareAudio)!;
    const mic = room.publications.get(Track.Source.Microphone)!;
    const previous = tracks.filter(track => track.source === 'old');
    const states: boolean[] = [];
    const unsubscribe = useVoiceStore.subscribe(state => states.push(state.isScreenSharing));
    try { expect(await replaceScreenShareSource(room as never, capture('new'))).toBe(true); } finally { unsubscribe(); }
    expect(room.publications.get(Track.Source.ScreenShare)).toBe(video);
    expect(room.publications.get(Track.Source.ScreenShareAudio)).toBe(audio);
    expect(room.publications.get(Track.Source.Microphone)).toBe(mic);
    expect(video.track.mediaStreamTrack.source).toBe('new');
    expect(audio.track.mediaStreamTrack.source).toBe('new');
    expect([...video.track.simulcastCodecs.values()][0]!.mediaStreamTrack.source).toBe('new');
    expect(previous.every(track => track.readyState === 'ended')).toBe(true);
    expect(states.every(Boolean)).toBe(true);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.publishData).not.toHaveBeenCalled();
    expect(playSound).toHaveBeenCalledExactlyOnceWith('stream_started', { volume: 0.8 });
  });

  it('bounds live tracks and scheduled retries across 40 source changes', async () => {
    const publication = room.publications.get(Track.Source.ScreenShare);
    for (let index = 0; index < 40; index++) {
      expect(await replaceScreenShareSource(room as never, capture(`screen-${index}`))).toBe(true);
      expect(tracks.filter(track => track.readyState === 'live')).toHaveLength(4);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    }
    expect(room.publications.get(Track.Source.ScreenShare)).toBe(publication);
    await stopScreenShare(room as never);
    await Promise.resolve();
    expect(tracks.filter(track => track.readyState === 'live').map(track => track.source)).toEqual(['microphone']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the streamer sound-effect volume without sending a cue to viewers', async () => {
    useVoiceStore.setState({ soundEffectVolume: 125 });
    expect(await replaceScreenShareSource(room as never, capture('next'))).toBe(true);
    expect(playSound).toHaveBeenCalledExactlyOnceWith('stream_started', { volume: 1 });
    expect(room.localParticipant.publishData).not.toHaveBeenCalled();
  });

  it.each(['primary', 'backup', 'audio'])('restores the old source after a %s replacement fails', async failure => {
    const video = room.publications.get(Track.Source.ScreenShare)!.track;
    const audio = room.publications.get(Track.Source.ScreenShareAudio)!.track;
    if (failure === 'primary') video.replaceTrack.mockRejectedValueOnce(new Error('video replacement failed'));
    if (failure === 'backup') [...video.simulcastCodecs.values()][0]!.sender.replaceTrack.mockRejectedValueOnce(new Error('backup failed'));
    if (failure === 'audio') audio.replaceTrack.mockRejectedValueOnce(new Error('audio failed'));
    const next = capture('failed-source');
    expect(await replaceScreenShareSource(room as never, next)).toBe(false);
    expect(video.mediaStreamTrack.source).toBe('old');
    expect(audio.mediaStreamTrack.source).toBe('old');
    expect(next.getTracks().every(track => track.readyState === 'ended')).toBe(true);
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(tracks.filter(track => track.readyState === 'live')).toHaveLength(4);
    expect(playSound).not.toHaveBeenCalled();
  });

  it('keeps the old source when Cancel arrives during replacement', async () => {
    let current = true;
    const video = room.publications.get(Track.Source.ScreenShare)!.track;
    video.replaceTrack.mockImplementationOnce(async next => { video.mediaStreamTrack = next; current = false; });
    const next = capture('cancelled');
    expect(await replaceScreenShareSource(room as never, next, { isCurrent: () => current })).toBe(false);
    expect(video.mediaStreamTrack.source).toBe('old');
    expect(useVoiceStore.getState().isScreenSharing).toBe(true);
    expect(next.getTracks().every(track => track.readyState === 'ended')).toBe(true);
  });

  it('rebinds source-ended cleanup on a restored capture', async () => {
    rememberScreenShareSource({ id: 'screen:old', name: 'Old monitor', isScreen: true });
    const video = room.publications.get(Track.Source.ScreenShare)!.track;
    video.replaceTrack.mockRejectedValueOnce(new Error('replacement failed'));
    expect(await replaceScreenShareSource(room as never, capture('failed'))).toBe(false);
    expect(getLastScreenShareSource()?.id).toBe('screen:old');
    video.mediaStreamTrack.dispatchEvent(new Event('ended'));
    expect(getLastScreenShareSource()).toBeNull();
  });

  it('releases both captures if Stop arrives during the sender swap', async () => {
    const video = room.publications.get(Track.Source.ScreenShare)!.track;
    video.replaceTrack.mockImplementationOnce(async next => {
      video.mediaStreamTrack = next;
      await stopScreenShare(room as never);
    });
    expect(await replaceScreenShareSource(room as never, capture('stopped'))).toBe(false);
    expect(room.publications.has(Track.Source.ScreenShare)).toBe(false);
    expect(tracks.filter(track => track.readyState === 'live').map(track => track.source)).toEqual(['microphone']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes an audio publication that finishes after Stop', async () => {
    await room.localParticipant.unpublishTrack(room.publications.get(Track.Source.ScreenShareAudio)!.track);
    const publish = room.localParticipant.publishTrack.getMockImplementation()!;
    room.localParticipant.publishTrack.mockImplementationOnce(async (raw, opts) => {
      await stopScreenShare(room as never);
      return publish(raw, opts);
    });
    expect(await replaceScreenShareSource(room as never, capture('late-audio'))).toBe(false);
    expect(room.publications.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(tracks.filter(track => track.readyState === 'live').map(track => track.source)).toEqual(['microphone']);
  });

  it('does not restore a source after an explicit Stop while a queued swap waits', async () => {
    let release!: () => void;
    const blocking = serializeScreenShareUpdate(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const next = capture('late');
    const replacement = replaceScreenShareSource(room as never, next);
    await stopScreenShare(room as never);
    release(); await blocking;
    expect(await replacement).toBe(false);
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(next.getTracks().every(track => track.readyState === 'ended')).toBe(true);
  });

  it('removes previous-source audio when the new source has no audio', async () => {
    expect(await replaceScreenShareSource(room as never, capture('silent', false))).toBe(true);
    expect(room.publications.has(Track.Source.ScreenShareAudio)).toBe(false);
    expect(tracks.filter(track => track.kind === 'audio' && track.source === 'old').every(track => track.readyState === 'ended')).toBe(true);
    expect(room.publications.has(Track.Source.ScreenShare)).toBe(true);
  });
});
