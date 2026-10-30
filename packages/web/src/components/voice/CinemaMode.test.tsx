import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CinemaMode } from './CinemaMode';
import { StreamTile } from './StreamTile';
import { useCinemaStore } from '../../stores/cinemaStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { enterCinemaMode } from '../../utils/cinemaMode';
import { POINTER_REVEAL_IDLE_MS } from '../../hooks/usePointerReveal';
import type { ParticipantInfo } from '../../hooks/useLiveKit';
import { installStreamZoom } from '../../../../desktop/src/streamZoom';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound: vi.fn() }) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => null, setStreamSubscription: vi.fn() }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({ useVoiceParticipantMeta: () => ({ displayName: 'Ada', avatar: null, user: null }) }));
const setQuality = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useStreamViewerQuality', () => ({ useStreamViewerQuality: () => ({ quality: 'auto', options: [{ value: 'original' }], setQuality }) }));
vi.mock('../../utils/voiceActions', () => ({ getSpaceEnforcementState: () => ({ isSpaceMuted: false, isSpaceDeafened: false }), toggleMuteFromControl: () => useVoiceStore.getState().toggleMic() }));

let fullscreen: Element | null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;
let attached: Set<HTMLVideoElement>;
let participant: ParticipantInfo;
let stop: ReturnType<typeof vi.fn>;
let removeZoom: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  fullscreen = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
  requestFullscreen = vi.fn().mockRejectedValue(new Error('No native fullscreen in this case'));
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: requestFullscreen });
  exitFullscreen = vi.fn(async () => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')); });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  attached = new Set(); stop = vi.fn(); setQuality.mockClear();
  const raw = Object.assign(new EventTarget(), { readyState: 'live', stop, getSettings: () => ({ height: 1440, frameRate: 60 }) }) as unknown as MediaStreamTrack;
  const track = {
    attach: vi.fn((video: HTMLVideoElement) => { attached.add(video); video.srcObject = {} as MediaStream; return video; }),
    detach: vi.fn((video: HTMLVideoElement) => { attached.delete(video); video.srcObject = null; return video; }),
  };
  participant = { identity: 'ada', userId: 'ada', username: 'Ada', isLocal: false, isScreenSharing: true, screenTrack: raw, lkScreenTrack: track } as unknown as ParticipantInfo;
  useCinemaStore.setState({ target: null, voiceVolume: 100 });
  useUIStore.setState({ voiceFullscreen: false });
  useVoiceStore.setState({ ...useVoiceStore.getInitialState(), isLiveKitConnected: true, voiceConnectionStatus: 'connected', participants: [participant], watchingStreams: new Set(['ada']), currentVoiceChannelId: 'channel' });
});
afterEach(() => {
  removeZoom?.(); removeZoom = undefined;
  cleanup();
  useCinemaStore.getState().close();
  useContextMenuStore.getState().close();
  vi.unstubAllGlobals(); vi.useRealTimers();
  delete (HTMLElement.prototype as Partial<HTMLElement>).requestFullscreen;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
});

function view() {
  return render(<><main data-testid="program"><StreamTile tile={{ kind: 'stream', key: 'ada:stream', participant, screenTrack: participant.screenTrack, screenAudioTrack: null, lkScreenTrack: participant.lkScreenTrack }} stats={null} /></main><CinemaMode /></>);
}
const enter = () => fireEvent.click(screen.getByRole('button', { name: 'Cinema mode' }));
const exit = () => fireEvent.click(screen.getByRole('button', { name: 'Exit cinema mode (Esc)' }));

describe('cinema viewing lifecycle', () => {
  it('reveals usable controls at 100%, after zoom and after resetting to 100%', () => {
    view(); enter();
    const player = screen.getByRole('dialog');
    const surface = player.querySelector<HTMLElement>('[data-cinema-surface]')!;
    const controls = screen.getByTestId('cinema-controls');
    vi.spyOn(player, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720,
    } as DOMRect);
    removeZoom = installStreamZoom();
    const zoom = player.querySelector('[data-backspace-stream-zoom]')!.shadowRoot!;
    const reset = zoom.querySelector<HTMLButtonElement>('[aria-label="Reset zoom"]')!;
    const plus = zoom.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
    expect(reset).toHaveTextContent('100%');
    expect(player.querySelector('video')).toHaveClass('z-0', 'pointer-events-none');
    expect(surface).toHaveClass('z-10');
    expect(controls).toHaveClass('z-20');
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(controls).toHaveClass('opacity-0');
    fireEvent.mouseMove(surface);
    expect(controls).toHaveClass('opacity-100');
    fireEvent.click(screen.getByRole('button', { name: 'Mute film' }));
    expect(useVoiceStore.getState().streamMutes.get('ada')).toBe(true);
    fireEvent.click(plus);
    expect(reset).toHaveTextContent('125%');
    fireEvent.click(reset);
    expect(reset).toHaveTextContent('100%');
    fireEvent.pointerMove(surface);
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(controls).toHaveClass('opacity-0');
    fireEvent.mouseMove(document, { clientX: 640, clientY: 650 });
    expect(controls).toHaveClass('opacity-100');
    fireEvent.change(screen.getByRole('slider', { name: 'Film volume' }), { target: { value: '65' } });
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(65);
  });

  it('includes injected zoom shadow buttons in the keyboard focus loop', () => {
    view(); enter();
    const player = screen.getByRole('dialog');
    const host = document.createElement('div');
    host.setAttribute('data-backspace-stream-zoom', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button disabled>Zoom out</button><button>Reset zoom</button><button>Zoom in</button>';
    player.querySelector('[data-cinema-zoom]')!.append(host);
    player.focus();
    expect(document.activeElement).toBe(player);
    fireEvent.keyDown(player, { key: 'Tab' });
    expect(host.isConnected).toBe(true);
    expect(shadow.activeElement).toBe(shadow.querySelectorAll('button')[1]);
    fireEvent.keyDown(shadow.querySelectorAll('button')[1]!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Exit cinema mode (Esc)' }));
  });

  it('restores the hidden bar with native mouse events over the video and keyboard Tab', () => {
    view(); enter();
    const player = screen.getByRole('dialog');
    const controls = screen.getByTestId('cinema-controls');
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(controls).toHaveClass('opacity-0');
    fireEvent.mouseMove(player.querySelector('video')!);
    expect(controls).toHaveClass('opacity-100');
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(controls).toHaveClass('opacity-0');
    fireEvent.keyDown(player, { key: 'Tab' });
    expect(controls).toHaveClass('opacity-100');
    expect(controls.contains(document.activeElement)).toBe(true);
  });

  it('opens from a stream button, uses one existing muted video attachment, and restores the regular view on exit', async () => {
    const { container } = view();
    expect(attached.size).toBe(1);
    const originalVideo = container.querySelector('video')!;
    enter(); await act(async () => {});
    const player = screen.getByRole('dialog', { name: 'Cinema mode' });
    expect(player).toHaveAttribute('data-cinema-player');
    expect(attached.size).toBe(1);
    expect(originalVideo.srcObject).toBeNull();
    expect(player.querySelector('video')!.muted).toBe(true);
    expect(container.inert).toBe(true);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(useVoiceStore.getState().watchingStreams.has('ada')).toBe(true);
    exit();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.inert).toBe(false);
    expect(originalVideo.srcObject).not.toBeNull();
    expect(attached.size).toBe(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it('opens the same local mode from the stream context menu', () => {
    const { container } = view();
    fireEvent.contextMenu(container.querySelector('[data-context-menu]')!);
    const item = useContextMenuStore.getState().menu?.items.find(item => item.key === 'cinema-mode');
    expect(item?.type).toBe('action');
    act(() => { if (item?.type === 'action') item.onClick(); });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('hides idle controls, reveals them with movement, pins an open quality menu, and changes the existing subscription preference', () => {
    view(); enter();
    const player = screen.getByRole('dialog');
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(screen.getByTestId('cinema-controls')).toHaveClass('opacity-0');
    fireEvent.pointerMove(player);
    expect(screen.getByTestId('cinema-controls')).toHaveClass('opacity-100');
    fireEvent.click(screen.getAllByRole('button', { name: 'Quality: Auto' }).find(button => player.contains(button))!);
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(screen.getByTestId('cinema-controls')).toHaveClass('opacity-100');
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Original/ }));
    expect(setQuality).toHaveBeenCalledWith('original');
    fireEvent.pointerMove(player);
    act(() => vi.advanceTimersByTime(POINTER_REVEAL_IDLE_MS + 1));
    expect(screen.getByTestId('cinema-controls')).toHaveClass('opacity-0');
  });

  it('keeps film controls independent from voice volume and microphone mute', () => {
    view(); enter();
    fireEvent.change(screen.getByRole('slider', { name: 'Film volume' }), { target: { value: '65' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Voice volume' }), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mute film' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute', exact: true }));
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(65);
    expect(useCinemaStore.getState().voiceVolume).toBe(20);
    expect(useVoiceStore.getState().streamMutes.get('ada')).toBe(true);
    expect(useVoiceStore.getState().isMuted).toBe(true);
  });

  it('shows and resets up to 400% film volume while keeping the voice range at 200%', () => {
    view(); enter();
    const film = screen.getByRole('slider', { name: 'Film volume' });
    expect(film).toHaveAttribute('max', '400');
    expect(screen.getByRole('slider', { name: 'Voice volume' })).toHaveAttribute('max', '200');
    fireEvent.change(film, { target: { value: '400' } });
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(400);
    expect(screen.getByText('400%')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reset stream volume to 100%' }));
    expect(film).toHaveValue('100');
    expect(useVoiceStore.getState().streamVolumes.get('ada')).toBe(100);
    expect(useCinemaStore.getState().voiceVolume).toBe(100);
  });

  it.each(['unwatch', 'stop', 'disconnect', 'channel-change'])('closes when %s invalidates the watched stream', action => {
    view(); enter();
    act(() => {
      if (action === 'unwatch') useVoiceStore.getState().unwatchStream('ada');
      if (action === 'stop') useVoiceStore.setState({ participants: [{ ...participant, isScreenSharing: false, screenTrack: null, lkScreenTrack: null }] });
      if (action === 'disconnect') useVoiceStore.setState({ isLiveKitConnected: false });
      if (action === 'channel-change') useVoiceStore.setState({ currentVoiceChannelId: 'other' });
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(stop).not.toHaveBeenCalled();
  });

  it('keeps the player open during capture replacement/reconnect and detaches only its old renderer', () => {
    view(); enter();
    const old = participant.lkScreenTrack!;
    act(() => useVoiceStore.setState({ voiceConnectionStatus: 'reconnecting', participants: [{ ...participant, screenTrack: null, lkScreenTrack: null }] }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the stream');
    act(() => useVoiceStore.setState({ voiceConnectionStatus: 'connected', participants: [participant] }));
    expect(attached.size).toBe(1);
    expect(old.detach).toHaveBeenCalled();
  });

  it('exits native fullscreen on Esc and never reopens the call fullscreen flag', () => {
    requestFullscreen.mockImplementation(() => {
      fullscreen = document.querySelector('[data-cinema-player]'); document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve();
    });
    view(); enter();
    expect(fullscreen).toBe(screen.getByRole('dialog'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fullscreen).toBeNull();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(useUIStore.getState().voiceFullscreen).toBe(false);
  });

  it('uses an existing fullscreen container, and native Esc closes cinema without requesting fullscreen again', () => {
    const existing = document.createElement('section'); document.body.append(existing); fullscreen = existing;
    useUIStore.setState({ voiceFullscreen: true });
    try {
      view(); enter();
      expect(existing).toContainElement(screen.getByRole('dialog'));
      expect(requestFullscreen).not.toHaveBeenCalled();
      act(() => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')); });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(useUIStore.getState().voiceFullscreen).toBe(false);
    } finally { existing.remove(); }
  });

  it('bounds renderer attachments and timers across 40 entries and never stops the remote track', () => {
    view(); const baseline = vi.getTimerCount();
    for (let index = 0; index < 40; index++) {
      enter(); expect(attached.size).toBe(1);
      exit(); expect(attached.size).toBe(1);
      act(() => vi.advanceTimersByTime(0));
      expect(vi.getTimerCount()).toBe(baseline);
    }
    expect(document.querySelectorAll('[data-cinema-player]')).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('ignores an entry request for an unwatched stream', () => {
    view(); act(() => useVoiceStore.getState().unwatchStream('ada'));
    act(() => enterCinemaMode('ada'));
    expect(useCinemaStore.getState().target).toBeNull();
    expect(requestFullscreen).not.toHaveBeenCalled();
  });
});
