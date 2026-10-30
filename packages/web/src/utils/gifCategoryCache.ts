import type { GifResult } from '@backspace/shared';
import { fetchGifPage } from './gifSearchCache';

interface PreviewEntry { key: string; expires: number; gif: GifResult }
const STORAGE_KEY = 'backspace.gif-category-previews.v1';
const CACHE_TTL = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 36;
let memory: PreviewEntry[] = [];
let lastRaw: string | null | undefined;
let memoryOnly = false;
const pending = new Map<string, Promise<GifResult>>();

function cacheKey(query: string): string {
  // Category artwork belongs to this API source and catalog version. Search
  // results have a separate, short-lived cache and cannot evict these cards.
  return JSON.stringify([window.location.origin, 'klipy:voice-vibe:v1', query.trim().replace(/\s+/g, ' ').toLowerCase()]);
}

function isPreview(value: unknown): value is GifResult {
  if (!value || typeof value !== 'object') return false;
  const gif = value as GifResult;
  return typeof gif.id === 'string' && typeof gif.title === 'string'
    && typeof gif.url === 'string' && /^https:\/\//.test(gif.url)
    && typeof gif.previewUrl === 'string' && /^https:\/\//.test(gif.previewUrl)
    && Number.isFinite(gif.width) && Number.isFinite(gif.height);
}

function entries(): PreviewEntry[] {
  if (!memoryOnly) {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== lastRaw) {
        lastRaw = raw;
        let parsed: unknown = [];
        try { parsed = raw && raw.length <= 200_000 ? JSON.parse(raw) : []; } catch { /* Ignore corrupt saved metadata. */ }
        memory = Array.isArray(parsed) ? parsed.filter((entry): entry is PreviewEntry =>
          !!entry && typeof entry.key === 'string' && Number.isFinite(entry.expires) && isPreview(entry.gif),
        ).slice(-MAX_ENTRIES) : [];
      }
    } catch { memoryOnly = true; }
  }
  return memory;
}

function save(next: PreviewEntry[]): void {
  memory = next.slice(-MAX_ENTRIES);
  const raw = JSON.stringify(memory);
  try { localStorage.setItem(STORAGE_KEY, raw); lastRaw = raw; }
  catch { memoryOnly = true; }
}

/** Stale artwork remains visible while a refresh runs or the API is unavailable. */
export function peekGifCategoryPreview(query: string): GifResult | null {
  return entries().find((entry) => entry.key === cacheKey(query))?.gif ?? null;
}

/** Only URLs and dimensions are retained; image bytes use the browser's HTTP cache. */
export function fetchGifCategoryPreview(query: string, broken?: GifResult): Promise<GifResult> {
  const key = cacheKey(query);
  const saved = entries().find((entry) => entry.key === key);
  if (broken && saved && saved.gif.id !== broken.id && saved.expires > Date.now()) return Promise.resolve(saved.gif);
  if (broken && saved?.gif.id === broken.id) {
    // Preserve the artwork as stale metadata, but never treat a broken card as
    // fresh on the next open, even if today's replacement request fails.
    save(entries().map((entry) => entry.key === key ? { ...entry, expires: 0 } : entry));
  }
  const rejected = broken ?? (saved?.expires === 0 ? saved.gif : undefined);
  if (!rejected && saved && saved.expires > Date.now()) return Promise.resolve(saved.gif);
  const existing = pending.get(key);
  if (existing) {
    // An image can fail while the weekly refresh is still loading. Check its
    // result before accepting it, so that refresh cannot re-pin broken artwork.
    return broken ? existing.then((gif) => gif.id === broken.id ? fetchGifCategoryPreview(query, broken) : gif) : existing;
  }
  const request = fetchGifPage(query, 30, '', { background: true, refresh: !!rejected })
    .then((page) => {
      const gif = page.results.find((candidate) => isPreview(candidate) && (!rejected || candidate.id !== rejected.id));
      if (!gif) throw new Error('No usable category preview');
      save([...entries().filter((entry) => entry.key !== key), { key, expires: Date.now() + CACHE_TTL, gif }]);
      return gif;
    }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
