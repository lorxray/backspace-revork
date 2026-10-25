import React, { useEffect, useState } from 'react';
import type { GifResult } from '@backspace/shared';
import { useTranslation } from 'react-i18next';
import { fetchGifPage, peekGifPage } from '../../utils/gifSearchCache';
import { GifPicker } from '../chat/GifPicker';
import { GifLoadError, gifLoadFailure, type GifLoadFailure } from '../chat/GifLoadError';
import { AnimatedImage } from '../ui/AnimatedImage';

const CATEGORIES = [
  { id: 'join', query: 'join us voice chat' },
  { id: 'chill', query: 'lofi studying' },
  { id: 'cats', query: 'funny cats' },
  { id: 'anime', query: 'anime' },
  { id: 'mushoku', query: 'mushoku tensei' },
  { id: 'minecraft', query: 'minecraft hop on' },
  { id: 'valorant', query: 'valorant' },
  { id: 'bored', query: 'bored' },
  { id: 'happy', query: 'happy' },
] as const;

function VibeCategories({ onSelect }: { onSelect: (query: string) => void }) {
  const { t } = useTranslation('voice');
  const [failure, setFailure] = useState<GifLoadFailure | null>(null);
  const [retry, setRetry] = useState(0);
  const [previews, setPreviews] = useState<Record<string, GifResult | undefined>>(() => Object.fromEntries(
    CATEGORIES.map((category) => [category.id, peekGifPage(category.query)?.results[0]]),
  ));
  useEffect(() => {
    let cancelled = false;
    setFailure(null);
    // Fetch the actual first result page once: its thumbnail fills the card,
    // and opening the category reuses the same cached page without a new call.
    for (const category of CATEGORIES) {
      void fetchGifPage(category.query, 30, '', { background: true }).then((page) => {
        if (!page.results.length) throw new Error('Empty category preview');
        if (!cancelled) setPreviews((current) => ({ ...current, [category.id]: page.results[0] }));
      }).catch((error) => {
        if (!cancelled) setFailure((current) => current?.kind === 'rateLimit' ? current : gifLoadFailure(error));
      });
    }
    return () => { cancelled = true; };
  }, [retry]);
  return (
    <>
    <div className="grid grid-cols-2 gap-2 p-1">
      {CATEGORIES.map((category) => {
        const preview = previews[category.id];
        return (
        <button key={category.id} type="button" onClick={() => onSelect(category.query)} className="relative isolate flex aspect-video items-end justify-center overflow-hidden rounded-lg bg-surface-elevated p-3 text-center text-sm font-bold text-white hover:ring-2 hover:ring-accent-primary focus-visible:ring-2 focus-visible:ring-accent-primary">
          {preview && <AnimatedImage src={preview.previewUrl} fallbackSrc={preview.url} alt="" className="absolute inset-0 -z-20 h-full w-full" />}
          <span className="absolute inset-0 -z-10 bg-gradient-to-t from-black/85 via-black/35 to-black/10" />
          {t(`vibe.categories.${category.id}`)}
        </button>
        );
      })}
    </div>
    {failure && <GifLoadError failure={failure} onRetry={() => setRetry((value) => value + 1)} />}
    </>
  );
}

export function VoiceVibeGifPicker({ onGifSelect }: { onGifSelect: (url: string) => void }) {
  const { t } = useTranslation('voice');
  const [query, setQuery] = useState('');
  return (
    <>
      {query.trim() && <button type="button" onClick={() => setQuery('')} className="mx-3 mt-2 self-start rounded-md px-2 py-1 text-xs text-txt-secondary hover:bg-interactive-hover">{t('vibe.backToCategories')}</button>}
      <GifPicker mobile onGifSelect={onGifSelect} searchQuery={query} onSearchChange={setQuery} emptyContent={<VibeCategories onSelect={setQuery} />} />
    </>
  );
}
