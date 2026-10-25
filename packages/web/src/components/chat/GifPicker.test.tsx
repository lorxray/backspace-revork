import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, RateLimitError } from '../../api/client';
import { GifPicker } from './GifPicker';
import { VoiceVibeGifPicker } from '../voice/VoiceVibeGifPicker';
import type { GifResult } from '@backspace/shared';

function gif(id: string): GifResult {
  return { id, title: id, url: `https://static.klipy.com/${id}.gif`, previewUrl: `https://static.klipy.com/${id}.webp`, width: 200, height: 120 };
}
type Page = { results: GifResult[]; next: string };
let clock = Date.parse('2026-10-25T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock += 61_000);
  localStorage.clear();
  vi.spyOn(api.gif, 'trending').mockResolvedValue({ results: [gif('trending')], next: '' });
  vi.spyOn(api.gif, 'search').mockImplementation(async (query) => ({ results: [gif(query)], next: '' }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function search(query: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search KLIPY' }), { target: { value: query } });
}

describe('GIF catalog', () => {
  it('keeps the ordinary chat picker trending view', async () => {
    render(<GifPicker onGifSelect={() => {}} />);
    expect(await screen.findByAltText('trending')).toBeInTheDocument();
    expect(api.gif.trending).toHaveBeenCalledWith(30);
  });

  it('searches a description from the voice home view and selects the full GIF URL', async () => {
    const select = vi.fn();
    function ControlledPicker() {
      const [query, setQuery] = useState('');
      return <GifPicker mobile onGifSelect={select} searchQuery={query} onSearchChange={setQuery} emptyContent={<span>Categories home</span>} />;
    }
    render(<ControlledPicker />);
    expect(screen.getByText('Categories home')).toBeInTheDocument();
    expect(api.gif.trending).not.toHaveBeenCalled();
    search('cat waiting for friends');
    expect(await screen.findByAltText('cat waiting for friends')).toBeInTheDocument();
    expect(api.gif.search).toHaveBeenCalledWith('cat waiting for friends', 30);
    fireEvent.click(screen.getByAltText('cat waiting for friends'));
    expect(select).toHaveBeenCalledWith(gif('cat waiting for friends').url);
  });

  it('loads every category preview immediately and reuses the same cached result pages', async () => {
    const { unmount } = render(<VoiceVibeGifPicker onGifSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'Cats' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minecraft' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mushoku Tensei' })).toBeInTheDocument();
    await waitFor(() => expect(api.gif.search).toHaveBeenCalledTimes(9));
    await waitFor(() => expect(within(screen.getByRole('button', { name: 'Cats' })).getByAltText('')).toHaveAttribute('src', gif('funny cats').previewUrl));
    fireEvent.click(screen.getByRole('button', { name: 'Cats' }));
    expect(await screen.findByAltText('funny cats')).toBeInTheDocument();
    expect(api.gif.search).toHaveBeenCalledWith('funny cats', 30);
    fireEvent.click(screen.getByRole('button', { name: '← Categories' }));
    expect(screen.getByRole('button', { name: 'Cats' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cats' }));
    expect(await screen.findByAltText('funny cats')).toBeInTheDocument();
    expect(api.gif.search).toHaveBeenCalledTimes(9);
    expect(api.gif.trending).not.toHaveBeenCalled();
    unmount();
    render(<VoiceVibeGifPicker onGifSelect={() => {}} />);
    await act(async () => {});
    expect(api.gif.search).toHaveBeenCalledTimes(9);
    expect(within(screen.getByRole('button', { name: 'Cats' })).getByAltText('')).toHaveAttribute('src', gif('funny cats').previewUrl);
  });

  it('ignores an older search response after the query changes', async () => {
    let resolveCats!: (page: Page) => void;
    vi.mocked(api.gif.search).mockImplementation(async (query) => query === 'cats'
      ? new Promise((resolve) => { resolveCats = resolve; })
      : { results: [gif('dogs')], next: '' });
    render(<GifPicker onGifSelect={() => {}} />);
    search('cats');
    await waitFor(() => expect(api.gif.search).toHaveBeenCalledWith('cats', 30));
    search('dogs');
    expect(await screen.findByAltText('dogs')).toBeInTheDocument();
    await act(async () => resolveCats({ results: [gif('old cats')], next: '' }));
    expect(screen.queryByAltText('old cats')).not.toBeInTheDocument();
    expect(screen.getByAltText('dogs')).toBeInTheDocument();
  });

  it('does not append an old next page to a different search', async () => {
    let resolveMore!: (page: Page) => void;
    vi.mocked(api.gif.search).mockImplementation(async (query, _limit, pos) => {
      if (pos) return new Promise((resolve) => { resolveMore = resolve; });
      return { results: [gif(query)], next: query === 'cats' ? '2' : '' };
    });
    render(<GifPicker onGifSelect={() => {}} />);
    search('cats');
    await screen.findByAltText('cats');
    fireEvent.click(screen.getByRole('button', { name: 'Load more GIFs' }));
    search('dogs');
    await screen.findByAltText('dogs');
    await act(async () => resolveMore({ results: [gif('old cat page')], next: '3' }));
    expect(screen.queryByAltText('old cat page')).not.toBeInTheDocument();
    expect(screen.getByAltText('dogs')).toBeInTheDocument();
  });

  it('shows a recoverable network error and retries the current search', async () => {
    vi.mocked(api.gif.search).mockRejectedValueOnce(new Error('offline'));
    render(<GifPicker onGifSelect={() => {}} />);
    search('cats');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load GIFs');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByAltText('cats')).toBeInTheDocument();
  });

  it('counts down the server retry delay and enables manual retry when it expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    vi.mocked(api.gif.trending).mockRejectedValueOnce(new RateLimitError(2.4));
    render(<GifPicker onGifSelect={() => {}} />);
    await act(async () => {});
    expect(screen.getByRole('alert')).toHaveTextContent('Too many requests. Try again in 3 s.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 2 s.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(api.gif.trending).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByRole('alert')).toHaveTextContent('You can try searching again now.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await act(async () => {});
    expect(screen.getByAltText('trending')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a pagination limit without discarding already loaded GIFs', async () => {
    vi.mocked(api.gif.trending)
      .mockResolvedValueOnce({ results: [gif('first page')], next: '2' })
      .mockRejectedValueOnce(new RateLimitError(17));
    render(<GifPicker onGifSelect={() => {}} />);
    await screen.findByAltText('first page');
    fireEvent.click(screen.getByRole('button', { name: 'Load more GIFs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests. Try again in 17 s.');
    expect(screen.getByAltText('first page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('uses a finite fallback when the retry delay is invalid', async () => {
    vi.mocked(api.gif.trending).mockRejectedValueOnce(new RateLimitError(Number.NaN));
    render(<GifPicker onGifSelect={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again in 60 s.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('reports category preview failures and retries only failed categories', async () => {
    vi.mocked(api.gif.search).mockImplementation(async (query) => {
      if (query === 'funny cats') throw new Error('offline');
      return { results: [gif(query)], next: '' };
    });
    render(<VoiceVibeGifPicker onGifSelect={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load GIFs');
    await waitFor(() => expect(api.gif.search).toHaveBeenCalledTimes(9));
    vi.mocked(api.gif.search).mockResolvedValue({ results: [gif('recovered cats')], next: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(api.gif.search).toHaveBeenCalledTimes(10));
    expect(within(screen.getByRole('button', { name: 'Cats' })).getByAltText('')).toHaveAttribute('src', gif('recovered cats').previewUrl);
  });

  it('does not retry failed pagination merely because the user scrolls again', async () => {
    vi.mocked(api.gif.trending).mockResolvedValueOnce({ results: [gif('page one')], next: '2' }).mockRejectedValue(new Error('offline'));
    const { container } = render(<GifPicker onGifSelect={() => {}} />);
    await screen.findByAltText('page one');
    fireEvent.click(screen.getByRole('button', { name: 'Load more GIFs' }));
    await screen.findByRole('alert');
    fireEvent.scroll(container.querySelector('.overflow-y-auto')!);
    await act(async () => {});
    expect(api.gif.trending).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.gif.trending).toHaveBeenCalledTimes(3));
  });
});
