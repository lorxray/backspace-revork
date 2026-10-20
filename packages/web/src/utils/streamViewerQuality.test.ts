import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteTrackPublication, RemoteVideoTrack, Track, TrackEvent, VideoQuality } from 'livekit-client';
import { StreamViewerQualityController, streamViewerQualityOptions } from './streamViewerQuality';
import { useVoiceStore } from '../stores/voiceStore';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

type TrackInfo = ConstructorParameters<typeof RemoteTrackPublication>[1];
const controllers: StreamViewerQualityController[] = [];

function fixture(heights = [1440, 1440, 1440]) {
  const layers = heights.map((height, quality) => ({ quality, width: Math.round(height * 16 / 9), height, bitrate: 7_500_000 * 2 ** quality, ssrc: 0 }));
  const info = {
    sid: 'TR_SCREEN', name: 'screen', source: 3, type: 1, width: 2560, height: 1440,
    mimeType: 'video/H264', simulcast: true, muted: false, layers,
    codecs: [{ mimeType: 'video/H264', layers }, { mimeType: 'video/VP8', layers: [{ ...layers[2], quality: 2 }] }],
  } as TrackInfo;
  const pub = new RemoteTrackPublication(Track.Kind.Video, info, true);
  const media = { id: 'media', kind: 'video', enabled: true, readyState: 'live' } as MediaStreamTrack;
  const track = new RemoteVideoTrack(media, 'TR_SCREEN', {} as RTCRtpReceiver, {});
  const stats = vi.spyOn(track, 'getReceiverStats').mockResolvedValue({ mimeType: 'video/H264' } as Awaited<ReturnType<typeof track.getReceiverStats>>);
  pub.setTrack(track);
  const updates: { quality: number; width: number; height: number; disabled: boolean }[] = [];
  pub.on(TrackEvent.UpdateSettings, (settings) => updates.push({ quality: settings.quality, width: settings.width, height: settings.height, disabled: settings.disabled }));
  const options = vi.fn();
  const controller = new StreamViewerQualityController(pub, options);
  controllers.push(controller);
  return { pub, track, stats, updates, controller, options };
}

async function settled() { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => { vi.useFakeTimers(); useVoiceStore.setState(useVoiceStore.getInitialState()); });
afterEach(() => { controllers.splice(0).forEach((controller) => controller.dispose()); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('viewer quality against real LiveKit publications', () => {
  it('uses advertised caps for the negotiated codec, including a single-layer backup', () => {
    const { pub } = fixture();
    expect(streamViewerQualityOptions(pub)).toEqual([{ value: 'original', height: 1440 }]);
    expect(streamViewerQualityOptions(pub, 'video/H264')).toEqual([
      { value: 'original', height: 1440, maxBitrate: 30_000_000 },
      { value: 'medium', height: 1440, maxBitrate: 15_000_000 },
      { value: 'economy', height: 1440, maxBitrate: 7_500_000 },
    ]);
    expect(streamViewerQualityOptions(pub, 'video/VP8')).toHaveLength(1);
    expect(streamViewerQualityOptions(pub, 'video/VP9')).toEqual([{ value: 'original', height: 1440 }]);
  });

  it('keeps a manual bitrate cap after viewport resize without disabling visibility handling', async () => {
    const { controller, track, updates } = fixture();
    track.emit(TrackEvent.VideoDimensionsChanged, { width: 640, height: 360 });
    await settled();
    controller.setQuality('medium');
    track.emit(TrackEvent.VideoDimensionsChanged, { width: 1280, height: 720 });
    expect(updates.at(-1)).toEqual({ quality: VideoQuality.MEDIUM, width: 0, height: 0, disabled: false });
    track.emit(TrackEvent.VisibilityChanged, false);
    expect(updates.at(-1)?.disabled).toBe(true);
    track.emit(TrackEvent.VisibilityChanged, true);
    expect(updates.at(-1)).toEqual({ quality: VideoQuality.MEDIUM, width: 0, height: 0, disabled: false });
    controller.setQuality('economy');
    expect(updates.at(-1)?.quality).toBe(VideoQuality.LOW);
    controller.setQuality('auto');
    expect(updates.at(-1)?.quality).toBe(VideoQuality.HIGH);
  });

  it('restores the latest adaptive size for Auto on an older stream with different resolutions', async () => {
    const { controller, track, updates } = fixture([360, 720, 1440]);
    await settled();
    controller.setQuality('economy');
    track.emit(TrackEvent.VideoDimensionsChanged, { width: 320, height: 180 });
    expect(updates.at(-1)?.width).toBe(0);
    controller.setQuality('auto');
    expect(updates.at(-1)).toMatchObject({ width: 320, height: 180 });
  });

  it('does not leak SDK listeners when a publication swaps its track and reapplies an unchanged preference', async () => {
    const { pub, controller, track, updates } = fixture();
    await settled();
    controller.setQuality('medium');
    pub.on(TrackEvent.Unsubscribed, () => controller.dispose(false));
    pub.setTrack(undefined);
    expect(track.listenerCount(TrackEvent.VideoDimensionsChanged)).toBe(0);
    const next = new RemoteVideoTrack({ id: 'next', kind: 'video' } as MediaStreamTrack, 'TR_SCREEN', {} as RTCRtpReceiver, {});
    vi.spyOn(next, 'getReceiverStats').mockResolvedValue({ mimeType: 'video/H264' } as Awaited<ReturnType<typeof next.getReceiverStats>>);
    pub.setTrack(next);
    const nextController = new StreamViewerQualityController(pub, vi.fn());
    controllers.push(nextController);
    nextController.setQuality('medium');
    await settled();
    expect(updates.at(-1)).toEqual({ quality: VideoQuality.MEDIUM, width: 0, height: 0, disabled: false });
  });

  it('updates advertised caps and removes unavailable controls when the negotiated codec falls back', async () => {
    const { controller, pub, stats, options, updates } = fixture();
    await settled();
    controller.setQuality('medium');
    pub.trackInfo!.layers[1]!.bitrate = 10_000_000;
    await controller.refresh();
    expect(options.mock.lastCall?.[0]).toContainEqual({ value: 'medium', height: 1440, maxBitrate: 10_000_000 });
    stats.mockResolvedValue({ mimeType: 'video/VP8' } as Awaited<ReturnType<RemoteVideoTrack['getReceiverStats']>>);
    await controller.refresh();
    expect(options.mock.lastCall?.[0]).toHaveLength(1);
    expect(updates.at(-1)?.quality).toBe(VideoQuality.HIGH);
  });

  it('does not touch adaptive camera dimensions', async () => {
    const { pub, track } = fixture();
    pub.source = Track.Source.Camera;
    await settled();
    track.emit(TrackEvent.VideoDimensionsChanged, { width: 640, height: 360 });
    expect(streamViewerQualityOptions(pub, 'video/H264')).toHaveLength(1);
    expect(track.listenerCount(TrackEvent.VideoDimensionsChanged)).toBe(1);
  });
});

describe('per-stream viewer preferences', () => {
  it('isolates identities and resets choices with the session without changing publisher settings', () => {
    const publisherConfig = useVoiceStore.getState().screenShareConfig;
    useVoiceStore.getState().setStreamViewerQuality('alice:Alice', 'medium');
    useVoiceStore.getState().setStreamViewerQuality('bob:Bob', 'economy');
    expect(useVoiceStore.getState().streamViewerQualities.get('alice:Alice')).toBe('medium');
    useVoiceStore.getState().clearStreamViewerQuality('bob:Bob');
    expect(useVoiceStore.getState().streamViewerQualities.get('alice:Alice')).toBe('medium');
    expect(useVoiceStore.getState().streamViewerQualities.has('bob:Bob')).toBe(false);
    expect(useVoiceStore.getState().screenShareConfig).toBe(publisherConfig);
    useVoiceStore.getState().resetSession();
    expect(useVoiceStore.getState().streamViewerQualities.size).toBe(0);
  });
});
