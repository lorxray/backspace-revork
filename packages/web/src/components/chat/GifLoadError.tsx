import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RateLimitError } from '../../api/client';

export type GifLoadFailure = { kind: 'load' } | { kind: 'rateLimit'; retryAt: number };

export function gifLoadFailure(error: unknown, now = Date.now()): GifLoadFailure {
  if (error instanceof RateLimitError) {
    const seconds = Number(error.retryAfter);
    return { kind: 'rateLimit', retryAt: now + (Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : 60) * 1_000 };
  }
  return { kind: 'load' };
}

export function GifLoadError({ failure, onRetry }: { failure: GifLoadFailure; onRetry: () => void }) {
  const { t } = useTranslation(['chat', 'common']);
  const [now, setNow] = useState(Date.now);
  const retryIn = failure.kind === 'rateLimit' ? Math.max(0, Math.ceil((failure.retryAt - now) / 1_000)) : 0;
  useEffect(() => {
    setNow(Date.now());
    if (failure.kind !== 'rateLimit') return;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= failure.retryAt) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [failure]);
  return (
    <div className="p-3 text-center text-sm text-txt-secondary" role="alert">
      <p>{failure.kind === 'rateLimit'
        ? retryIn > 0 ? t('chat:gif.rateLimited', { seconds: retryIn }) : t('chat:gif.retryReady')
        : t('chat:gif.loadFailed')}</p>
      <button type="button" disabled={retryIn > 0} onClick={onRetry} className="mt-2 rounded-md px-3 py-1.5 text-txt-primary hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50">{t('common:actions.retry')}</button>
    </div>
  );
}
