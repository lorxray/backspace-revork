import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@backspace/shared';

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../../utils/voice', async importOriginal => ({
  ...await importOriginal<typeof import('../../utils/voice')>(),
  joinVoiceChannel: vi.fn(),
}));
vi.mock('../voice/VoiceGrid', () => ({ VoiceGrid: () => <div data-testid="voice-grid" /> }));
vi.mock('../voice/VoiceControlBar', () => ({ VoiceControlBar: () => null }));
vi.mock('../voice/VoiceControls', () => ({ VoiceControls: () => null }));
vi.mock('../voice/VoiceChatPanel', () => ({
  VoiceChatPanel: ({ channelId }: { channelId: string }) => <div data-testid="channel-chat" data-channel={channelId} />,
}));

import { useSpaceStore, type TaggedSpace } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../../utils/permissions';
import { joinVoiceChannel } from '../../utils/voice';
import { ChannelSidebar } from './ChannelSidebar';
import { MainContent } from './MainContent';

const space = {
  id: 'space-1', name: 'Games', ownerId: 'owner', icon: null, banner: null, avatarColor: null,
  inviteCode: null, visibility: 'private', directoryListed: false, description: null,
  createdAt: 1, _instanceOrigin: '',
} satisfies TaggedSpace;

function voiceChannel(id: string, name: string, categoryId: string | null = null): Channel {
  return { id, spaceId: space.id, name, type: 'voice', topic: null, position: 0, categoryId, createdAt: 1 };
}

function LocationProbe() { return <span data-testid="location">{useLocation().pathname}</span>; }

function renderSidebar() {
  return render(<MemoryRouter initialEntries={['/channels/space-1/text-1']}>
    <ChannelSidebar /><MainContent /><LocationProbe />
  </MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(joinVoiceChannel).mockClear();
  useSpaceStore.getState().reset();
  useSpaceStore.setState({
    spaces: [space], currentSpaceId: space.id,
    channels: [voiceChannel('voice-1', 'Cube room'), voiceChannel('voice-2', 'Other room', 'games')],
    categories: [{ id: 'games', spaceId: space.id, name: 'Games category', position: 0, createdAt: 1 }],
    channelPermissions: new Map([['voice-1', permissionsToString(ALL_PERMISSIONS)], ['voice-2', permissionsToString(ALL_PERMISSIONS)]]),
    spacePermissions: new Map([[space.id, permissionsToString(ALL_PERMISSIONS)]]),
    channelToSpaceMap: new Map([['voice-1', space.id], ['voice-2', space.id]]),
  });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useChatStore.setState({ currentChannelId: 'text-1' });
  useUIStore.setState({ showDms: false, voiceChatOpen: false, voiceFullscreen: false });
  useVoiceStore.setState({
    currentVoiceChannelId: null, isLiveKitConnected: false, voiceConnectionStatus: 'disconnected',
    activeDmCall: null, participants: [], voiceUsers: new Map(), voiceChannelElapsedSeconds: new Map(),
  });
});

describe('voice channel chat shortcut', () => {
  it('opens the selected channel chat without joining its call', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat for Cube room' }));
    expect(useUIStore.getState().voiceChatOpen).toBe(true);
    expect(useChatStore.getState().currentChannelId).toBe('voice-1');
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/space-1/voice-1');
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-1');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBeNull();
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('keeps the active call when reading another voice channel chat', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-2', isLiveKitConnected: true, voiceConnectionStatus: 'connected' });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat for Cube room' }));
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-1');
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('voice-2');
    expect(useVoiceStore.getState().voiceConnectionStatus).toBe('connected');
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('opens categorized channels and stays open on repeated clicks', () => {
    renderSidebar();
    const shortcut = screen.getByRole('button', { name: 'Open chat for Other room' });
    fireEvent.click(shortcut);
    fireEvent.click(shortcut);
    expect(useUIStore.getState().voiceChatOpen).toBe(true);
    expect(screen.getByTestId('location')).toHaveTextContent('/channels/space-1/voice-2');
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-2');
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('allows reading the chat when CONNECT is denied', () => {
    useSpaceStore.setState({ channelPermissions: new Map([['voice-1', permissionsToString(
      PermissionBits.VIEW_CHANNEL | PermissionBits.READ_MESSAGE_HISTORY | PermissionBits.SEND_MESSAGES,
    )]]) });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat for Cube room' }));
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-1');
    expect(screen.getByRole('button', { name: 'Join Voice' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Join Voice' }));
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('does not expose chat shortcuts for hidden channels', () => {
    useSpaceStore.setState({ channelPermissions: new Map([['voice-1', '0'], ['voice-2', permissionsToString(ALL_PERMISSIONS)]]) });
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Open chat for Cube room' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open chat for Other room' })).toBeInTheDocument();
  });

  it('makes the chat visible when the call was fullscreen', () => {
    useVoiceStore.setState({ currentVoiceChannelId: 'voice-1', isLiveKitConnected: true, voiceConnectionStatus: 'connected' });
    useUIStore.setState({ voiceFullscreen: true });
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Open chat for Cube room' }));
    expect(useUIStore.getState().voiceFullscreen).toBe(false);
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-1');
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('opens from the keyboard without activating the join button', async () => {
    const keyboard = userEvent.setup();
    renderSidebar();
    act(() => screen.getByRole('button', { name: 'Open chat for Cube room' }).focus());
    await keyboard.keyboard('{Enter}');
    expect(screen.getByTestId('channel-chat')).toHaveAttribute('data-channel', 'voice-1');
    expect(joinVoiceChannel).not.toHaveBeenCalled();
  });

  it('keeps joining on a normal channel-row click', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Cube room' }));
    expect(joinVoiceChannel).toHaveBeenCalledWith('voice-1', undefined);
  });
});
