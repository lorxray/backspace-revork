import React from 'react';
import { useTranslation } from 'react-i18next';
import { enterCinemaMode } from '../../utils/cinemaMode';

export function CinemaModeButton({ identity, className }: { identity?: string; className?: string }) {
  const { t } = useTranslation('voice');
  return <button type="button" className={className ?? 'min-h-9 px-2.5 rounded-lg border border-white/15 bg-black/60 text-white/90 hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary'}
    disabled={!identity} aria-label={t('cinema.enter')} title={t(identity ? 'cinema.enter' : 'cinema.chooseStream')}
    onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); if (identity) enterCinemaMode(identity); }}>
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4m-4 6h4m10-6h4m-4 6h4" />
    </svg>
  </button>;
}
