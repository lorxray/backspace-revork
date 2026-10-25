import type { GifResult } from '@backspace/shared';
import { api, RateLimitError } from '../api/client';

export interface GifPage { results: GifResult[]; next: string }
interface CacheEntry { key: string; expires: number; page: GifPage }
const STORAGE_KEY = 'backspace.gif-search-cache.v1';
const MAX_ENTRIES = 40;
const CACHE_TTL = 60 * 60_000;
let memory: CacheEntry[] = [];
let lastRaw: string | null | undefined;
let memoryOnly = false;
const pending = new Map<string, Promise<GifPage>>();
interface Job { key: string; background: boolean; run: () => void; reject: (error: unknown) => void }
const queue: Job[] = [];
let active = 0;
let retryAt = 0;

function limited(): RateLimitError | null {
  return retryAt > Date.now() ? new RateLimitError(Math.ceil((retryAt - Date.now()) / 1_000)) : null;
}

function pump(): void {
  // Interactive searches go ahead of queued category previews. Two concurrent
  // requests avoid flooding the server when all nine category cards open.
  while (queue.length && active < 2) {
    const job = queue.shift()!;
    const error = limited();
    if (error) { job.reject(error); continue; }
    active += 1;
    job.run();
  }
}

function cacheKey(query: string, limit: number, pos: string): string {
  return JSON.stringify([query.trim().replace(/\s+/g, ' ').toLowerCase(), limit, pos]);
}

function isPage(value: unknown): value is GifPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as GifPage;
  return typeof page.next === 'string' && Array.isArray(page.results) && page.results.length <= 50
    && page.results.every((gif) => gif && typeof gif.id === 'string' && typeof gif.title === 'string'
      && typeof gif.url === 'string' && typeof gif.previewUrl === 'string'
      && /^https:\/\//.test(gif.url) && /^https:\/\//.test(gif.previewUrl)
      && Number.isFinite(gif.width) && Number.isFinite(gif.height));
}

function entries(): CacheEntry[] {
  if (!memoryOnly) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== lastRaw) {
        lastRaw = raw;
        let parsed: unknown = [];
        try { parsed = raw && raw.length <= 2_000_000 ? JSON.parse(raw) : []; } catch { /* Discard corrupt metadata. */ }
        memory = Array.isArray(parsed) ? parsed.filter((entry): entry is CacheEntry =>
          !!entry && typeof entry.key === 'string' && Number.isFinite(entry.expires)
          && isPage(entry.page)).slice(-MAX_ENTRIES) : [];
      }
    } catch {
      // Private/full storage still gets a bounded in-memory cache this session.
      memoryOnly = true;
    }
  }
  return memory.filter((entry) => entry.expires > Date.now());
}

/** Only API result metadata is retained. Media continues to load from its original URL. */
export function peekGifPage(query: string, limit = 30, pos = ''): GifPage | null {
  const key = cacheKey(query, limit, pos);
  return entries().find((entry) => entry.key === key)?.page ?? null;
}

export function fetchGifPage(query: string, limit = 30, pos = '', options: { background?: boolean } = {}): Promise<GifPage> {
  const key = cacheKey(query, limit, pos);
  const cached = peekGifPage(query, limit, pos);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) {
    const queued = queue.find((job) => job.key === key);
    if (queued && !options.background) {
      queued.background = false;
      queue.sort((a, b) => Number(a.background) - Number(b.background));
    }
    return existing;
  }
  const error = limited();
  if (error) return Promise.reject(error);
  const trimmed = query.trim();
  let start!: () => void;
  let rejectQueued!: (error: unknown) => void;
  const scheduled = new Promise<GifPage>((resolve, reject) => {
    rejectQueued = reject;
    start = () => {
      void (trimmed
        ? pos ? api.gif.search(trimmed, limit, pos) : api.gif.search(trimmed, limit)
        : pos ? api.gif.trending(limit, pos) : api.gif.trending(limit))
        .then(resolve, (failure) => {
          if (failure instanceof RateLimitError) {
            const seconds = Number(failure.retryAfter);
            retryAt = Math.max(retryAt, Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : 60) * 1_000);
          }
          reject(failure);
        }).finally(() => { active -= 1; pump(); });
    };
  });
  const request = scheduled
    .then((page) => {
      // The current server also uses an empty page for upstream failures.
      // Do not pin a temporary outage or exhausted upstream quota in storage.
      if (page.results.length && isPage(page)) {
        memory = [...entries().filter((entry) => entry.key !== key), {
          key, expires: Date.now() + CACHE_TTL, page,
        }].slice(-MAX_ENTRIES);
        const raw = JSON.stringify(memory);
        try {
          localStorage.setItem(STORAGE_KEY, raw);
          lastRaw = raw;
        } catch { memoryOnly = true; }
      }
      return page;
    }).finally(() => pending.delete(key));
  pending.set(key, request);
  queue.push({ key, background: !!options.background, run: start, reject: rejectQueued });
  queue.sort((a, b) => Number(a.background) - Number(b.background));
  pump();
  return request;
}
