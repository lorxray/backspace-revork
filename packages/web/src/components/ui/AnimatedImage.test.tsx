import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedImage } from './AnimatedImage';
import { openImageAnimation, type ImageAnimationCallbacks } from '../../utils/imageAnimation';

const play = vi.fn();
const pause = vi.fn();
const dispose = vi.fn();
vi.mock('../../utils/imageAnimation', () => ({ supportsImageAnimation: () => true, openImageAnimation: vi.fn() }));
beforeEach(() => {
  play.mockClear(); pause.mockClear(); dispose.mockClear();
  vi.mocked(openImageAnimation).mockReset().mockResolvedValue({ play, pause, dispose });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('AnimatedImage', () => {
  it('autoplays three cycles and responds to the containing button hover and focus', async () => {
    const { unmount } = render(<button><AnimatedImage src="https://example.com/cat.gif" alt="Cat animation" /></button>);
    fireEvent.load(screen.getByAltText('Cat animation'));
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
    const callbacks: ImageAnimationCallbacks = vi.mocked(openImageAnimation).mock.calls[0]![2];
    act(() => callbacks.onPaint());
    expect(screen.getByRole('img', { name: 'Cat animation' }).closest('[data-animation-mode]')).toHaveAttribute('data-animation-mode', 'decoded');
    act(() => callbacks.onFinish());
    expect(screen.getByRole('img', { name: 'Cat animation' }).closest('[data-animation-state]')).toHaveAttribute('data-animation-state', 'paused');
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(play).toHaveBeenLastCalledWith(0);
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(pause).toHaveBeenCalled();
    fireEvent.focus(screen.getByRole('button'));
    expect(play).toHaveBeenLastCalledWith(0);
    unmount();
    expect(dispose).toHaveBeenCalled();
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
