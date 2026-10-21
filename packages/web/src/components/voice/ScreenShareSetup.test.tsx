import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({
  stageScreenCapture: vi.fn(),
  selectScreenSource: vi.fn(),
  sourcesCallback: null as ((sources: ElectronScreenSource[]) => void) | null,
}));

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: vi.fn(() => null) }));
vi.mock('../../utils/voice', () => ({ broadcastVoiceStatus: vi.fn() }));
vi.mock('../../utils/screenShare', () => ({
  stageScreenCapture: deps.stageScreenCapture,
  applyStagedCaptureConfig: vi.fn(),
  stopStagedCapture: vi.fn(),
  publishScreenShare: vi.fn(),
  isScreenCaptureSupported: () => true,
  isCaptureCancellation: (err: unknown) => err instanceof DOMException && err.name === 'NotAllowedError',
  canAddScreenShareAudioLater: () => false,
}));
vi.mock('./StreamQualityControls', () => ({
  StreamQualityControls: () => null,
  StreamSummary: () => null,
  StreamHostSubtitle: () => null,
}));

import { ScreenShareSetup } from './ScreenShareSetup';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';
import { useVoiceStore } from '../../stores/voiceStore';
import i18n from '../../i18n';

beforeEach(() => {
  vi.clearAllMocks();
  deps.sourcesCallback = null;
  window.backspace = {
    getScreenSharePickerMode: vi.fn(async () => 'app'),
    onScreenShareSources: (callback: (sources: ElectronScreenSource[]) => void) => {
      deps.sourcesCallback = callback;
    },
    selectScreenSource: deps.selectScreenSource,
  } as unknown as BackspaceElectronAPI;
  useScreenShareSetupStore.setState({ isOpen: true, isStarting: false });
  useVoiceStore.setState({ isScreenSharing: false });
});

afterEach(() => {
  cleanup();
  delete window.backspace;
  useScreenShareSetupStore.setState({ isOpen: false, isStarting: false });
});

describe('legacy desktop source picker cancellation', () => {
  it('denies a late source list, settles capture, and allows setup to reopen', async () => {
    let denyCapture!: (reason: unknown) => void;
    deps.stageScreenCapture.mockReturnValue(new Promise<MediaStream>((_resolve, reject) => {
      denyCapture = reject;
    }));
    deps.selectScreenSource.mockImplementation((sourceId: string | null) => {
      if (sourceId === null) denyCapture(new DOMException('Picker cancelled', 'NotAllowedError'));
    });
    render(<ScreenShareSetup />);
    const choose = await screen.findByRole('button', { name: i18n.t('voice:screenPicker.choose') });
    await waitFor(() => expect(choose).toBeEnabled());
    fireEvent.click(choose);
    expect(deps.stageScreenCapture).toHaveBeenCalledOnce();
    expect(useScreenShareSetupStore.getState().isStarting).toBe(true);

    // Cancel happens before the main process sends its source-list event.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:actions.close'), exact: true }));
    expect(useScreenShareSetupStore.getState().isOpen).toBe(false);
    expect(deps.selectScreenSource).not.toHaveBeenCalled();

    await act(async () => { deps.sourcesCallback?.([]); });
    expect(deps.selectScreenSource).toHaveBeenCalledExactlyOnceWith(null);
    await waitFor(() => expect(useScreenShareSetupStore.getState().isStarting).toBe(false));
    expect(screen.queryByTestId('screen-share-setup')).not.toBeInTheDocument();

    act(() => { useScreenShareSetupStore.getState().open(); });
    expect(screen.getByTestId('screen-share-setup')).toBeInTheDocument();
    expect(deps.stageScreenCapture).toHaveBeenCalledOnce();
  });
});
