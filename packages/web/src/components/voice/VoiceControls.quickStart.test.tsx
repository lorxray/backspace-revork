import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { VoiceControls } from './VoiceControls';
import { VoiceControlBar } from './VoiceControlBar';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';
import { useUIStore } from '../../stores/uiStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { isElectron } from '../../platform/platform';
import { quickStartScreenShare } from '../../utils/quickStartScreenShare';
import { handleScreenShareAction } from '../../utils/voiceActions';
import { PermissionBits } from '../../utils/permissions';
import i18n from '../../i18n';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: vi.fn() }));
vi.mock('../../platform/platform', () => ({ isElectron: vi.fn(() => true) }));
vi.mock('../../utils/quickStartScreenShare', () => ({ quickStartScreenShare: vi.fn() }));
vi.mock('../../utils/voiceActions', () => ({
  handleMuteAction: vi.fn(),
  handleDeafenAction: vi.fn(),
  handleCameraAction: vi.fn(),
  handleScreenShareAction: vi.fn(),
  handleDisconnectAction: vi.fn(),
  reconnectVoice: vi.fn(),
}));
vi.mock('./ConnectionInfoPopover', () => ({ ConnectionInfoPopover: () => null }));
vi.mock('./ScreenShareSettingsPopover', () => ({
  ScreenShareSettingsPopover: ({ open, onStopSharing }: { open: boolean; onStopSharing: () => void }) => (
    open ? <button onClick={onStopSharing}>Stop sharing test action</button> : null
  ),
}));

const quickLabel = () => i18n.t('voice:controls.quickStartStream');
const setupLabel = () => i18n.t('voice:controls.shareScreen');
const startingLabel = () => i18n.t('voice:controls.startingStream');
const room = {} as NonNullable<ReturnType<typeof getActiveRoom>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isElectron).mockReturnValue(true);
  vi.mocked(getActiveRoom).mockReturnValue(room);
  useScreenShareSetupStore.setState({ isOpen: false, isStarting: false });
  useUIStore.setState({ voiceFullscreen: false, voiceChatOpen: false });
  useSpaceStore.setState({ channels: [], channelPermissions: new Map() });
  useVoiceStore.setState({
    currentVoiceChannelId: null,
    activeDmCall: { dmChannelId: 'dm-1', federatedCallId: null, callOrigin: null, livekit: null },
    isCameraOn: false,
    isScreenSharing: false,
    isLiveKitConnected: true,
    voiceConnectionStatus: 'connected',
    connectionError: null,
    spaceMutedUserIds: new Set(),
    spaceDeafenedUserIds: new Set(),
  });
});

afterEach(cleanup);

describe.each([
  ['sidebar', VoiceControls],
  ['call bar', VoiceControlBar],
] as const)('%s stream actions', (_name, Controls) => {
  it('offers a separate quick action without replacing the setup button', () => {
    render(<Controls />);

    const quick = screen.getByRole('button', { name: quickLabel() });
    expect(quick).toHaveAttribute('title', quickLabel());
    expect(quick).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: setupLabel() }));
    expect(handleScreenShareAction).toHaveBeenCalledTimes(1);
    expect(quickStartScreenShare).not.toHaveBeenCalled();

    fireEvent.click(quick);
    expect(quickStartScreenShare).toHaveBeenCalledExactlyOnceWith(room);
    expect(handleScreenShareAction).toHaveBeenCalledTimes(1);
  });

  it('limits the shortcut to desktop clients', () => {
    vi.mocked(isElectron).mockReturnValue(false);
    render(<Controls />);

    expect(screen.queryByRole('button', { name: quickLabel() })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: setupLabel() })).toBeEnabled();
  });

  it('shows progress and blocks both start actions while publishing', () => {
    useScreenShareSetupStore.setState({ isStarting: true });
    render(<Controls />);

    const quick = screen.getByRole('button', { name: startingLabel() });
    const setup = screen.getByRole('button', { name: setupLabel() });
    expect(quick).toHaveAttribute('aria-busy', 'true');
    expect(quick).toBeDisabled();
    expect(setup).toBeDisabled();
    fireEvent.click(quick);
    fireEvent.click(setup);
    expect(quickStartScreenShare).not.toHaveBeenCalled();
    expect(handleScreenShareAction).not.toHaveBeenCalled();
  });

  it('does not start a competing flow while the source/settings screen is open', () => {
    useScreenShareSetupStore.setState({ isOpen: true });
    render(<Controls />);

    expect(screen.getByRole('button', { name: quickLabel() })).toBeDisabled();
    expect(screen.getByRole('button', { name: setupLabel() })).toBeDisabled();
  });

  it.each([
    { isLiveKitConnected: false },
    { voiceConnectionStatus: 'connecting' as const },
    { voiceConnectionStatus: 'reconnecting' as const },
    { connectionError: 'network_disconnect' },
  ])('blocks startup when the connection is unavailable: %j', (connectionState) => {
    render(<Controls />);
    act(() => useVoiceStore.setState(connectionState));

    const quick = screen.getByRole('button', { name: quickLabel() });
    const setup = screen.getByRole('button', { name: setupLabel() });
    expect(quick).toBeDisabled();
    expect(setup).toBeDisabled();
    fireEvent.click(quick);
    fireEvent.click(setup);
    expect(quickStartScreenShare).not.toHaveBeenCalled();
    expect(handleScreenShareAction).not.toHaveBeenCalled();
  });

  it('does not offer either stream action without stream permission', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-1', activeDmCall: null });
    useSpaceStore.setState({ channelPermissions: new Map([['voice-1', PermissionBits.SPEAK.toString()]]) });
    render(<Controls />);

    expect(screen.queryByRole('button', { name: quickLabel() })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: setupLabel() })).not.toBeInTheDocument();
  });

  it('preserves the live settings/stop menu and restores quick start when sharing ends', () => {
    useVoiceStore.setState({ isScreenSharing: true });
    render(<Controls />);

    expect(screen.queryByRole('button', { name: quickLabel() })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:controls.shareOptions') }));
    expect(screen.getByRole('button', { name: 'Stop sharing test action' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing test action' }));
    expect(handleScreenShareAction).toHaveBeenCalledTimes(1);

    // Also cover an OS/track end while the options popover is still open.
    fireEvent.click(screen.getByRole('button', { name: i18n.t('voice:controls.shareOptions') }));
    act(() => useVoiceStore.setState({ isScreenSharing: false }));
    expect(screen.getByRole('button', { name: quickLabel() })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Stop sharing test action' })).not.toBeInTheDocument();
    act(() => useVoiceStore.setState({ isScreenSharing: true }));
    expect(screen.getByRole('button', { name: i18n.t('voice:controls.shareOptions') })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the live stop action available when the connection drops', () => {
    useVoiceStore.setState({
      isScreenSharing: true,
      isLiveKitConnected: false,
      voiceConnectionStatus: 'reconnecting',
      connectionError: 'network_disconnect',
    });
    render(<Controls />);

    const options = screen.getByRole('button', { name: i18n.t('voice:controls.shareOptions') });
    expect(options).toBeEnabled();
    fireEvent.click(options);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing test action' }));
    expect(handleScreenShareAction).toHaveBeenCalledTimes(1);
  });

  it('ignores the shortcut if the room disappeared before the click', () => {
    render(<Controls />);
    vi.mocked(getActiveRoom).mockReturnValue(null);

    fireEvent.click(screen.getByRole('button', { name: quickLabel() }));
    expect(quickStartScreenShare).not.toHaveBeenCalled();
  });
});
