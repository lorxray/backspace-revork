import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedImage } from './AnimatedImage';
import { openImageAnimation, supportsImageAnimation, type ImageAnimationCallbacks } from '../../utils/imageAnimation';

const play = vi.fn();
const pause = vi.fn();
const dispose = vi.fn();
vi.mock('../../utils/imageAnimation', () => ({ supportsImageAnimation: vi.fn(() => true), openImageAnimation: vi.fn() }));
beforeEach(() => {
  play.mockClear(); pause.mockClear(); dispose.mockClear();
  vi.mocked(supportsImageAnimation).mockReturnValue(true);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.mocked(openImageAnimation).mockReset().mockResolvedValue({ play, pause, dispose });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('AnimatedImage', () => {
  it.each([false, true])('allows a slow native download to finish without discarding it (partial frame: %s)', async (partial) => {
    vi.useFakeTimers();
    const error = vi.fn();
    render(<AnimatedImage src="https://example.com/slow.gif" alt="Slow download" onError={error} />);
    const img = screen.getByAltText('Slow download');
    if (partial) Object.defineProperties(img, { naturalWidth: { value: 100 }, naturalHeight: { value: 80 } });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByAltText('Slow download')).toBe(img);
    expect(img).toHaveAttribute('src', 'https://example.com/slow.gif');
    expect(img).toBeVisible();
    expect(error).not.toHaveBeenCalled();
    expect(openImageAnimation).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.load(img);
    await act(async () => {});
    expect(play).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('autoplays three cycles and lets a two-cycle hover run finish after leaving', async () => {
    const { unmount } = render(<button><AnimatedImage src="https://example.com/cat.gif" alt="Cat animation" /></button>);
    fireEvent.load(screen.getByAltText('Cat animation'));
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
    const callbacks: ImageAnimationCallbacks = vi.mocked(openImageAnimation).mock.calls[0]![2];
    act(() => callbacks.onPaint());
    expect(screen.getByRole('img', { name: 'Cat animation' }).closest('[data-animation-mode]')).toHaveAttribute('data-animation-mode', 'decoded');
    act(() => callbacks.onFinish());
    const surface = screen.getByRole('img', { name: 'Cat animation' }).closest('[data-animation-state]');
    expect(surface).toHaveAttribute('data-animation-state', 'paused');

    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenLastCalledWith(2);
    act(() => callbacks.onPaint());
    const playCount = play.mock.calls.length;
    const pauseCount = pause.mock.calls.length;
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(surface).toHaveAttribute('data-animation-state', 'playing');
    expect(pause).toHaveBeenCalledTimes(pauseCount);
    fireEvent.mouseEnter(screen.getByRole('button'));
    fireEvent.focus(screen.getByRole('button'));
    expect(play).toHaveBeenCalledTimes(playCount);
    fireEvent.blur(screen.getByRole('button'));
    expect(pause).toHaveBeenCalledTimes(pauseCount);

    act(() => callbacks.onFinish());
    expect(surface).toHaveAttribute('data-animation-state', 'paused');
    fireEvent.focus(screen.getByRole('button'));
    expect(play).toHaveBeenCalledTimes(playCount + 1);
    expect(play).toHaveBeenLastCalledWith(2);
    unmount();
    expect(dispose).toHaveBeenCalled();
  });

  it('remembers a brief hover while the decoder is still loading', async () => {
    let resolve!: (player: Awaited<ReturnType<typeof openImageAnimation>>) => void;
    vi.mocked(openImageAnimation).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<button><AnimatedImage src="https://example.com/slow.gif" alt="Slow animation" /></button>);
    fireEvent.load(screen.getByAltText('Slow animation'));
    fireEvent.mouseEnter(screen.getByRole('button'));
    fireEvent.mouseLeave(screen.getByRole('button'));
    fireEvent.mouseEnter(screen.getByRole('button'));
    await act(async () => resolve({ play, pause, dispose }));
    expect(play).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('stops immediately when the document is hidden and starts a fresh run on the next hover', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    render(<button><AnimatedImage src="https://example.com/cat.gif" alt="Cat animation" /></button>);
    fireEvent.load(screen.getByAltText('Cat animation'));
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
    fireEvent.mouseEnter(screen.getByRole('button'));
    const count = play.mock.calls.length;
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    expect(pause).toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenCalledTimes(count);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    expect(play).toHaveBeenCalledTimes(count);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenLastCalledWith(2);
    expect(play).toHaveBeenCalledTimes(count + 1);
  });

  it('cancels pending hover playback when the image leaves the viewport', async () => {
    let intersect!: (entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersect) { intersect = callback; }
      observe() {}
      disconnect = disconnect;
    });
    let resolve!: (player: Awaited<ReturnType<typeof openImageAnimation>>) => void;
    vi.mocked(openImageAnimation).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { unmount } = render(<button><AnimatedImage src="https://example.com/cat.gif" alt="Cat animation" /></button>);
    fireEvent.load(screen.getByAltText('Cat animation'));
    fireEvent.mouseEnter(screen.getByRole('button'));
    act(() => intersect([{ isIntersecting: false }]));
    await act(async () => resolve({ play, pause, dispose }));
    expect(play).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).not.toHaveBeenCalled();
    act(() => intersect([{ isIntersecting: true }]));
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenCalledExactlyOnceWith(2);
    act(() => intersect([{ isIntersecting: false }]));
    expect(pause).toHaveBeenCalledTimes(2);
    unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it('bounds native playback without cutting it off or extending it on repeated hover', async () => {
    vi.useFakeTimers();
    vi.mocked(supportsImageAnimation).mockReturnValue(false);
    render(<button><AnimatedImage src="https://example.com/native.gif" alt="Native animation" /></button>);
    const img = screen.getByAltText('Native animation');
    Object.defineProperties(img, { naturalWidth: { value: 100 }, naturalHeight: { value: 80 } });
    fireEvent.load(img);
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    const surface = img.closest('[data-animation-state]');
    expect(surface).toHaveAttribute('data-animation-state', 'paused');
    fireEvent.mouseEnter(screen.getByRole('button'));
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(surface).toHaveAttribute('data-animation-state', 'playing');
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    fireEvent.mouseEnter(screen.getByRole('button'));
    fireEvent.focus(screen.getByRole('button'));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(surface).toHaveAttribute('data-animation-state', 'paused');
    expect(img).not.toBeVisible();
    expect(openImageAnimation).not.toHaveBeenCalled();
  });

  it('honors reduced motion on load while allowing explicit hover playback', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    render(<button><AnimatedImage src="https://example.com/cat.gif" alt="Cat animation" /></button>);
    fireEvent.load(screen.getByAltText('Cat animation'));
    await waitFor(() => expect(openImageAnimation).toHaveBeenCalled());
    expect(play).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenCalledExactlyOnceWith(2);
  });

  it('keeps the native image visible while controlled decoding downloads', async () => {
    let resolve!: (player: Awaited<ReturnType<typeof openImageAnimation>>) => void;
    vi.mocked(openImageAnimation).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<AnimatedImage src="https://example.com/slow.gif" alt="Slow animation" />);
    const img = screen.getByAltText('Slow animation');
    fireEvent.load(img);
    expect(img).toBeVisible();
    expect(img).toHaveAttribute('src', 'https://example.com/slow.gif');
    await act(async () => resolve({ play, pause, dispose }));
    expect(img).toBeVisible();
    act(() => vi.mocked(openImageAnimation).mock.calls[0]![2].onPaint());
    expect(img).not.toBeVisible();
  });

  it('falls back from a broken preview to the original and offers a bounded media retry', async () => {
    vi.useFakeTimers();
    const select = vi.fn();
    render(<button onClick={select}><AnimatedImage src="https://example.com/preview.webp" fallbackSrc="https://example.com/original.gif" alt="Retry image" /></button>);
    fireEvent.error(screen.getByAltText('Retry image'));
    expect(screen.getByAltText('Retry image')).toHaveAttribute('src', 'https://example.com/original.gif');
    fireEvent.error(screen.getByAltText('Retry image'));
    expect(screen.getByText('Preview unavailable. Click to retry.')).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.queryByText('Preview unavailable. Click to retry.')).not.toBeInTheDocument();
    fireEvent.error(screen.getByAltText('Retry image'));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByText('Preview unavailable. Click to retry.')).toBeVisible();
    fireEvent.click(screen.getByText('Preview unavailable. Click to retry.'));
    expect(select).not.toHaveBeenCalled();
    expect(screen.getByAltText('Retry image')).toHaveAttribute('src', 'https://example.com/original.gif');
  });
});
