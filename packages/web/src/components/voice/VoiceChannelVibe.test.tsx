import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceChannelVibe } from './VoiceChannelVibe';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { readRecentVoiceVibes, topicWithVoiceChannelVibe } from '../../utils/voiceChannelVibe';
import type { Channel } from '@backspace/shared';

const GIF = 'https://media.tenor.com/example/cat.gif';
const originalUpdate = useSpaceStore.getState().updateChannel;

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({}) },
}));

vi.mock('../chat/GifPicker', () => ({
  GifPicker: ({ onGifSelect }: { onGifSelect: (url: string) => void }) => (
    <button onClick={() => onGifSelect(GIF)}>Pick a cat</button>
  ),
}));

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({ gifEnabled: false });
  useUIStore.setState({ isMobile: false });
  useSpaceStore.setState({ channels: [{ id: 'voice-1', type: 'voice', topic: null } as Channel] });
});

afterEach(() => {
  useSpaceStore.setState({ updateChannel: originalUpdate });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(canManage = true, topic: string | null = null) {
  useSpaceStore.setState({ channels: [{ id: 'voice-1', type: 'voice', topic } as Channel] });
  const update = vi.fn(async (id: string, data: { topic?: string | null }) => {
    const channel = { ...useSpaceStore.getState().channels[0]!, ...data };
    useSpaceStore.setState({ channels: [channel] });
    return channel;
  });
  useSpaceStore.setState({ updateChannel: update });
  function ChannelVibe() {
    const currentTopic = useSpaceStore((state) => state.channels[0]?.topic ?? null);
    return <VoiceChannelVibe channelId="voice-1" topic={currentTopic} canManage={canManage} />;
  }
  render(<ChannelVibe />);
  return update;
}

function enterImage() {
  fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
  fireEvent.change(screen.getByLabelText('GIF or image link'), { target: { value: GIF } });
  fireEvent.load(screen.getByAltText('Vibe preview'));
}

describe('voice channel vibe', () => {
  it('keeps a slow saved GIF mounted and lets a transient error recover automatically', async () => {
    vi.useFakeTimers();
    const update = setup(false, topicWithVoiceChannelVibe(null, GIF));
    const img = screen.getByAltText('Voice channel vibe');
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(img).toHaveAttribute('src', GIF);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.error(img);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the image. Click to retry.');
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    const retry = screen.getByAltText('Voice channel vibe');
    expect(retry).toHaveAttribute('src', GIF);
    fireEvent.load(retry);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('allows retrying a failed saved GIF without replacing its channel topic', async () => {
    vi.useFakeTimers();
    const update = setup(false, topicWithVoiceChannelVibe(null, GIF));
    fireEvent.error(screen.getByAltText('Voice channel vibe'));
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    fireEvent.error(screen.getByAltText('Voice channel vibe'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    fireEvent.click(screen.getByRole('alert'));
    expect(screen.getByAltText('Voice channel vibe')).toHaveAttribute('src', GIF);
    fireEvent.load(screen.getByAltText('Voice channel vibe'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('lets the editor preview recover on retry and enables saving only after a successful load', async () => {
    vi.useFakeTimers();
    const update = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
    fireEvent.change(screen.getByLabelText('GIF or image link'), { target: { value: GIF } });
    fireEvent.error(screen.getByAltText('Vibe preview'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByAltText('Vibe preview')).toHaveAttribute('src', GIF);
    expect(screen.getByAltText('Vibe preview')).toBeVisible();
    fireEvent.load(screen.getByAltText('Vibe preview'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('renders the saved image without management controls for a channel participant', () => {
    setup(false, topicWithVoiceChannelVibe(null, GIF));
    expect(screen.getByAltText('Voice channel vibe')).toHaveAttribute('src', GIF);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('does not offer setting an image to viewers without permission', () => {
    setup(false);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('saves through the existing channel update and restores the previous topic on removal', async () => {
    const update = setup(true, 'Original description');
    enterImage();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByAltText('Voice channel vibe')).toHaveAttribute('src', GIF));
    expect(update).toHaveBeenCalledWith('voice-1', { topic: topicWithVoiceChannelVibe('Original description', GIF) });
    expect(readRecentVoiceVibes()).toEqual([GIF]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove vibe' }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith('voice-1', { topic: 'Original description' }));
    expect(screen.queryByAltText('Voice channel vibe')).not.toBeInTheDocument();
  });

  it('uses the latest channel data if it changes while the editor is open', async () => {
    const update = setup();
    enterImage();
    act(() => useSpaceStore.setState({ channels: [{ id: 'voice-1', type: 'voice', topic: 'Updated elsewhere' } as Channel] }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('voice-1', { topic: topicWithVoiceChannelVibe('Updated elsewhere', GIF) }));
  });

  it('requires a successfully loaded image and refuses a failed preview', () => {
    const update = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
    fireEvent.change(screen.getByLabelText('GIF or image link'), { target: { value: GIF } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.error(screen.getByAltText('Vibe preview'));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the image');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it('offers the existing GIF catalog when enabled, then previews and saves the selection', async () => {
    useSettingsStore.setState({ gifEnabled: true });
    const update = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Choose GIF' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick a cat' }));
    expect(screen.getByLabelText('GIF or image link')).toHaveValue(GIF);
    fireEvent.load(screen.getByAltText('Vibe preview'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
  });

  it('explains the existing server setting when GIF search is disabled', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Choose GIF' }));
    expect(screen.getByText(/GIF search is not configured/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Paste a link' }));
    expect(screen.getByLabelText('GIF or image link')).toBeInTheDocument();
  });

  it('keeps the editor and previous vibe after a server rejection, without adding recents', async () => {
    const update = setup(true, topicWithVoiceChannelVibe(null, 'https://example.com/old.gif'));
    update.mockRejectedValue(new Error('Server refused the change'));
    fireEvent.click(screen.getByRole('button', { name: 'Change vibe' }));
    fireEvent.change(screen.getByLabelText('GIF or image link'), { target: { value: GIF } });
    fireEvent.load(screen.getByAltText('Vibe preview'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Server refused the change'));
    expect(screen.getByAltText('Voice channel vibe')).toHaveAttribute('src', 'https://example.com/old.gif');
    expect(readRecentVoiceVibes()).toEqual([]);
  });

  it('prevents duplicate submissions while saving', async () => {
    const update = setup();
    let resolve!: (channel: Channel) => void;
    update.mockImplementation(() => new Promise((done) => { resolve = done; }));
    enterImage();
    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(update).toHaveBeenCalledOnce();
    await act(async () => resolve({ id: 'voice-1', type: 'voice', topic: null } as Channel));
  });

  it('closes the editor when management permission is revoked', () => {
    const { rerender } = render(<VoiceChannelVibe channelId="voice-1" topic={null} canManage />);
    fireEvent.click(screen.getByRole('button', { name: 'Set the vibe' }));
    expect(screen.getByLabelText('GIF or image link')).toBeInTheDocument();
    rerender(<VoiceChannelVibe channelId="voice-1" topic={null} canManage={false} />);
    expect(screen.queryByLabelText('GIF or image link')).not.toBeInTheDocument();
  });
});
