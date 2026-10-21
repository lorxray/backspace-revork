import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track, type Room, type TrackPublishOptions } from 'livekit-client';
// Exercise the installed SDK's encoding calculation, including its small-source
// limit, rather than checking only the shape of our publish options.
import { computeVideoEncodings } from '../../node_modules/livekit-client/src/room/participant/publishUtils';
import { useVoiceStore } from '../stores/voiceStore';
import { applyOverdrive, buildScreenShareOptions, publishScreenShare, resolveNativeOverdrive, screenSharePublishNeedsRefresh } from './screenShare';

const internals = vi.hoisted(() => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./livekitInternals', () => internals);
vi.mock('./hwOverdrive', () => ({ activate: vi.fn(), deactivate: vi.fn() }));
vi.mock('./voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../stores/screenShareSetupStore', () => ({ openScreenShareSetup: vi.fn() }));
vi.mock('./streamHostLimits', () => ({
  getStreamHostLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 50_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
    allowedResolutions: [540, 720, 1080, 1440, 2160, 'native'],
    allowedFramerates: [30, 45, 60, 75, 90, 120],
  }),
}));

function mediaTrack(width: number, height: number): MediaStreamTrack {
  return {
    id: 'share-video',
    kind: 'video',
    readyState: 'live',
    contentHint: '',
    getSettings: vi.fn(() => ({ width, height })),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

function publishingRoom() {
  const publishTrack = vi.fn().mockResolvedValue({});
  return {
    localParticipant: {
      publishTrack,
      getTrackPublications: vi.fn(() => []),
    },
  } as unknown as Room;
}

function chromiumPrioritySender(video: MediaStreamTrack, encodings: RTCRtpEncodingParameters[]) {
  return {
    track: video,
    getParameters: vi.fn(() => ({
      transactionId: 'sender-transaction',
      encodings: encodings.map(encoding => ({ ...encoding })),
    })),
    setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => {
      // Chromium rejects changes to these sender-wide fields on later RIDs,
      // even when the requested bitrate and framerate changes are supported.
      if (parameters.encodings.some((encoding, index) => index > 0 && (
        encoding.priority !== encodings[index]!.priority
        || encoding.networkPriority !== encodings[index]!.networkPriority
      ))) {
        throw new DOMException('Attempted to set an unimplemented parameter of RtpParameters', 'OperationError');
      }
    }),
  };
}

function runningShare() {
  const video = mediaTrack(2560, 1440);
  const encodings = ['q', 'h', 'f'].map((rid, index) => ({
    rid, active: true, maxBitrate: 30_000_000 / 2 ** (2 - index), maxFramerate: 60,
    scaleResolutionDownBy: 1,
  }));
  const sender = {
    track: video,
    getParameters: vi.fn(() => ({ encodings: encodings.map(encoding => ({ ...encoding })) })),
    setParameters: vi.fn().mockResolvedValue(undefined),
  };
  const backupEncodings = [{ active: false, maxBitrate: 15_000_000, maxFramerate: 30 }];
  const backupSender = {
    getParameters: vi.fn(() => ({ encodings: backupEncodings.map(encoding => ({ ...encoding })) })),
    setParameters: vi.fn().mockResolvedValue(undefined),
  };
  const cachedOptions: TrackPublishOptions = {
    videoCodec: 'h264', simulcast: true,
    screenShareEncoding: { maxBitrate: 30_000_000, maxFramerate: 60 },
    backupCodec: { codec: 'vp8', encoding: { maxBitrate: 15_000_000, maxFramerate: 30 } },
  };
  const trackOptions: TrackPublishOptions = { ...cachedOptions };
  const publication = {
    source: Track.Source.ScreenShare, options: cachedOptions,
    track: {
      mediaStreamTrack: video, encodings: encodings.map(encoding => ({ ...encoding })),
      publishOptions: trackOptions,
      simulcastCodecs: new Map([['vp8', { sender: backupSender, encodings: backupEncodings }]]),
    },
  };
  const room = { localParticipant: { getTrackPublications: () => [publication] } } as unknown as Room;
  internals.getPublisherPC.mockReturnValue({ getSenders: () => [sender] });
  useVoiceStore.getState().setScreenShareConfig({ customBitrateKbps: 20_000, fps: 90 });
  const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
  return { room, sender, backupSender, publication, opts, cachedOptions, trackOptions, backupEncodings };
}

async function publishedShare() {
  const video = mediaTrack(2560, 1440);
  const publication = { source: Track.Source.ScreenShare, track: { mediaStreamTrack: video } };
  const room = {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({}),
      getTrackPublications: () => [publication],
    },
  } as unknown as Room;
  await publishScreenShare(room, {
    getVideoTracks: () => [video], getAudioTracks: () => [],
  } as unknown as MediaStream);
  const options = () => {
    const config = useVoiceStore.getState().screenShareConfig;
    const opts = buildScreenShareOptions(config);
    resolveNativeOverdrive(video, config, opts);
    return opts;
  };
  return { room, video, options };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  internals.getPublisherPC.mockReturnValue(null);
  internals.getMediaStreamTrack.mockImplementation(track => track.mediaStreamTrack);
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    screenShareConfig: {
      height: 1440, fps: 60, mode: 'gaming', customBitrateKbps: 30_000,
      codec: 'h264', shareAudio: false,
    },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('screen-share bitrate simulcast', () => {
  it.each([[2560, 1440], [3440, 1440], [1080, 1920], [1280, 720]])(
    'publishes 30 / 15 / 7.5 Mbps at the same captured %i × %i and 60 FPS',
    async (width, height) => {
      const video = mediaTrack(width, height);
      const room = publishingRoom();
      const stream = {
        getVideoTracks: () => [video], getAudioTracks: () => [],
      } as unknown as MediaStream;

      expect(await publishScreenShare(room, stream)).toBe(true);
      const publish = vi.mocked(room.localParticipant.publishTrack).mock.calls[0]![1]!;
      const encodings = computeVideoEncodings(true, width, height, publish);
      expect(publish.videoCodec).toBe('h264');
      expect(publish.simulcast).toBe(true);
      expect(publish.degradationPreference).toBe('maintain-resolution');
      expect(encodings.map(encoding => ({
        rid: encoding.rid, maxBitrate: encoding.maxBitrate,
        maxFramerate: encoding.maxFramerate, scale: encoding.scaleResolutionDownBy,
      }))).toEqual([
        { rid: 'q', maxBitrate: 7_500_000, maxFramerate: 60, scale: 1 },
        { rid: 'h', maxBitrate: 15_000_000, maxFramerate: 60, scale: 1 },
        { rid: 'f', maxBitrate: 30_000_000, maxFramerate: 60, scale: 1 },
      ]);
      expect(useVoiceStore.getState().screenShareConfig.customBitrateKbps).toBe(30_000);
    },
  );

  it('resolves native auto bitrate and all layer limits before the first publish', async () => {
    useVoiceStore.getState().setScreenShareConfig({ height: 'native', customBitrateKbps: null });
    const video = mediaTrack(1280, 720);
    const room = publishingRoom();
    await publishScreenShare(room, {
      getVideoTracks: () => [video], getAudioTracks: () => [],
    } as unknown as MediaStream);

    const publish = vi.mocked(room.localParticipant.publishTrack).mock.calls[0]![1]!;
    expect(publish.screenShareEncoding?.maxBitrate).toBe(4_000_000);
    expect(publish.backupCodec).toMatchObject({ encoding: { maxBitrate: 2_000_000, maxFramerate: 30 } });
    expect(computeVideoEncodings(true, 1280, 720, publish).map(item => item.maxBitrate))
      .toEqual([1_000_000, 2_000_000, 4_000_000]);
    expect(useVoiceStore.getState().screenShareConfig).toMatchObject({ height: 'native', customBitrateKbps: null });
  });

  it.each([[800, 450, 2], [320, 180, 1]])(
    'retains actual %i × %i dimensions when the SDK can publish only %i layers',
    (width, height, count) => {
      const config = useVoiceStore.getState().screenShareConfig;
      const opts = buildScreenShareOptions(config);
      resolveNativeOverdrive(mediaTrack(width, height), config, opts);
      const encodings = computeVideoEncodings(true, width, height, {
        ...opts.publish, screenShareEncoding: opts.publish.videoEncoding,
      });
      expect(encodings).toHaveLength(count);
      expect(encodings.every(encoding => encoding.scaleResolutionDownBy === 1)).toBe(true);
      expect(encodings.at(-1)?.maxBitrate).toBe(30_000_000);
    },
  );

  it('keeps the saved VP9 codec on its single spatial quality', () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'vp9' });
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);
    expect(opts.publish.videoCodec).toBe('vp9');
    expect(opts.publish.simulcast).toBe(false);
    expect(opts.publish.screenShareSimulcastLayers).toBeUndefined();
    expect(computeVideoEncodings(true, 2560, 1440, {
      ...opts.publish, screenShareEncoding: opts.publish.videoEncoding, scalabilityMode: 'L1T3',
    })).toHaveLength(1);
  });

  it.each([
    { customBitrateKbps: 20_000 }, { fps: 90 }, { height: 1080 }, { codec: 'vp9' as const },
  ])('requires a fresh publication when encoding intent changes to %o', async patch => {
    const share = await publishedShare();
    expect(screenSharePublishNeedsRefresh(share.room, share.options())).toBe(false);
    useVoiceStore.getState().setScreenShareConfig(patch);
    expect(screenSharePublishNeedsRefresh(share.room, share.options())).toBe(true);
  });

  it('keeps audio and content-mode changes on the current publication', async () => {
    const share = await publishedShare();
    useVoiceStore.getState().setScreenShareConfig({ shareAudio: true, mode: 'text' });
    expect(screenSharePublishNeedsRefresh(share.room, share.options())).toBe(false);
  });

  it('compares effective caps rather than custom values above the host limit', async () => {
    useVoiceStore.getState().setScreenShareConfig({ customBitrateKbps: 100_000 });
    const share = await publishedShare();
    useVoiceStore.getState().setScreenShareConfig({ customBitrateKbps: 200_000 });
    expect(screenSharePublishNeedsRefresh(share.room, share.options())).toBe(false);
  });

  it('refreshes advertised dimensions when the actual capture changes size', async () => {
    const share = await publishedShare();
    vi.mocked(share.video.getSettings).mockReturnValue({ width: 1920, height: 1080 });
    expect(screenSharePublishNeedsRefresh(share.room, share.options())).toBe(true);
    expect(screenSharePublishNeedsRefresh(publishingRoom(), share.options())).toBe(false);
  });

  it('retains confirmed cached caps when a primary sender write fails, then commits a successful retry', async () => {
    const share = runningShare();
    const originalEncodings = share.publication.track.encodings.map(encoding => ({ ...encoding }));
    share.sender.setParameters.mockRejectedValueOnce(new Error('sender write rejected'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(false);
    expect(share.publication.track.encodings).toEqual(originalEncodings);
    expect(share.cachedOptions.screenShareEncoding).toEqual({ maxBitrate: 30_000_000, maxFramerate: 60 });
    expect(share.trackOptions.screenShareEncoding).toEqual({ maxBitrate: 30_000_000, maxFramerate: 60 });
    expect(share.backupSender.setParameters).not.toHaveBeenCalled();

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(true);
    expect(share.publication.track.encodings.map(encoding => encoding.maxBitrate)).toEqual([5_000_000, 10_000_000, 20_000_000]);
    expect(share.cachedOptions.screenShareEncoding).toEqual({ maxBitrate: 20_000_000, maxFramerate: 90 });
    warn.mockRestore();
  });

  it('commits backup caches and reconnect options only after the backup sender accepts its caps', async () => {
    const share = runningShare();
    share.backupSender.setParameters.mockRejectedValueOnce(new Error('backup write rejected'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(false);
    expect(share.cachedOptions.screenShareEncoding).toEqual({ maxBitrate: 20_000_000, maxFramerate: 90 });
    expect(share.backupEncodings).toEqual([{ active: false, maxBitrate: 15_000_000, maxFramerate: 30 }]);
    expect(share.cachedOptions.backupCodec).toMatchObject({ encoding: { maxBitrate: 15_000_000, maxFramerate: 30 } });
    expect(share.trackOptions.backupCodec).toMatchObject({ encoding: { maxBitrate: 15_000_000, maxFramerate: 30 } });

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(true);
    expect(share.backupEncodings).toEqual([expect.objectContaining({ active: false, maxBitrate: 6_666_667, maxFramerate: 30 })]);
    expect(share.cachedOptions.backupCodec).toMatchObject({ encoding: { maxBitrate: 6_666_667, maxFramerate: 30 } });
    expect(share.trackOptions.backupCodec).toMatchObject({ encoding: { maxBitrate: 6_666_667, maxFramerate: 30 } });
    warn.mockRestore();
  });

  it('applies simulcast caps with Chromium sender-wide priority only on the first RID', async () => {
    const share = runningShare();
    const video = share.publication.track.mediaStreamTrack;
    const original: RTCRtpEncodingParameters[] = ['q', 'h', 'f'].map((rid, index) => ({
      rid, active: index !== 1, maxBitrate: 30_000_000 / 2 ** (2 - index),
      maxFramerate: 60, scaleResolutionDownBy: 1,
      priority: index === 1 ? 'medium' : 'low', networkPriority: 'low',
    }));
    const sender = chromiumPrioritySender(video, original);
    const backupSender = chromiumPrioritySender(video, original);
    const cached = original.map(encoding => ({ ...encoding }));
    const backupCached = original.map(encoding => ({ ...encoding }));
    share.publication.track.encodings = cached as typeof share.publication.track.encodings;
    share.publication.track.simulcastCodecs.set('vp8', {
      sender: backupSender, encodings: backupCached,
    } as unknown as ReturnType<typeof share.publication.track.simulcastCodecs.get> & object);
    internals.getPublisherPC.mockReturnValue({ getSenders: () => [sender] });

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(true);
    for (const appliedSender of [sender, backupSender]) {
      const parameters = appliedSender.setParameters.mock.calls[0]![0];
      expect(parameters.transactionId).toBe('sender-transaction');
      expect(parameters.encodings.map(encoding => encoding.rid)).toEqual(['q', 'h', 'f']);
      expect(parameters.encodings.map(encoding => encoding.active)).toEqual([true, false, true]);
      expect(parameters.encodings.map(encoding => encoding.scaleResolutionDownBy)).toEqual([1, 1, 1]);
      expect(parameters.encodings.map(encoding => encoding.priority)).toEqual(['high', 'medium', 'low']);
      expect(parameters.encodings.map(encoding => encoding.networkPriority)).toEqual(['high', 'low', 'low']);
    }
    expect(sender.setParameters.mock.calls[0]![0].encodings.map(encoding => encoding.maxBitrate))
      .toEqual([5_000_000, 10_000_000, 20_000_000]);
    expect(backupSender.setParameters.mock.calls[0]![0].encodings.map(encoding => encoding.maxBitrate))
      .toEqual([1_666_667, 3_333_334, 6_666_667]);
    for (const encodings of [cached, backupCached]) {
      expect(encodings.map(encoding => encoding.priority)).toEqual(['high', 'medium', 'low']);
      expect(encodings.map(encoding => encoding.networkPriority)).toEqual(['high', 'low', 'low']);
    }
  });

  it('sets camera priority on the first encoding while capping only its highest layer', async () => {
    const share = runningShare();
    const video = share.publication.track.mediaStreamTrack;
    const original: RTCRtpEncodingParameters[] = ['q', 'h', 'f'].map((rid, index) => ({
      rid, maxBitrate: 30_000_000 / 2 ** (2 - index), maxFramerate: 60,
      priority: 'low', networkPriority: 'low',
    }));
    const sender = chromiumPrioritySender(video, original);
    share.publication.source = Track.Source.Camera;
    internals.getPublisherPC.mockReturnValue({ getSenders: () => [sender] });

    expect(await applyOverdrive(share.room, Track.Source.Camera, share.opts.overdrive)).toBe(true);
    const parameters = sender.setParameters.mock.calls[0]![0];
    expect(parameters.encodings.map(encoding => encoding.maxBitrate)).toEqual([7_500_000, 15_000_000, 20_000_000]);
    expect(parameters.encodings.map(encoding => encoding.maxFramerate)).toEqual([60, 60, 90]);
    expect(parameters.encodings.map(encoding => encoding.priority)).toEqual(['high', 'low', 'low']);
    expect(parameters.encodings.map(encoding => encoding.networkPriority)).toEqual(['high', 'low', 'low']);
    expect(parameters.encodings.map(encoding => encoding.rid)).toEqual(['q', 'h', 'f']);
    expect(share.backupSender.setParameters).not.toHaveBeenCalled();
  });

  it('updates confirmed sender caches without waking paused layers or mutating advertised SFU metadata', async () => {
    const video = mediaTrack(2560, 1440);
    const liveEncodings = [
      { rid: 'q', active: false, maxBitrate: 10, scaleResolutionDownBy: 4 },
      { rid: 'h', active: false, maxBitrate: 15_000_000, scaleResolutionDownBy: 1 },
      { rid: 'f', active: true, maxBitrate: 30_000_000, scaleResolutionDownBy: 1 },
    ];
    const sender = {
      track: video,
      getParameters: vi.fn(() => ({ encodings: liveEncodings.map(encoding => ({ ...encoding })) })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const cachedEncodings = liveEncodings.map(encoding => ({ ...encoding }));
    const cachedOptions: TrackPublishOptions = { videoCodec: 'h264', simulcast: true };
    const trackOptions: TrackPublishOptions = { ...cachedOptions };
    const sendUpdateVideoLayers = vi.fn().mockResolvedValue(undefined);
    const layers = [0, 1, 2].map(quality => ({ quality, bitrate: 30_000_000 / 2 ** (2 - quality), width: 2560, height: 1440 }));
    const backupEncodings = [{ active: false, maxBitrate: 15_000_000 }];
    const backupSender = {
      getParameters: vi.fn(() => ({ encodings: backupEncodings.map(item => ({ ...item })) })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const releaseLock = vi.fn();
    const publication = {
      source: Track.Source.ScreenShare, trackSid: 'share-sid', options: cachedOptions,
      trackInfo: { width: 2560, height: 1440, layers, codecs: [{ mimeType: 'video/h264', layers: layers.map(layer => ({ ...layer })) }] },
      track: {
        mediaStreamTrack: video, encodings: cachedEncodings, publishOptions: trackOptions,
        signalClient: { sendUpdateVideoLayers },
        senderLock: { lock: vi.fn().mockResolvedValue(releaseLock) },
        simulcastCodecs: new Map([['vp8', { sender: backupSender, encodings: backupEncodings }]]),
      },
    };
    const room = { localParticipant: { getTrackPublications: () => [publication] } } as unknown as Room;
    internals.getPublisherPC.mockReturnValue({ getSenders: () => [sender] });
    useVoiceStore.getState().setScreenShareConfig({ customBitrateKbps: 20_000, fps: 90 });
    const opts = buildScreenShareOptions(useVoiceStore.getState().screenShareConfig);

    expect(await applyOverdrive(room, Track.Source.ScreenShare, opts.overdrive)).toBe(true);
    const sent = sender.setParameters.mock.calls[0]![0];
    expect(sent.encodings.map((item: RTCRtpEncodingParameters) => item.active)).toEqual([false, false, true]);
    expect(sent.encodings.map((item: RTCRtpEncodingParameters) => item.maxBitrate)).toEqual([10, 10_000_000, 20_000_000]);
    expect(sent.encodings[0].scaleResolutionDownBy).toBe(4);
    expect(cachedEncodings.map(item => item.maxBitrate)).toEqual([5_000_000, 10_000_000, 20_000_000]);
    expect(cachedEncodings.every(item => item.scaleResolutionDownBy === 1)).toBe(true);
    expect(cachedOptions.screenShareEncoding).toMatchObject({ maxBitrate: 20_000_000, maxFramerate: 90 });
    expect(trackOptions.screenShareSimulcastLayers?.map(layer => layer.encoding.maxBitrate)).toEqual([5_000_000, 10_000_000]);
    expect(sent.encodings.every((item: RTCRtpEncodingParameters & { scalabilityMode?: string }) => item.scalabilityMode === 'L1T1')).toBe(true);
    expect(cachedEncodings.every(item => (item as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode === 'L1T1')).toBe(true);
    expect(layers.map(layer => layer.bitrate)).toEqual([7_500_000, 15_000_000, 30_000_000]);
    expect(sendUpdateVideoLayers).not.toHaveBeenCalled();
    expect(backupSender.setParameters.mock.calls[0]![0].encodings[0]).toMatchObject({ active: false, maxBitrate: 6_666_667, maxFramerate: 30 });
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('preserves VP9 temporal scalability and does not apply H264 mode to the VP8 backup', async () => {
    const share = runningShare();
    share.cachedOptions.videoCodec = 'vp9';
    share.trackOptions.videoCodec = 'vp9';
    share.sender.getParameters.mockReturnValue({ encodings: [
      { active: true, maxBitrate: 20_000_000, maxFramerate: 90, scalabilityMode: 'L1T3' },
    ] } as unknown as ReturnType<typeof share.sender.getParameters>);

    expect(await applyOverdrive(share.room, Track.Source.ScreenShare, share.opts.overdrive)).toBe(true);
    const parameters = share.sender.setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
    expect((parameters.encodings[0] as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode).toBe('L1T3');
    const backupParameters = share.backupSender.setParameters.mock.calls[0]![0] as RTCRtpSendParameters;
    expect(backupParameters.encodings[0]).not.toHaveProperty('scalabilityMode');
  });
});
