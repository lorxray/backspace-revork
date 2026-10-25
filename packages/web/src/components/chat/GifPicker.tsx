import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchGifPage } from '../../utils/gifSearchCache';
import { AnimatedImage } from '../ui/AnimatedImage';
import { GifLoadError, gifLoadFailure, type GifLoadFailure } from './GifLoadError';
import type { GifResult } from '@backspace/shared';

interface GifPickerProps {
  onGifSelect: (url: string) => void;
  /** Optional controlled query and home view for the voice-channel catalog. */
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  emptyContent?: React.ReactNode;
  /**
   * Mobile rendering: drop the desktop fixed dimensions and let the picker
   * fill its parent (a bottom sheet that controls width + max-height).
   */
  mobile?: boolean;
}

export function GifPicker({ onGifSelect, mobile = false, searchQuery, onSearchChange, emptyContent }: GifPickerProps) {
  const { t } = useTranslation(['chat', 'common']);
  const [localQuery, setLocalQuery] = useState('');
  const query = searchQuery ?? localQuery;
  const setQuery = onSearchChange ?? setLocalQuery;
  const showingHome = !!emptyContent && !query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextPos, setNextPos] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState<GifLoadFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const morePending = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Debounce search query
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Fetch results when debounced query changes
  useEffect(() => {
    let cancelled = false;
    generation.current += 1;
    setLoading(true);
    setLoadingMore(false);
    morePending.current = false;
    setFailed(null);
    setResults([]);
    setNextPos('');
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (showingHome || query.trim() !== debouncedQuery.trim()) {
      setLoading(!showingHome);
      return;
    }

    const fetchGifs = async () => {
      try {
        const data = debouncedQuery.trim()
          ? await fetchGifPage(debouncedQuery.trim())
          : await fetchGifPage('');
        if (!cancelled) {
          setResults(data.results);
          setNextPos(data.next);
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setLoading(false);
          setFailed(gifLoadFailure(error));
        }
      }
    };
    fetchGifs();
    return () => { cancelled = true; generation.current += 1; };
  }, [debouncedQuery, query, showingHome, retry]);

  // Infinite scroll
  const loadMore = useCallback((retryFailure = false) => {
    if (morePending.current || loading || !nextPos || showingHome || (failed && !retryFailure)
      || (failed?.kind === 'rateLimit' && failed.retryAt > Date.now())) return;
    const requestGeneration = generation.current;
    morePending.current = true;
    setFailed(null);
    setLoadingMore(true);
    const fetchMore = async () => {
      try {
        const data = debouncedQuery.trim()
          ? await fetchGifPage(debouncedQuery.trim(), 30, nextPos)
          : await fetchGifPage('', 30, nextPos);
        if (requestGeneration !== generation.current) return;
        setResults((prev) => [...new Map([...prev, ...data.results].map((gif) => [gif.id, gif])).values()]);
        setNextPos(data.next);
      } catch (error) {
        if (requestGeneration === generation.current) {
          setFailed(gifLoadFailure(error));
        }
      } finally {
        if (requestGeneration === generation.current) {
          morePending.current = false;
          setLoadingMore(false);
        }
      }
    };
    void fetchMore();
  }, [loading, nextPos, showingHome, debouncedQuery, failed]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 100) loadMore();
  }, [loadMore]);

  // Keep typing out of app shortcuts while allowing the dialog's Escape key.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') e.stopPropagation();
  };

  // Mobile: fill parent (sheet sets width + max-height). Desktop: fixed dims
  // matching the legacy popover footprint.
  const rootClass = mobile
    ? 'flex flex-col flex-1 min-h-0 w-full'
    : 'flex flex-col h-[390px] w-[390px]';

  return (
    <div className={rootClass} onKeyDown={handleKeyDown}>
      {/* Search */}
      <div className="px-3 pt-2 pb-1.5 shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('chat:gif.searchPlaceholder')}
          aria-label={t('chat:gif.searchPlaceholder')}
          className="input-search w-full"
          // Auto-focus only on desktop. On mobile this would force the OS
          // keyboard up the moment the sheet opens, hiding most of the grid.
          autoFocus={!mobile}
        />
      </div>

      {/* Results grid */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-1"
        onScroll={handleScroll}
      >
        {showingHome ? emptyContent : loading ? (
          <div className="grid grid-cols-2 gap-1.5 p-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="bg-surface-elevated rounded-lg animate-pulse"
                style={{ height: 100 + Math.random() * 60 }}
              />
            ))}
          </div>
        ) : results.length === 0 && !failed ? (
          <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
            {debouncedQuery.trim() ? t('chat:gif.noResults') : t('chat:gif.noTrending')}
          </div>
        ) : (
          <div className="columns-2 gap-1.5 p-1">
            {results.map((gif) => (
              <button
                type="button"
                key={gif.id}
                onClick={() => onGifSelect(gif.url)}
                className="w-full mb-1.5 rounded-lg overflow-hidden hover:ring-2 hover:ring-accent-primary transition-all break-inside-avoid"
              >
                <AnimatedImage
                  src={gif.previewUrl}
                  fallbackSrc={gif.url}
                  alt={gif.title}
                  className="w-full object-cover rounded-lg"
                  style={{
                    aspectRatio: gif.width && gif.height ? `${gif.width}/${gif.height}` : undefined,
                  }}
                />
              </button>
            ))}
          </div>
        )}
        {loadingMore && (
          <div className="flex justify-center py-2">
            <div className="w-5 h-5 border-2 border-txt-tertiary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {!showingHome && failed && (
          <GifLoadError failure={failed} onRetry={() => { if (nextPos && results.length) loadMore(true); else setRetry((value) => value + 1); }} />
        )}
        {!showingHome && !loading && !loadingMore && nextPos && !failed && (
          <button type="button" onClick={() => loadMore()} className="my-2 w-full rounded-md py-2 text-sm text-txt-secondary hover:bg-interactive-hover">{t('chat:gif.loadMore')}</button>
        )}
      </div>

      {/* Attribution */}
      <div className="px-3 py-1 text-[10px] text-txt-tertiary text-right shrink-0">
        {t('chat:gif.attribution')}
      </div>
    </div>
  );
}
