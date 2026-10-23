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

function cinemaStream() {
  const result = stream({ focused: false, caption: false });
  result.tile.removeAttribute('data-context-menu');
  result.tile.setAttribute('data-cinema-player', '');
  const controls = document.createElement('div');
  controls.setAttribute('data-voice-chrome', '');
  controls.innerHTML = '<div data-cinema-zoom></div><input type="range" aria-label="Film volume"><button>Mute film</button>';
  result.tile.append(controls);
  return { ...result, controls, mount: controls.querySelector<HTMLElement>('[data-cinema-zoom]')! };
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

function pointer(target: EventTarget, type: string, x: number, y: number, button = 0): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'isPrimary', { value: true });
  target.dispatchEvent(event);
  return event;
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
  it('adds the same zoom controls to the cinema toolbar and pans the existing video', () => {
    const { tile, video, source, mount } = cinemaStream();
    install();
    expect(toolbar(tile).parentElement).toBe(mount);
    expect(toolbar(tile).style.position).toBe('relative');
    expect(toolbar(tile).hasAttribute('data-voice-chrome')).toBe(true);
    for (let index = 0; index < 4; index++) control(tile, 'Zoom in').click();
    expect(percentage(tile)).toBe(200);
    pointer(video, 'pointerdown', 500, 350);
    pointer(tile, 'pointermove', 650, 420);
    pointer(tile, 'pointerup', 650, 420);
    expect(translation(video)).toEqual({ x: 150, y: 70 });
    expect(video.srcObject).toBe(source);
    expect(video.parentElement).toBe(tile);
    control(tile, 'Reset zoom').click();
    expect(percentage(tile)).toBe(100);
    expect(translation(video)).toEqual({ x: 0, y: 0 });
    expect(wheel(video, -100).defaultPrevented).toBe(true);
    expect(percentage(tile)).toBeGreaterThan(100);
  });

  it('lets cinema own toolbar visibility and keeps volume controls and toolbar padding interactive', async () => {
    vi.useFakeTimers();
    const { tile, video, controls } = cinemaStream();
    install();
    control(tile, 'Zoom in').click();
    const before = video.style.transform;
    for (const target of [controls, controls.querySelector('input')!, controls.querySelector('button')!]) {
      expect(wheel(target, -100).defaultPrevented).toBe(false);
      expect(pointer(target, 'pointerdown', 500, 350).defaultPrevented).toBe(false);
    }
    expect(tile.setPointerCapture).not.toHaveBeenCalled();
    expect(video.style.transform).toBe(before);
    await vi.advanceTimersByTimeAsync(3000);
    expect(toolbar(tile).style.opacity).not.toBe('0');
    tile.classList.add('cursor-none');
    await vi.advanceTimersByTimeAsync(0);
    expect(tile.style.cursor).toBe('');
    tile.classList.remove('cursor-none');
    await vi.advanceTimersByTimeAsync(0);
    expect(tile.style.cursor).toBe('grab');
  });

  it('transfers zoom behavior between the regular viewer and cinema without keeping hidden controllers', async () => {
    const regular = stream();
    install();
    control(regular.tile, 'Zoom in').click();
    const cinema = cinemaStream();
    await mutations();
    expect(regular.tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
    control(cinema.tile, 'Zoom in').click();
    expect(percentage(cinema.tile)).toBe(125);
    cinema.wrapper.remove();
    await mutations();
    expect(percentage(regular.tile)).toBe(100);
    expect(wheel(cinema.video, -100).defaultPrevented).toBe(false);
  });

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

  it('hides idle controls after wheel zoom even when the pointer stays over the video', async () => {
    vi.useFakeTimers();
    const { tile, video } = stream();
    install();
    wheel(video, -240);
    const host = toolbar(tile);
    const zoomedTransform = video.style.transform;
    expect(host.style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(1999);
    expect(host.style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(1);
    expect(host.style.opacity).toBe('0');
    expect(host.style.pointerEvents).toBe('none');
    expect(percentage(tile)).toBeGreaterThan(100);
    expect(video.style.transform).toBe(zoomedTransform);

    pointer(video, 'pointermove', 510, 350);
    expect(host.style.opacity).toBe('1');
    expect(host.style.pointerEvents).not.toBe('none');
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.style.opacity).toBe('0');
  });

  it('restarts the idle countdown for another zoom and for reset', async () => {
    vi.useFakeTimers();
    const { tile, video } = stream();
    install();
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');

    wheel(video, -240);
    expect(toolbar(tile).style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(1500);
    wheel(video, -240);
    await vi.advanceTimersByTimeAsync(1500);
    expect(toolbar(tile).style.opacity).toBe('1');

    control(tile, 'Reset zoom').click();
    expect(percentage(tile)).toBe(100);
    await vi.advanceTimersByTimeAsync(1999);
    expect(toolbar(tile).style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(1);
    expect(toolbar(tile).style.opacity).toBe('0');
  });

  it('keeps hidden controls hidden when React or fullscreen refreshes the stream', async () => {
    vi.useFakeTimers();
    const { wrapper, tile, video } = stream();
    wrapper.classList.add('group/voice');
    install();
    control(tile, 'Zoom in').click();
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');

    video.className = 'updated-video-class';
    video.removeAttribute('style');
    wrapper.classList.add('h-screen');
    await vi.advanceTimersByTimeAsync(0);
    document.dispatchEvent(new Event('fullscreenchange'));
    window.dispatchEvent(new Event('resize'));
    expect(toolbar(tile).style.bottom).toBe('96px');
    expect(toolbar(tile).style.opacity).toBe('0');
    expect(percentage(tile)).toBe(125);
    expect(video.style.transform).toContain('scale(1.25)');
  });

  it('holds controls visible while the pointer rests on them and hides after leaving', async () => {
    vi.useFakeTimers();
    const { tile } = stream();
    install();
    const host = toolbar(tile);
    host.dispatchEvent(new MouseEvent('pointerenter', { composed: true }));
    control(tile, 'Zoom in').dispatchEvent(new MouseEvent('pointermove', { bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(host.style.opacity).toBe('1');

    host.dispatchEvent(new MouseEvent('pointerleave', { composed: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(host.style.opacity).toBe('0');
  });

  it('holds controls visible for keyboard focus inside the shadow root', async () => {
    vi.useFakeTimers();
    const { tile } = stream();
    install();
    await vi.advanceTimersByTimeAsync(2000);
    // jsdom tracks shadow focus but does not implement its :focus-visible state.
    const shadow = toolbar(tile).shadowRoot!;
    const querySelector = shadow.querySelector.bind(shadow);
    vi.spyOn(shadow, 'querySelector').mockImplementation(((selector: string) => (
      selector === 'button:focus-visible' ? shadow.activeElement : querySelector(selector)
    )) as typeof shadow.querySelector);
    const plus = control(tile, 'Zoom in');
    plus.focus();
    expect(toolbar(tile).style.opacity).toBe('1');
    await vi.advanceTimersByTimeAsync(6000);
    expect(toolbar(tile).style.opacity).toBe('1');

    control(tile, 'Reset zoom').focus();
    control(tile, 'Reset zoom').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await vi.advanceTimersByTimeAsync(6000);
    expect(toolbar(tile).style.opacity).toBe('1');
    control(tile, 'Reset zoom').blur();
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');
  });

  it('lets controls hide after a pointer click leaves a zoom button focused', async () => {
    vi.useFakeTimers();
    const { tile, video } = stream();
    install();
    const plus = control(tile, 'Zoom in');
    plus.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true, button: 0 }));
    plus.focus();
    plus.click();
    toolbar(tile).dispatchEvent(new MouseEvent('pointerleave', { composed: true }));
    pointer(video, 'pointermove', 510, 350);
    expect(percentage(tile)).toBe(125);
    expect(toolbar(tile).shadowRoot?.activeElement).toBe(plus);
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');
  });

  it('clears the pending idle countdown when zoom controls are cleaned up', () => {
    vi.useFakeTimers();
    const { tile } = stream();
    const stop = install();
    control(tile, 'Zoom in').click();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(tile.querySelector('[data-backspace-stream-zoom]')).toBeNull();
  });

  it('hides when the pointer leaves the stream but stays visible during a drag', async () => {
    vi.useFakeTimers();
    const { tile, video } = stream();
    install();
    tile.dispatchEvent(new MouseEvent('pointerleave'));
    expect(toolbar(tile).style.opacity).toBe('0');

    wheel(video, -240);
    pointer(video, 'pointerdown', 500, 350);
    tile.dispatchEvent(new MouseEvent('pointerleave'));
    await vi.advanceTimersByTimeAsync(6000);
    expect(toolbar(tile).style.opacity).toBe('1');
    pointer(tile, 'pointerup', 510, 350);
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');
  });

  it('resumes hiding when a source change cancels a drag after its idle countdown elapsed', async () => {
    vi.useFakeTimers();
    const { tile, video } = stream();
    const stop = install();
    wheel(video, -240);
    pointer(video, 'pointerdown', 500, 350);
    await vi.advanceTimersByTimeAsync(2500);
    expect(toolbar(tile).style.opacity).toBe('1');

    video.srcObject = { id: 'replacement-share' } as unknown as MediaStream;
    await vi.advanceTimersByTimeAsync(250);
    expect(percentage(tile)).toBe(100);
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar(tile).style.opacity).toBe('0');
    stop();
    expect(vi.getTimerCount()).toBe(0);
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

  it('leaves overlay sliders and custom controls interactive without starting a pan or wheel zoom', () => {
    const { wrapper, tile, video } = stream();
    const delegatedClick = vi.fn();
    wrapper.addEventListener('click', delegatedClick);
    const overlay = document.createElement('div');
    overlay.innerHTML = '<input type="range" aria-label="Stream volume"><div role="button"><span>Quality</span></div>';
    tile.append(overlay);
    install();
    control(tile, 'Zoom in').click();
    const transform = video.style.transform;
    for (const target of [overlay.querySelector('input')!, overlay.querySelector('span')!]) {
      expect(pointer(target, 'pointerdown', 500, 350).defaultPrevented).toBe(false);
      pointer(target, 'pointermove', 600, 390);
      pointer(target, 'pointerup', 600, 390);
      expect(wheel(target, -100).defaultPrevented).toBe(false);
      target.click();
    }
    expect(tile.setPointerCapture).not.toHaveBeenCalled();
    expect(video.style.transform).toBe(transform);
    expect(delegatedClick).toHaveBeenCalledTimes(2);
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
