// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installStreamZoom } from './streamZoom';

const cleanups: Array<() => void> = [];

function install(): () => void {
  const cleanup = installStreamZoom();
  cleanups.push(cleanup);
  return cleanup;
}

function stream({ focused = true, caption = true } = {}) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<div data-context-menu class="relative overflow-hidden">
    <video class="w-full h-full object-contain bg-black" autoplay muted playsinline></video>
    ${caption ? '<div data-testid="stream-tile-caption">Ada</div>' : ''}
  </div>${focused ? '<button title="Back to grid">Grid</button>' : ''}`;
  const tile = wrapper.firstElementChild as HTMLDivElement;
  const video = tile.querySelector('video')!;
  const source = { id: 'screen-share' } as unknown as MediaStream;
  const capturedPointers = new Set<number>();
  Object.defineProperties(video, {
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
    srcObject: { configurable: true, writable: true, value: source },
    setPointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.add(id)) },
    hasPointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.has(id)) },
    releasePointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.delete(id)) },
  });
  Object.defineProperties(tile, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
    setPointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.add(id)) },
    hasPointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.has(id)) },
    releasePointerCapture: { configurable: true, value: vi.fn((id: number) => capturedPointers.delete(id)) },
  });
  const rect = { x: 100, y: 50, left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, toJSON: () => ({}) };
  vi.spyOn(tile, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(video, 'getBoundingClientRect').mockReturnValue(rect);
  document.body.append(wrapper);
  return { wrapper, tile, video, source };
}

function toolbar(tile: HTMLElement): HTMLElement {
  const element = tile.querySelector<HTMLElement>('[data-backspace-stream-zoom]');
  expect(element, 'focused watched streams have zoom controls').not.toBeNull();
  return element!;
}

function control(tile: HTMLElement, name: string): HTMLButtonElement {
  const element = toolbar(tile).shadowRoot?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  expect(element, `zoom control: ${name}`).not.toBeNull();
  return element!;
}

function percentage(tile: HTMLElement): number {
  return Number(control(tile, 'Reset zoom').textContent?.replace(/[^\d]/g, ''));
}

function wheel(target: HTMLElement, deltaY: number, x = 500, y = 350): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, clientX: x, clientY: y });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: EventTarget, type: string, x: number, y: number, button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'isPrimary', { value: true });
  target.dispatchEvent(event);
}

function translation(video: HTMLVideoElement): { x: number; y: number } {
  const match = video.style.transform.match(/translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/);
  expect(match, 'zoom transform translates the original video').not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]) };
}

async function mutations(): Promise<void> {
  // Let MutationObserver and its scheduled refresh observe a React-style render.
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  });
  document.body.replaceChildren();
  document.documentElement.lang = 'en';
  document.documentElement.removeAttribute('style');
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bundled desktop stream zoom', () => {
  it('adds controls only to a focused watched stream, keeping its media element and source intact', () => {
    const focused = stream();
    const grid = stream({ focused: false });
    const camera = stream({ caption: false });
    install();

    expect(percentage(focused.tile)).toBe(100);
    expect(grid.tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(camera.tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(focused.video.parentElement).toBe(focused.tile);
    expect(focused.video.srcObject).toBe(focused.source);
  });

  it('can run after serialization without relying on module imports or closures', () => {
    const { tile } = stream();
    const serializedInstall = new Function(`return (${installStreamZoom.toString()})();`);
    cleanups.push(serializedInstall() as () => void);
    control(tile, 'Zoom in').click();
    expect(percentage(tile)).toBe(125);
  });

  it('increments with buttons, clamps at 100–400%, and resets zoom', () => {
    const { tile, video } = stream();
    install();
    expect(control(tile, 'Zoom out').disabled).toBe(true);
    control(tile, 'Zoom in').click();
    expect(percentage(tile)).toBe(125);
    for (let index = 0; index < 20; index++) control(tile, 'Zoom in').click();
    expect(percentage(tile)).toBe(400);
    expect(control(tile, 'Zoom in').disabled).toBe(true);
    control(tile, 'Reset zoom').click();
    expect(percentage(tile)).toBe(100);
    expect(translation(video)).toEqual({ x: 0, y: 0 });
    for (let index = 0; index < 20; index++) control(tile, 'Zoom out').click();
    expect(percentage(tile)).toBe(100);
  });

  it('zooms towards the wheel cursor and consumes scrolling only over the stream', () => {
    const { tile, video } = stream();
    install();
    const event = wheel(video, -240, 700, 350);
    expect(event.defaultPrevented).toBe(true);
    expect(percentage(tile)).toBeGreaterThan(100);
    expect(translation(video).x).toBeLessThan(0);
    expect(translation(video).y).toBe(0);
    const outside = wheel(document.body, -240);
    expect(outside.defaultPrevented).toBe(false);
  });

  it('does not let control clicks collapse the focused stream', () => {
    const { wrapper, tile } = stream();
    const returnToGrid = vi.fn();
    wrapper.addEventListener('click', returnToGrid);
    install();
    control(tile, 'Zoom in').click();
    control(tile, 'Zoom out').click();
    control(tile, 'Reset zoom').click();
    expect(returnToGrid).not.toHaveBeenCalled();
  });

  it('pans a zoomed stream and clamps the letterboxed content to viewport edges', () => {
    const { tile, video } = stream();
    install();
    for (let index = 0; index < 4; index++) control(tile, 'Zoom in').click();
    pointer(video, 'pointerdown', 500, 350);
    pointer(tile, 'pointermove', 5000, 5000);
    pointer(tile, 'pointerup', 5000, 5000);
    expect(percentage(tile)).toBe(200);
    // 1920×1080 fits as 800×450: at 200%, overflow is 800×300.
    expect(translation(video)).toEqual({ x: 400, y: 150 });
    pointer(video, 'pointerdown', 500, 350);
    pointer(tile, 'pointermove', -5000, -5000);
    pointer(tile, 'pointerup', -5000, -5000);
    expect(translation(video)).toEqual({ x: -400, y: -150 });
  });

  it('blocks the click after a drag while still allowing an ordinary 100% click to return to grid', () => {
    const { wrapper, tile, video } = stream();
    const returnToGrid = vi.fn();
    wrapper.addEventListener('click', returnToGrid);
    install();
    control(tile, 'Zoom in').click();
    pointer(video, 'pointerdown', 500, 350);
    pointer(tile, 'pointermove', 550, 350);
    pointer(tile, 'pointerup', 550, 350);
    video.click();
    expect(returnToGrid).not.toHaveBeenCalled();
    control(tile, 'Reset zoom').click();
    video.click();
    expect(returnToGrid).toHaveBeenCalledOnce();
  });

  it('uses interface scaling when translating screen pointer coordinates', () => {
    document.documentElement.style.setProperty('--interface-scale', '2');
    const { tile, video } = stream();
    install();
    for (let index = 0; index < 4; index++) control(tile, 'Zoom in').click();
    pointer(video, 'pointerdown', 500, 350);
    pointer(tile, 'pointermove', 600, 390);
    pointer(tile, 'pointerup', 600, 390);
    expect(translation(video)).toEqual({ x: 50, y: 20 });
  });

  it('installs once even if the desktop preload is initialized twice', () => {
    const { tile } = stream();
    install();
    install();
    expect(tile.querySelectorAll('[data-backspace-stream-zoom]')).toHaveLength(1);
    control(tile, 'Zoom in').click();
    expect(percentage(tile)).toBe(125);
  });

  it('watches for streams mounted after the page finishes loading', async () => {
    install();
    const { tile } = stream();
    await mutations();
    expect(percentage(tile)).toBe(100);
  });

  it('restores original styles and removes all behavior on cleanup', async () => {
    const { tile, video, source } = stream();
    video.style.transform = 'rotate(0deg)';
    video.style.cursor = 'auto';
    tile.style.overflow = 'hidden';
    const videoStyles = video.getAttribute('style');
    const tileStyles = tile.getAttribute('style');
    const stop = install();
    control(tile, 'Zoom in').click();
    stop();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(video.getAttribute('style')).toBe(videoStyles);
    expect(tile.getAttribute('style')).toBe(tileStyles);
    expect(video.srcObject).toBe(source);
    expect(wheel(video, -240).defaultPrevented).toBe(false);
    document.body.append(document.createElement('div'));
    await mutations();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
  });

  it('does not restore stale React classes after cleaning up', () => {
    const { video } = stream();
    const stop = install();
    video.className = 'new-react-video-class';
    stop();
    expect(video.className).toBe('new-react-video-class');
  });

  it('keeps zoom when React updates classes or replaces inline styles', async () => {
    const { tile, video } = stream();
    install();
    control(tile, 'Zoom in').click();
    video.className = 'updated-video-class';
    video.removeAttribute('style');
    await mutations();
    expect(percentage(tile)).toBe(125);
    expect(video.style.transform).toContain('scale(1.25)');
    expect(video.className).toBe('updated-video-class');
  });

  it('updates control labels when the web client changes its language', async () => {
    const { tile } = stream();
    install();
    document.documentElement.lang = 'ru';
    await mutations();
    expect(toolbar(tile).getAttribute('aria-label')).toBe('Масштаб трансляции');
    control(tile, 'Приблизить').click();
    expect(control(tile, 'Сбросить масштаб').textContent).toMatch(/125\s*%/);
    document.documentElement.lang = 'unsupported';
    await mutations();
    expect(percentage(tile)).toBe(125);
    expect(toolbar(tile).getAttribute('aria-label')).toBe('Stream zoom');
  });

  it('moves controls above the call panel when the focused voice view enters fullscreen', async () => {
    const { wrapper, tile } = stream();
    wrapper.classList.add('group/voice');
    install();
    expect(toolbar(tile).style.bottom).toBe('48px');
    wrapper.classList.add('h-screen');
    await mutations();
    expect(toolbar(tile).style.bottom).toBe('96px');
    wrapper.classList.remove('h-screen');
    await mutations();
    expect(toolbar(tile).style.bottom).toBe('48px');
  });

  it('preserves the current zoom across native fullscreen changes', () => {
    const { wrapper, tile } = stream();
    const original = Object.getOwnPropertyDescriptor(document, 'fullscreenElement');
    let fullscreen: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen });
    try {
      install();
      control(tile, 'Zoom in').click();
      fullscreen = wrapper;
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(toolbar(tile).style.bottom).toBe('96px');
      expect(percentage(tile)).toBe(125);
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(toolbar(tile).style.bottom).toBe('48px');
      expect(percentage(tile)).toBe(125);
    } finally {
      if (original) Object.defineProperty(document, 'fullscreenElement', original);
      else delete (document as unknown as Record<string, unknown>).fullscreenElement;
    }
  });

  it('restores controls removed by a React render without moving the attached media element', async () => {
    const { tile, video, source } = stream();
    install();
    control(tile, 'Zoom in').click();
    const host = toolbar(tile);
    const mediaMutations: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) mediaMutations.push(...record.addedNodes, ...record.removedNodes);
    });
    observer.observe(tile, { childList: true });
    try {
      host.remove();
      await mutations();
      expect(toolbar(tile)).toBe(host);
      expect(percentage(tile)).toBe(125);
      expect(video.parentElement).toBe(tile);
      expect(video.srcObject).toBe(source);
      expect(mediaMutations).not.toContain(video);
    } finally {
      observer.disconnect();
    }
  });

  it('resets when the track changes but preserves zoom for same-source metadata', () => {
    const { tile, video } = stream();
    install();
    control(tile, 'Zoom in').click();
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1280 },
      videoHeight: { configurable: true, value: 720 },
    });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(percentage(tile)).toBe(125);
    video.dispatchEvent(new Event('resize'));
    expect(percentage(tile)).toBe(125);
    video.srcObject = { id: 'replacement-share' } as unknown as MediaStream;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(percentage(tile)).toBe(100);
    expect(translation(video)).toEqual({ x: 0, y: 0 });
  });

  it('resets when the media source is emptied', () => {
    const { tile, video } = stream();
    install();
    control(tile, 'Zoom in').click();
    video.srcObject = null;
    video.dispatchEvent(new Event('emptied'));
    expect(percentage(tile)).toBe(100);
  });

  it('notices a replaced video track even when the MediaStream object stays the same', async () => {
    vi.useFakeTimers();
    const { tile, source } = stream();
    let track = { id: 'original-track', readyState: 'live' };
    Object.defineProperty(source, 'getVideoTracks', { value: () => [track] });
    install();
    control(tile, 'Zoom in').click();
    track = { id: 'replacement-track', readyState: 'live' };
    await vi.advanceTimersByTimeAsync(300);
    expect(percentage(tile)).toBe(100);
  });

  it('resets after a track ends or srcObject changes without emitting media events', async () => {
    vi.useFakeTimers();
    const { tile, video, source } = stream();
    const track = { id: 'screen-track', readyState: 'live' };
    Object.defineProperty(source, 'getVideoTracks', { value: () => [track] });
    install();
    control(tile, 'Zoom in').click();
    track.readyState = 'ended';
    await vi.advanceTimersByTimeAsync(300);
    expect(percentage(tile)).toBe(100);
    control(tile, 'Zoom in').click();
    video.srcObject = { id: 'replacement-share' } as unknown as MediaStream;
    await vi.advanceTimersByTimeAsync(300);
    expect(percentage(tile)).toBe(100);
    expect(translation(video)).toEqual({ x: 0, y: 0 });
  });

  it('cleans up when focus is removed and enables zoom again after refocusing', async () => {
    const { wrapper, tile, video } = stream();
    install();
    control(tile, 'Zoom in').click();
    wrapper.querySelector(':scope > button')!.remove();
    await mutations();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(video.style.transform).toBe('');
    wrapper.append(document.createElement('button'));
    await mutations();
    expect(percentage(tile)).toBe(100);
  });

  it('cleans up when React removes a video and attaches to its replacement', async () => {
    const { tile, video, source } = stream();
    install();
    control(tile, 'Zoom in').click();
    video.remove();
    await mutations();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(video.style.transform).toBe('');
    const replacement = document.createElement('video');
    Object.defineProperty(replacement, 'srcObject', { configurable: true, writable: true, value: source });
    tile.prepend(replacement);
    await mutations();
    expect(percentage(tile)).toBe(100);
    expect(replacement.parentElement).toBe(tile);
    expect(replacement.srcObject).toBe(source);
  });

  it('releases detached tiles and does not attach to a stream after its caption disappears', async () => {
    const { wrapper, tile, video } = stream();
    install();
    control(tile, 'Zoom in').click();
    wrapper.remove();
    await mutations();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    expect(video.style.transform).toBe('');
    document.body.append(wrapper);
    tile.querySelector('[data-testid="stream-tile-caption"]')!.remove();
    await mutations();
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
  });
});
