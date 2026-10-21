import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState } from 'livekit-client';

const deps = vi.hoisted(() => ({
  room: { state: 'connected', localParticipant: {} },
  getActiveRoom: vi.fn(),
  stageScreenCapture: vi.fn(), publishScreenShare: vi.fn(), stopStagedCapture: vi.fn(),
  broadcastVoiceStatus: vi.fn(), getScreenSources: vi.fn(), preselectScreenSource: vi.fn(),
  getScreenSharePickerMode: vi.fn(),
}));
vi.mock('../hooks/useLiveKit', () => ({ getActiveRoom: deps.getActiveRoom }));
vi.mock('./screenShare', () => ({
  stageScreenCapture: deps.stageScreenCapture, publishScreenShare: deps.publishScreenShare,
  stopStagedCapture: deps.stopStagedCapture,
}));
vi.mock('./voice', () => ({ broadcastVoiceStatus: deps.broadcastVoiceStatus }));
vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

import { quickStartScreenShare } from './quickStartScreenShare';
import { useVoiceStore, type ScreenShareConfig } from '../stores/voiceStore';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
import { getLastScreenShareSource, rememberScreenShareSource } from './lastScreenShareSource';

const config: ScreenShareConfig = {
  height: 1440, fps: 60, customBitrateKbps: 30_000, mode: 'text', shareAudio: true, codec: 'h264',
};
const source: ElectronScreenSource = {
  id: 'window:123:0', name: 'Editor', isScreen: false, appIconDataUrl: 'app-icon', thumbnailDataUrl: 'frame-1',
};
const stream = { getTracks: () => [] } as unknown as MediaStream;
const room = () => deps.room as never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('desktop quick start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.room.state = ConnectionState.Connected;
    deps.getActiveRoom.mockReturnValue(deps.room);
    deps.getScreenSharePickerMode.mockResolvedValue('app');
    deps.getScreenSources.mockResolvedValue([{ ...source, thumbnailDataUrl: 'frame-2' }]);
    deps.preselectScreenSource.mockResolvedValue(undefined);
    deps.stageScreenCapture.mockResolvedValue(stream);
    deps.publishScreenShare.mockResolvedValue(true);
    window.backspace = {
      getScreenSources: deps.getScreenSources, preselectScreenSource: deps.preselectScreenSource,
      getScreenSharePickerMode: deps.getScreenSharePickerMode,
    } as unknown as BackspaceElectronAPI;
    useVoiceStore.setState({
      isScreenSharing: false, isLiveKitConnected: true,
      screenShareConfig: { ...config, height: 720, shareAudio: false },
      lastSuccessfulScreenShareConfig: { ...config },
    });
    useScreenShareSetupStore.setState({ isOpen: false, isStarting: false });
    rememberScreenShareSource(source);
  });

  it('restores last published settings and starts the freshly matched source without setup', async () => {
    await quickStartScreenShare(room());
    expect(useVoiceStore.getState().screenShareConfig).toEqual(config);
    expect(deps.preselectScreenSource).toHaveBeenCalledWith(source.id, true);
    expect(deps.publishScreenShare).toHaveBeenCalledWith(deps.room, stream, expect.objectContaining({
      sourceId: source.id, pickerMode: 'app', source: expect.objectContaining({ thumbnailDataUrl: 'frame-2' }),
    }));
    expect(deps.broadcastVoiceStatus).toHaveBeenCalledTimes(1);
    expect(deps.stopStagedCapture).toHaveBeenCalledWith(null);
    expect(useScreenShareSetupStore.getState()).toMatchObject({ isOpen: false, isStarting: false });
  });

  it.each(['first-use', 'app-restart'])('asks for a source on %s without capturing', async () => {
    rememberScreenShareSource(null);
    useVoiceStore.setState({ lastScreenShareSourceId: source.id }); // Persisted setup hint is not authority.
    await quickStartScreenShare(room());
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(deps.stageScreenCapture).not.toHaveBeenCalled();
  });

  it('does not select a different lone monitor when the remembered window vanished', async () => {
    deps.getScreenSources.mockResolvedValue([{ ...source, id: 'screen:0:0', name: 'Screen 1', isScreen: true }]);
    await quickStartScreenShare(room());
    expect(getLastScreenShareSource()).toBe(null);
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(deps.preselectScreenSource).not.toHaveBeenCalled();
  });

  it.each([{ name: 'Another window' }, { appIconDataUrl: 'other-app' }, { isScreen: true }])(
    'rejects a reused source id with changed metadata %j', async (changed) => {
      deps.getScreenSources.mockResolvedValue([{ ...source, ...changed }]);
      await quickStartScreenShare(room());
      expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
      expect(deps.stageScreenCapture).not.toHaveBeenCalled();
    },
  );

  it('respects system picker mode without enumerating or capturing automatically', async () => {
    deps.getScreenSharePickerMode.mockResolvedValue('system');
    await quickStartScreenShare(room());
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(deps.getScreenSources).not.toHaveBeenCalled();
    expect(deps.stageScreenCapture).not.toHaveBeenCalled();
  });

  it('falls back to ordinary setup in browsers', async () => {
    delete window.backspace;
    await quickStartScreenShare(room());
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
    expect(deps.stageScreenCapture).not.toHaveBeenCalled();
  });

  it('holds a synchronous lock against double clicks and opening settings', async () => {
    const capture = deferred<MediaStream>();
    deps.stageScreenCapture.mockReturnValue(capture.promise);
    const first = quickStartScreenShare(room());
    await vi.waitFor(() => expect(deps.stageScreenCapture).toHaveBeenCalledOnce());
    useScreenShareSetupStore.getState().open();
    await quickStartScreenShare(room());
    expect(useScreenShareSetupStore.getState()).toMatchObject({ isOpen: false, isStarting: true });
    expect(deps.preselectScreenSource).toHaveBeenCalledTimes(1);
    capture.resolve(stream);
    await first;
    expect(useScreenShareSetupStore.getState().isStarting).toBe(false);
  });

  it('disarms an abandoned preselection before releasing the lock', async () => {
    const selection = deferred<void>();
    deps.preselectScreenSource.mockReturnValueOnce(selection.promise);
    const start = quickStartScreenShare(room());
    await vi.waitFor(() => expect(deps.preselectScreenSource).toHaveBeenCalledWith(source.id, true));
    useVoiceStore.setState({ isLiveKitConnected: false });
    selection.resolve();
    await start;
    expect(deps.preselectScreenSource).toHaveBeenLastCalledWith(null);
    expect(deps.stageScreenCapture).not.toHaveBeenCalled();
    expect(useScreenShareSetupStore.getState()).toMatchObject({ isOpen: false, isStarting: false });
  });

  it('stops a late capture after disconnection, including when the call reconnects first', async () => {
    const capture = deferred<MediaStream>();
    deps.stageScreenCapture.mockReturnValue(capture.promise);
    const start = quickStartScreenShare(room());
    await vi.waitFor(() => expect(deps.stageScreenCapture).toHaveBeenCalledOnce());
    useVoiceStore.setState({ isLiveKitConnected: false });
    useVoiceStore.setState({ isLiveKitConnected: true });
    capture.resolve(stream);
    await start;
    expect(deps.publishScreenShare).not.toHaveBeenCalled();
    expect(deps.stopStagedCapture).toHaveBeenCalledWith(stream);
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
  });

  it('leaves concurrent preference edits intact after a failed capture', async () => {
    const capture = deferred<MediaStream>();
    deps.stageScreenCapture.mockReturnValue(capture.promise);
    const start = quickStartScreenShare(room());
    await vi.waitFor(() => expect(deps.stageScreenCapture).toHaveBeenCalledOnce());
    useVoiceStore.getState().setScreenShareConfig({ fps: 30 });
    capture.resolve(stream);
    deps.publishScreenShare.mockResolvedValueOnce(false);
    await start;
    expect(useVoiceStore.getState().screenShareConfig.fps).toBe(30);
    expect(useVoiceStore.getState().lastSuccessfulScreenShareConfig).toEqual(config);
    expect(useScreenShareSetupStore.getState().isOpen).toBe(true);
  });

  it('ignores a different room, an open setup, and an already running stream', async () => {
    deps.getActiveRoom.mockReturnValue({ ...deps.room });
    await quickStartScreenShare(room());
    deps.getActiveRoom.mockReturnValue(deps.room);
    useScreenShareSetupStore.setState({ isOpen: true });
    await quickStartScreenShare(room());
    useScreenShareSetupStore.setState({ isOpen: false });
    useVoiceStore.setState({ isScreenSharing: true });
    await quickStartScreenShare(room());
    expect(deps.stageScreenCapture).not.toHaveBeenCalled();
  });
});
