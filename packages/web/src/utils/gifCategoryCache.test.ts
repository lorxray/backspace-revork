import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { fetchGifCategoryPreview, peekGifCategoryPreview } from './gifCategoryCache';
import { fetchGifPage } from './gifSearchCache';

const STORAGE_KEY = 'backspace.gif-category-previews.v1';
const WEEK = 7 * 24 * 60 * 60_000;
const gif = { id: 'cat', title: 'Cat', url: 'https://static.klipy.com/cat.gif', previewUrl: 'https://static.klipy.com/cat.webp', width: 100, height: 100 };
const newer = { ...gif, id: 'new-cat', url: 'https://static.klipy.com/new-cat.gif', previewUrl: 'https://static.klipy.com/new-cat.webp' };
let clock = Date.parse('2026-10-25T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock += 61_000);
  localStorage.clear();
  vi.spyOn(api.gif, 'search').mockResolvedValue({ results: [gif], next: '' });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('persistent GIF category artwork', () => {
  it('reuses fresh artwork and restores it from persistent metadata without an API call', async () => {
    await fetchGifCategoryPreview('cats');
    const saved = localStorage.getItem(STORAGE_KEY)!;
    await fetchGifCategoryPreview(' CATS ');
    expect(api.gif.search).toHaveBeenCalledTimes(1);
    localStorage.clear();
    await fetchGifCategoryPreview('other');
    localStorage.setItem(STORAGE_KEY, saved);
    expect(peekGifCategoryPreview('cats')).toEqual(gif);
    expect(await fetchGifCategoryPreview('cats')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(2);
  });

  it('keeps category artwork after the search TTL and ordinary search eviction', async () => {
    await fetchGifCategoryPreview('cats');
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    for (let index = 0; index < 45; index++) await fetchGifPage(`search ${index}`);
    expect(await fetchGifCategoryPreview('cats')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(46);
  });

  it('refreshes after seven days while exposing stale artwork immediately', async () => {
    await fetchGifCategoryPreview('cats');
    await vi.advanceTimersByTimeAsync(WEEK - 1);
    expect(await fetchGifCategoryPreview('cats')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(peekGifCategoryPreview('cats')).toEqual(gif);
    vi.mocked(api.gif.search).mockResolvedValue({ results: [newer], next: '' });
    expect(await fetchGifCategoryPreview('cats')).toEqual(newer);
    expect(api.gif.search).toHaveBeenCalledTimes(2);
  });

  it('retains stale working artwork after failed or empty refreshes and retries later', async () => {
    await fetchGifCategoryPreview('cats');
    await vi.advanceTimersByTimeAsync(WEEK);
    const saved = localStorage.getItem(STORAGE_KEY);
    vi.mocked(api.gif.search).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchGifCategoryPreview('cats')).rejects.toThrow('offline');
    expect(peekGifCategoryPreview('cats')).toEqual(gif);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    vi.mocked(api.gif.search).mockResolvedValueOnce({ results: [], next: '' });
    await expect(fetchGifCategoryPreview('cats')).rejects.toThrow('No usable category preview');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(saved);
    expect(await fetchGifCategoryPreview('cats')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(4);
  });

  it('does not retain a failed initial load', async () => {
    vi.mocked(api.gif.search).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchGifCategoryPreview('cats')).rejects.toThrow('offline');
    expect(peekGifCategoryPreview('cats')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    await fetchGifCategoryPreview('cats');
    expect(api.gif.search).toHaveBeenCalledTimes(2);
  });

  it('refreshes only broken artwork, bypasses its cached search page, and chooses an alternative', async () => {
    await fetchGifCategoryPreview('cats');
    await fetchGifCategoryPreview('dogs');
    vi.mocked(api.gif.search).mockResolvedValue({ results: [gif, newer], next: '' });
    expect(await fetchGifCategoryPreview('cats', gif)).toEqual(newer);
    expect(await fetchGifCategoryPreview('dogs')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(3);
    expect(api.gif.search).toHaveBeenLastCalledWith('cats', 30);
  });

  it('keeps a broken card invalid across reopen when no replacement is available', async () => {
    await fetchGifCategoryPreview('cats');
    await expect(fetchGifCategoryPreview('cats', gif)).rejects.toThrow('No usable category preview');
    const saved = localStorage.getItem(STORAGE_KEY)!;
    localStorage.clear();
    await fetchGifCategoryPreview('other');
    localStorage.setItem(STORAGE_KEY, saved);
    await expect(fetchGifCategoryPreview('cats')).rejects.toThrow('No usable category preview');
    expect(peekGifCategoryPreview('cats')).toEqual(gif);
    vi.mocked(api.gif.search).mockResolvedValue({ results: [newer], next: '' });
    expect(await fetchGifCategoryPreview('cats')).toEqual(newer);
    expect(api.gif.search).toHaveBeenCalledTimes(5);
  });

  it('deduplicates concurrent category loads and warms the ordinary category result page', async () => {
    let resolve!: (page: { results: typeof gif[]; next: string }) => void;
    vi.mocked(api.gif.search).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = fetchGifCategoryPreview('cats');
    expect(fetchGifCategoryPreview('cats')).toBe(first);
    resolve({ results: [gif], next: '' });
    await first;
    expect((await fetchGifPage('cats')).results).toEqual([gif]);
    expect(api.gif.search).toHaveBeenCalledTimes(1);
  });

  it('ignores artwork saved for a different API source or catalog version', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      { key: JSON.stringify(['https://other.example', 'klipy:voice-vibe:v1', 'cats']), expires: Date.now() + WEEK, gif: newer },
      { key: JSON.stringify([window.location.origin, 'old-catalog', 'cats']), expires: Date.now() + WEEK, gif: newer },
    ]));
    expect(peekGifCategoryPreview('cats')).toBeNull();
    expect(await fetchGifCategoryPreview('cats')).toEqual(gif);
    expect(api.gif.search).toHaveBeenCalledTimes(1);
  });

  it('ignores corrupt metadata and bounds retained artwork independently', async () => {
    localStorage.setItem(STORAGE_KEY, '{');
    expect(peekGifCategoryPreview('corrupt')).toBeNull();
    for (let index = 0; index < 40; index++) await fetchGifCategoryPreview(`category ${index}`);
    expect(peekGifCategoryPreview('category 0')).toBeNull();
    expect(peekGifCategoryPreview('category 39')).toEqual(gif);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toHaveLength(36);
  });
  it('does not accept broken artwork from a category refresh already in flight', async () => {
    await fetchGifCategoryPreview('cats');
    await vi.advanceTimersByTimeAsync(WEEK);
    let resolve!: (page: { results: typeof gif[]; next: string }) => void;
    vi.mocked(api.gif.search).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = fetchGifCategoryPreview('cats');
    const repair = fetchGifCategoryPreview('cats', gif);
    vi.mocked(api.gif.search).mockResolvedValue({ results: [gif, newer], next: '' });
    resolve({ results: [gif], next: '' });
    await refresh;
    expect(await repair).toEqual(newer);
    expect(peekGifCategoryPreview('cats')).toEqual(newer);
    expect(api.gif.search).toHaveBeenCalledTimes(3);
    // A late error from the old image cannot replace the repaired card.
    expect(await fetchGifCategoryPreview('cats', gif)).toEqual(newer);
    expect(api.gif.search).toHaveBeenCalledTimes(3);
  });

});
