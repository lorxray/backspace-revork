import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installStreamZoom } from '../../../../desktop/src/streamZoom';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound: vi.fn() }) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => null, setStreamSubscription: vi.fn() }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({
  useVoiceParticipantMeta: () => ({ displayName: 'Ada', avatar: null, user: null }),
}));
const setViewerQuality = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useStreamViewerQuality', () => ({
  useStreamViewerQuality: () => ({ quality: 'auto', options: [{ value: 'original' }], setQuality: setViewerQuality }),
}));

function tile(isLocal = false): StreamTileType {
  const screenTrack = {
    readyState: 'live',
    getSettings: () => ({ height: 1440, frameRate: 60 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    kind: 'stream',
    key: 'ada:stream',
    participant: {
      identity: 'ada', userId: 'ada', username: 'ada', homeUserId: null,
      isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true,
      isLocal, audioTrack: null, videoTrack: null, screenTrack, screenAudioTrack: null,
      lkVideoTrack: null, lkScreenTrack: null, cachedUser: null,
    },
    screenTrack,
    screenAudioTrack: null,
    lkScreenTrack: null,
  };
}

beforeEach(() => {
  setViewerQuality.mockClear();
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), watchingStreams: new Set(), connectionQualities: new Map() });
  useContextMenuStore.getState().close();
});

describe('viewer quality with the injected desktop zoom', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([125, 200, 400])('opens quality and selects a bitrate at zoom %i without leaving focus or resetting zoom', async percentage => {
    useVoiceStore.setState({ watchingStreams: new Set(['ada']) });
    const returnToGrid = vi.fn();
    const { container } = render(
      <div onClick={returnToGrid}>
        <StreamTile tile={tile()} stats={null} large />
        <button type="button">Grid</button>
      </div>,
    );
    const cleanup = installStreamZoom();
    try {
      const streamElement = container.querySelector('[data-context-menu]')!;
      const capturePointer = vi.fn();
      Object.defineProperty(streamElement, 'setPointerCapture', { value: capturePointer });
      const host = container.querySelector('[data-backspace-stream-zoom]')!;
      const plus = host.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
      for (let scale = 100; scale < percentage; scale += 25) plus.click();
      const video = container.querySelector('video')!;
      const transform = video.style.transform;
      expect(transform).toContain(`scale(${percentage / 100})`);
      const user = userEvent.setup();
      const trigger = screen.getByRole('button', { name: 'Quality: Auto' });
      // A real click on the nested icon traverses the native capture handlers
      // before reaching React's delegated button and portal-menu handlers.
      await user.click(trigger.querySelector('path')!);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('menuitemradio', { name: /Original/ }));
      expect(setViewerQuality).toHaveBeenCalledWith('original');
      expect(capturePointer).not.toHaveBeenCalled();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(video.style.transform).toBe(transform);
      expect(returnToGrid).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
});

describe('StreamTile viewer quality entry point', () => {
  it('shows quality for a watched remote stream', () => {
    useVoiceStore.setState({ watchingStreams: new Set(['ada']) });
    render(<StreamTile tile={tile()} stats={null} />);
    expect(screen.getByRole('button', { name: 'Quality: Auto' })).toBeVisible();
    expect(screen.getByTestId('stream-tile-caption')).toContainElement(screen.getByRole('button', { name: 'Quality: Auto' }));
  });

  it('keeps the entry point off a remote stream before it is watched', () => {
    render(<StreamTile tile={tile()} stats={null} />);
    expect(screen.queryByRole('button', { name: /Quality:/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch Stream' })).toBeInTheDocument();
  });

  it('keeps publisher quality settings separate from the viewer menu', () => {
    useVoiceStore.setState({ watchingStreams: new Set(['ada']) });
    render(<StreamTile tile={tile(true)} stats={null} />);
    expect(screen.queryByRole('button', { name: /Quality:/ })).not.toBeInTheDocument();
  });
});

describe('stream volume controls', () => {
  it('boosts a remote stream to 400% and offers a keyboard-accessible reset to 100%', async () => {
    const { container } = render(<StreamTile tile={tile()} stats={null} />);
    fireEvent.contextMenu(container.querySelector('[data-context-menu]')!);
    const item = useContextMenuStore.getState().menu?.items.find(entry => entry.key === 'stream-volume');
    if (item?.type !== 'custom') throw new Error('Stream volume controls missing');
    render(<>{item.render()}</>);
    const slider = screen.getByRole('slider', { name: 'Stream Volume' });
    expect(slider).toHaveAttribute('max', '400');
    fireEvent.change(slider, { target: { value: '400' } });
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(400);
    expect(screen.getByText('400%')).toBeVisible();
    const reset = screen.getByRole('button', { name: 'Reset stream volume to 100%' });
    reset.focus();
    expect(reset).toHaveFocus();
    await userEvent.setup().keyboard('{Enter}');
    expect(slider).toHaveValue('100');
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(100);
    act(() => useContextMenuStore.getState().close());
  });
});
