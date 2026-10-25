import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, RateLimitError } from '../api/client';
import { fetchGifPage, peekGifPage } from './gifSearchCache';

const page = { results: [{ id: 'cat', title: 'Cat', url: 'https://static.klipy.com/cat.gif', previewUrl: 'https://static.klipy.com/cat.webp', width: 100, height: 100 }], next: '2' };
let clock = Date.parse('2026-10-25T12:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(clock += 61_000);
  localStorage.clear();
  vi.spyOn(api.gif, 'search').mockResolvedValue(page);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('GIF search metadata cache', () => {
  it('reuses a query and can restore its metadata from local storage', async () => {
    await fetchGifPage('cats');
    const saved = localStorage.getItem('backspace.gif-search-cache.v1')!;
    await fetchGifPage(' CATS ');
    expect(api.gif.search).toHaveBeenCalledTimes(1);
    localStorage.clear();
    await fetchGifPage('other');
    localStorage.setItem('backspace.gif-search-cache.v1', saved);
    expect(await fetchGifPage('cats')).toEqual(page);
    expect(api.gif.search).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests for the same page', async () => {
    let resolve!: (value: typeof page) => void;
    vi.mocked(api.gif.search).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const first = fetchGifPage('concurrent');
    const second = fetchGifPage('concurrent');
    expect(first).toBe(second);
    expect(api.gif.search).toHaveBeenCalledTimes(1);
    resolve(page);
    await first;
  });

  it('fetches fresh results after the search TTL and keeps pagination separate', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T12:00:00Z'));
    await fetchGifPage('expiry');
    await fetchGifPage('expiry', 30, '2');
    expect(api.gif.search).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date('2026-10-25T12:59:59Z'));
    expect(peekGifPage('expiry')).toEqual(page);
    vi.setSystemTime(new Date('2026-10-25T13:00:00Z'));
    expect(peekGifPage('expiry')).toBeNull();
    await fetchGifPage('expiry');
    expect(api.gif.search).toHaveBeenCalledTimes(3);
  });

  it('does not cache rate limits or empty responses that may represent upstream failures', async () => {
    vi.mocked(api.gif.search).mockRejectedValueOnce(new RateLimitError(10));
    await expect(fetchGifPage('limited')).rejects.toBeInstanceOf(RateLimitError);
    await expect(fetchGifPage('limited')).rejects.toBeInstanceOf(RateLimitError);
    expect(api.gif.search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await fetchGifPage('limited');
    expect(api.gif.search).toHaveBeenCalledTimes(2);
    vi.mocked(api.gif.search).mockResolvedValueOnce({ results: [], next: '' });
    await fetchGifPage('empty');
    await fetchGifPage('empty');
    expect(api.gif.search).toHaveBeenCalledTimes(4);
  });

  it('also retains trending metadata for one hour', async () => {
    vi.spyOn(api.gif, 'trending').mockResolvedValue(page);
    await fetchGifPage('');
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(await fetchGifPage('')).toEqual(page);
    expect(api.gif.trending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await fetchGifPage('');
    expect(api.gif.trending).toHaveBeenCalledTimes(2);
  });

  it('limits parallel category calls and promotes the selected category ahead of previews', async () => {
    const completions: (() => void)[] = [];
    vi.mocked(api.gif.search).mockImplementation(() => new Promise((resolve) => completions.push(() => resolve(page))));
    const requests = ['one', 'two', 'three', 'four'].map((query) => fetchGifPage(query, 30, '', { background: true }));
    expect(api.gif.search).toHaveBeenCalledTimes(2);
    const selected = fetchGifPage('four');
    expect(selected).toBe(requests[3]);
    completions[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.gif.search).toHaveBeenNthCalledWith(3, 'four', 30);
    completions[1]!();
    await vi.advanceTimersByTimeAsync(0);
    completions[2]!(); completions[3]!();
    await Promise.all(requests);
  });

  it('stops queued requests after a 429 while allowing cached pages', async () => {
    await fetchGifPage('saved');
    vi.mocked(api.gif.search).mockRejectedValueOnce(new RateLimitError(20));
    const outcomes = await Promise.allSettled(['limited-a', 'limited-b', 'limited-c', 'limited-d'].map((query) => fetchGifPage(query)));
    expect(outcomes[2]!.status).toBe('rejected');
    expect(outcomes[3]!.status).toBe('rejected');
    expect(api.gif.search).toHaveBeenCalledTimes(3);
    expect(await fetchGifPage('saved')).toEqual(page);
    await vi.advanceTimersByTimeAsync(20_000);
    await fetchGifPage('limited-c');
    expect(api.gif.search).toHaveBeenCalledTimes(4);
  });

  it('ignores corrupt saved metadata and bounds retained result pages', async () => {
    localStorage.setItem('backspace.gif-search-cache.v1', '{');
    expect(peekGifPage('corrupt')).toBeNull();
    for (let index = 0; index < 45; index++) await fetchGifPage(`bounded ${index}`);
    expect(peekGifPage('bounded 0')).toBeNull();
    expect(peekGifPage('bounded 44')).toEqual(page);
  });
});
