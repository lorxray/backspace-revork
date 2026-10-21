import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPresets, BackupCodecPolicy, Track } from 'livekit-client';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import i18n from '../i18n';
import { getLastScreenShareSource, rememberScreenShareSource } from './lastScreenShareSource';
import {
  buildScreenShareOptions,
  getPublishedScreenShareCodec,
  publishScreenShare,
  stageScreenCapture,
  stopScreenShare,
} from './screenShare';

const sdp = vi.hoisted(() => ({ activate: vi.fn(), deactivate: vi.fn() }));
const internals = vi.hoisted(() => ({ getPublisherPC: vi.fn(), getMediaStreamTrack: vi.fn() }));
vi.mock('./hwOverdrive', () => sdp);
vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setInputVolume: vi.fn() }) },
}));
vi.mock('./streamHostLimits', () => ({
  getStreamHostLimits: () => ({
    minBitrateKbps: 500,
    maxBitrateKbps: 20_000,
    allowCustomBitrate: true,
    bitrateMatrixOverrides: null,
    allowedResolutions: [540, 720, 1080, 1440, 2160, 'native'],
    allowedFramerates: [30, 45, 60, 75, 90, 120],
  }),
}));
vi.mock('./livekitInternals', () => internals);

type FakeTrack = {
  kind: 'video' | 'audio';
  readyState: 'live';
  contentHint: string;
  stop: ReturnType<typeof vi.fn>;
};

function makeTrack(kind: FakeTrack['kind']): FakeTrack {
  return { kind, readyState: 'live', contentHint: '', stop: vi.fn() };
}

function makeVideoTrack(id = 'screen-video') {
  return {
    ...makeTrack('video'),
    id,
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn(() => ({ width: 2560, height: 1440 })),
  };
}

function makeStream(video = makeTrack('video'), audio?: FakeTrack) {
  const tracks = [video, ...(audio ? [audio] : [])];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => [video],
    getAudioTracks: () => audio ? [audio] : [],
  } as unknown as MediaStream;
}

function fakeRoom() {
  return {
    localParticipant: {
      publishTrack: vi.fn().mockResolvedValue({}),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn(),
      getTrackPublications: vi.fn(() => []),
    },
  } as any;
}

function attachPublishedSender(
  room: ReturnType<typeof fakeRoom>,
  video: ReturnType<typeof makeVideoTrack>,
  reports: Array<[string, Record<string, unknown>]>,
) {
  const publicationTrack = { mediaStreamTrack: video };
  const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
  room.localParticipant.getTrackPublications.mockReturnValue([publication]);
  const sender = {
    track: { id: video.id },
    getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
    setParameters: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue(new Map(reports)),
  };
  internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
  internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
  return sender;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  internals.getPublisherPC.mockReturnValue(null);
  internals.getMediaStreamTrack.mockReturnValue(null);
  localStorage.clear();
  rememberScreenShareSource(null);
  useUIStore.setState({ toasts: [] });
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    screenShareConfig: {
      height: 1440,
      fps: 60,
      mode: 'gaming',
      customBitrateKbps: 18_000,
      shareAudio: true,
      codec: 'vp9',
    },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('screen-share media options', () => {
  it.each([true, false])('reports a video publication failure accurately with system audio %s', async (shareAudio) => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264', shareAudio });
    const video = makeVideoTrack();
    video.getSettings.mockReturnValue({ width: 3840, height: 2160 });
    const audio = shareAudio ? makeTrack('audio') : undefined;
    const room = fakeRoom();
    const failure = new DOMException('Failed to set video send parameters', 'OperationError');
    room.localParticipant.publishTrack.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const source: ElectronScreenSource = {
      id: 'screen:0:0', name: 'Monitor', isScreen: true, appIconDataUrl: null, thumbnailDataUrl: '',
    };

    expect(await publishScreenShare(room, makeStream(video, audio), { source, sourceId: source.id, pickerMode: 'app' })).toBe(false);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
    if (audio) expect(audio.stop).toHaveBeenCalledOnce();
    expect(useUIStore.getState().toasts).toEqual([
      expect.objectContaining({ message: i18n.t('voice:screenPicker.startFailed') }),
    ]);
    const output = consoleError.mock.calls.find(([message]) => typeof message === 'string' && message.startsWith('[ScreenShare:Diagnostic] '))?.[0];
    expect(JSON.parse(String(output).slice('[ScreenShare:Diagnostic] '.length))).toMatchObject({
      phase: 'video-publish', codec: 'h264', sourceKind: 'monitor',
      requested: { width: 2560, height: 1440, frameRate: 60, maxBitrate: 18_000_000, shareAudio },
      capture: { width: 3840, height: 2160 },
      audio: { present: shareAudio, live: shareAudio, enabled: shareAudio },
      error: { name: 'OperationError', message: failure.message },
    });
  });

  it('reports the audio phase and withdraws video when publishing system audio fails', async () => {
    const video = makeVideoTrack();
    const audio = makeTrack('audio');
    const room = fakeRoom();
    const failure = new Error('Audio negotiation rejected');
    room.localParticipant.publishTrack.mockResolvedValueOnce({}).mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await publishScreenShare(room, makeStream(video, audio))).toBe(false);

    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(video, false);
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(useUIStore.getState().toasts).toEqual([
      expect.objectContaining({ message: i18n.t('voice:streamSettings.systemAudioStartFailed') }),
    ]);
    const output = consoleError.mock.calls.find(([message]) => typeof message === 'string' && message.startsWith('[ScreenShare:Diagnostic] '))?.[0];
    expect(JSON.parse(String(output).slice('[ScreenShare:Diagnostic] '.length))).toMatchObject({
      phase: 'audio-publish', error: { name: 'Error', message: failure.message },
    });
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
  });

  it('does not record cancellation as a failed publication or display an error toast', async () => {
    const room = fakeRoom();
    room.localParticipant.publishTrack.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await publishScreenShare(room, makeStream(makeVideoTrack(), makeTrack('audio')))).toBe(false);

    expect(consoleError).not.toHaveBeenCalled();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('remembers only published settings and source; cancelled setup edits do not replace them', async () => {
    const room = fakeRoom();
    const source: ElectronScreenSource = {
      id: 'window:23:0', name: 'Game', isScreen: false, appIconDataUrl: null, thumbnailDataUrl: '',
    };
    const config = { ...useVoiceStore.getState().screenShareConfig };
    await publishScreenShare(room, makeStream(makeVideoTrack()), { sourceId: source.id, source, pickerMode: 'app' });
    expect(getLastScreenShareSource()).toEqual({ id: source.id, name: source.name, isScreen: false, appIconDataUrl: null });
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig).toEqual(config);
    useVoiceStore.getState().setScreenShareConfig({ fps: 30 });
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig?.fps).toBe(30);
    useVoiceStore.setState({ isScreenSharing: false });
    useVoiceStore.getState().setScreenShareConfig({ fps: 120 });
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig?.fps).toBe(30);
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.lastSuccessfulScreenShareConfig.fps).toBe(30);
    expect(persisted.state).not.toHaveProperty('lastSource');
  });

  it('invalidates the quick-start source when the OS ends that capture', async () => {
    const room = fakeRoom();
    const source: ElectronScreenSource = {
      id: 'window:23:0', name: 'Game', isScreen: false, appIconDataUrl: null, thumbnailDataUrl: '',
    };
    const video = { ...makeVideoTrack(), addEventListener: vi.fn() };
    await publishScreenShare(room, makeStream(video), { sourceId: source.id, source, pickerMode: 'app' });
    expect(getLastScreenShareSource()).not.toBe(null);
    const onEnded = video.addEventListener.mock.calls.find(([event]) => event === 'ended')![1];
    onEnded();
    expect(getLastScreenShareSource()).toBe(null);
  });

  it('stops every staged track without publishing after a pending start was cancelled', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    const audio = makeTrack('audio');
    expect(await publishScreenShare(room, makeStream(video, audio), { isCurrent: () => false })).toBe(false);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig).toBe(null);
  });

  it.each(['video', 'audio'])('rolls back a start abandoned during %s publication', async (during) => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    const audio = makeTrack('audio');
    let current = true;
    room.localParticipant.publishTrack.mockImplementation(async (_track: unknown, options: { source: string }) => {
      if (options.source === (during === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio)) current = false;
      return {};
    });
    expect(await publishScreenShare(room, makeStream(video, audio), { isCurrent: () => current })).toBe(false);
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(video, false);
    if (during === 'audio') expect(room.localParticipant.unpublishTrack).toHaveBeenCalledWith(audio, false);
    else expect(room.localParticipant.publishTrack).not.toHaveBeenCalledWith(audio, expect.anything());
    expect(video.stop).toHaveBeenCalledOnce();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(useVoiceStore.getState().isScreenSharing).toBe(false);
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig).toBe(null);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('publishes VP9 directly without enabling the H.264 sender hook', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
      ['outbound-vp9', {
        id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
      }],
    ]);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: Track.Source.ScreenShare, videoCodec: 'vp9' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('vp9');
    expect(sdp.activate).not.toHaveBeenCalled();
    expect(sdp.deactivate).not.toHaveBeenCalled();
  });

  it('uses the persisted codec on the first publication and keeps it after stop', async () => {
    const room = fakeRoom();
    const video = makeVideoTrack();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'VideoToolbox',
      }],
    ]);
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ videoCodec: 'h264' }),
    );
    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(sdp.activate).toHaveBeenCalledOnce();
    expect(sdp.activate).toHaveBeenCalledWith(video.id);
    expect(sdp.deactivate).toHaveBeenCalledOnce();

    await stopScreenShare(room);
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
    const persisted = JSON.parse(localStorage.getItem('backspace-voice-settings') ?? '{}');
    expect(persisted.state.screenShareConfig.codec).toBe('h264');
  });

  it('requests unprocessed stereo capture and publishes stereo music audio', async () => {
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    const stream = makeStream(video, audio);
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia },
    });

    await stageScreenCapture();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        restrictOwnAudio: true,
      }),
    }));

    const room = fakeRoom();
    await publishScreenShare(room, stream);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
      audio,
      expect.objectContaining({
        source: Track.Source.ScreenShareAudio,
        audioPreset: AudioPresets.musicHighQualityStereo,
        dtx: false,
        red: false,
        forceStereo: true,
      }),
    );
  });

  it('keeps the measured Gaming/Text adaptation and dynacast-managed VP8 backup without the ignored minBitrate member', () => {
    const base = useVoiceStore.getState().screenShareConfig;
    const gaming = buildScreenShareOptions({ ...base, mode: 'gaming' });
    const text = buildScreenShareOptions({ ...base, mode: 'text' });

    expect(gaming.contentHint).toBe('motion');
    expect(gaming.overdrive.degradationPreference).toBe('balanced');
    expect(text.contentHint).toBe('detail');
    expect(text.overdrive.degradationPreference).toBe('maintain-resolution');
    expect(gaming.publish.backupCodecPolicy).toBe(BackupCodecPolicy.SIMULCAST);
    expect(gaming.overdrive).not.toHaveProperty('minBitrate');
  });

  it('retries until the screen-share sender is ready and reasserts the ceiling at five seconds', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);

    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    expect(sender.setParameters).toHaveBeenLastCalledWith(expect.objectContaining({
      encodings: [expect.objectContaining({ maxBitrate: 18_000_000, maxFramerate: 60 })],
      degradationPreference: 'balanced',
    }));

    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries an empty placeholder encoding and continues when capture constraints fail', async () => {
    const video = makeVideoTrack();
    video.applyConstraints.mockRejectedValue(new DOMException('unsupported', 'OverconstrainedError'));
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    let encodings: RTCRtpEncodingParameters[] = [{}];
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map()),
    };
    internals.getPublisherPC.mockReturnValue({ getSenders: vi.fn(() => [sender]) });
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(sender.setParameters).not.toHaveBeenCalled();

    encodings = [{ active: true }];
    await vi.advanceTimersByTimeAsync(250);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4750);
    expect(sender.setParameters).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenCalledOnce();
  });

  it('retries negotiated-codec inspection until the sender appears', async () => {
    const video = makeVideoTrack();
    const publicationTrack = { mediaStreamTrack: video };
    const publication = { source: Track.Source.ScreenShare, track: publicationTrack };
    const room = fakeRoom();
    room.localParticipant.getTrackPublications.mockReturnValue([publication]);
    const sender = {
      track: { id: video.id },
      getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue(new Map([
        ['codec-vp9', { id: 'codec-vp9', type: 'codec', mimeType: 'video/VP9' }],
        ['outbound-vp9', {
          id: 'outbound-vp9', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp9', bytesSent: 100,
        }],
      ])),
    };
    const peerConnection = { getSenders: vi.fn((): typeof sender[] => []) };
    internals.getPublisherPC.mockReturnValue(peerConnection);
    internals.getMediaStreamTrack.mockImplementation((track) => track.mediaStreamTrack);

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPublishedScreenShareCodec()).toBeNull();

    peerConnection.getSenders.mockReturnValue([sender]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getPublishedScreenShareCodec()).toBe('vp9');
  });

  it('warns with localized copy when H264 falls back to OpenH264 software encoding', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['codec-vp8', { id: 'codec-vp8', type: 'codec', mimeType: 'video/VP8' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 100, encoderImplementation: 'OpenH264',
      }],
      ['outbound-vp8', {
        id: 'outbound-vp8', type: 'outbound-rtp', kind: 'video', codecId: 'codec-vp8',
        bytesSent: 0, encoderImplementation: 'libvpx',
      }],
    ]);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);

    expect(getPublishedScreenShareCodec()).toBe('h264');
    expect(addToast).toHaveBeenCalledWith(
      i18n.t('voice:streamSettings.softwareH264Fallback'),
      'warning',
      8000,
    );
  });

  it('records encoder snapshots only during the existing bounded H264 detection attempts', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    const sender = attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e033;packetization-mode=1' }],
      ['outbound-h264', { id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 100 }],
    ]);
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(output).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(999);
    expect(output).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(output).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(output).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(output).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.getStats).toHaveBeenCalledTimes(4);
    expect(output).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(output.mock.calls[0]![0]).slice('[ScreenShare:Diagnostic] '.length))).toMatchObject({
      phase: 'encoder', codec: 'h264', capture: { width: 2560, height: 1440 },
      encoders: [{ codec: 'h264', profile: '42e033', packetizationMode: '1', implementation: null }],
    });
  });

  it.each(['replaced', 'stopped'])('discards pending encoder stats after the capture is %s', async (change) => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    const sender = attachPublishedSender(room, video, []);
    let resolveStats!: (stats: Map<string, Record<string, unknown>>) => void;
    sender.getStats.mockReturnValueOnce(new Promise<Map<string, Record<string, unknown>>>((resolve) => { resolveStats = resolve; }));
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    if (change === 'replaced') {
      room.localParticipant.getTrackPublications.mockReturnValue([{
        source: Track.Source.ScreenShare, track: { mediaStreamTrack: makeVideoTrack('replacement') },
      }]);
    } else {
      useVoiceStore.setState({ isScreenSharing: false });
    }
    resolveStats(new Map([
      ['outbound-h264', { id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', mimeType: 'video/H264',
        bytesSent: 100, framesEncoded: 1, encoderImplementation: 'OpenH264' }],
    ]));
    await vi.advanceTimersByTimeAsync(8000);

    expect(output).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    expect(getPublishedScreenShareCodec()).toBeNull();
    expect(sender.getStats).toHaveBeenCalledOnce();
  });

  it('waits for encoded H264 media before reporting software encoding', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    const reports: Array<[string, Record<string, unknown>]> = [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-h264', {
        id: 'outbound-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 0, framesEncoded: 0, encoderImplementation: 'OpenH264',
      }],
    ];
    const sender = attachPublishedSender(room, video, reports);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(0);
    expect(addToast).not.toHaveBeenCalled();

    sender.getStats.mockResolvedValue(new Map([
      reports[0]!,
      ['outbound-h264', { ...reports[1]![1], bytesSent: 5000, framesEncoded: 2 }],
    ]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(addToast).toHaveBeenCalledWith(
      i18n.t('voice:streamSettings.softwareH264Fallback'), 'warning', 8000,
    );
  });

  it('does not report a dormant software layer as the active H264 encoder', async () => {
    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    const video = makeVideoTrack();
    const room = fakeRoom();
    attachPublishedSender(room, video, [
      ['codec-h264', { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' }],
      ['outbound-q', {
        id: 'outbound-q', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 0, framesEncoded: 0, encoderImplementation: 'OpenH264',
      }],
      ['outbound-f', {
        id: 'outbound-f', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
        bytesSent: 5000, framesEncoded: 2, encoderImplementation: 'ExternalEncoder',
      }],
    ]);
    const addToast = vi.spyOn(useUIStore.getState(), 'addToast');

    await publishScreenShare(room, makeStream(video));
    await vi.advanceTimersByTimeAsync(8000);
    expect(addToast).not.toHaveBeenCalled();
    expect(getPublishedScreenShareCodec()).toBe('h264');
  });

  it('migrates older saved settings to VP9 once and persists subsequent choices', async () => {
    localStorage.setItem('backspace-voice-settings', JSON.stringify({
      version: 13,
      state: {
        screenShareConfig: {
          height: 1080,
          fps: 30,
          mode: 'text',
          customBitrateKbps: null,
          shareAudio: false,
        },
      },
    }));

    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('vp9');

    useVoiceStore.getState().setScreenShareConfig({ codec: 'h264' });
    await useVoiceStore.persist.rehydrate();
    expect(useVoiceStore.getState().screenShareConfig.codec).toBe('h264');
  });
});
