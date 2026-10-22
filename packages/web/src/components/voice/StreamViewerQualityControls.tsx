import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useFormatters } from '../../i18n/formatters';
import type { StreamViewerQualityChoice, StreamViewerQualityOption } from '../../utils/streamViewerQuality';

export type { StreamViewerQualityChoice, StreamViewerQualityOption } from '../../utils/streamViewerQuality';

interface StreamViewerQualityControlsProps {
  quality: StreamViewerQualityChoice;
  options: readonly StreamViewerQualityOption[];
  onQualityChange: (quality: StreamViewerQualityChoice) => void;
  onOpenChange?: (open: boolean) => void;
}

const QUALITY_KEYS = {
  auto: 'voice:viewerQuality.auto',
  original: 'voice:viewerQuality.original',
  medium: 'voice:viewerQuality.medium',
  economy: 'voice:viewerQuality.economy',
} as const;

/** A viewer's local subscription preference; publishing controls stay separate. */
export function StreamViewerQualityControls({ quality, options, onQualityChange, onOpenChange }: StreamViewerQualityControlsProps) {
  const { t } = useTranslation(['voice', 'common']);
  const f = useFormatters();
  const [open, setOpen] = useState(false);
  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const menuId = useId();
  const titleId = useId();
  const { style } = useFloatingPosition(triggerRef, menuRef, {
    placement: 'top',
    align: 'end',
    offset: 10,
    enabled: open,
  });
  const sourceOptions: readonly StreamViewerQualityOption[] = options.length ? options : [{ value: 'original' }];
  const selectedQuality = quality === 'auto' || sourceOptions.some((option) => option.value === quality)
    ? quality : 'auto';

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const isInside = (target: EventTarget | null) => target instanceof Node
      && (triggerRef.current?.contains(target) || menuRef.current?.contains(target));
    const handleOutside = (event: PointerEvent) => {
      if (!isInside(event.target)) setOpen(false);
    };
    const handleFocus = (event: FocusEvent) => {
      if (!isInside(event.target)) setOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('focusin', handleFocus);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('focusin', handleFocus);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [open]);

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const description = (option: StreamViewerQualityOption) => {
    const parts: string[] = [];
    if (option.height && option.fps) {
      parts.push(t('voice:stream.qualityValue', { height: option.height, fps: option.fps }));
    } else if (option.height) {
      parts.push(t('voice:viewerQuality.resolution', { height: option.height }));
    }
    if (option.maxBitrate) {
      const bitrate = t('common:units.kbps', { value: f.formatNumber(Math.round(option.maxBitrate / 1000)) });
      parts.push(t('voice:viewerQuality.bitrateLimit', { bitrate }));
    }
    return parts.join(' · ') || t('voice:viewerQuality.sourceDescription');
  };

  const choices: { value: StreamViewerQualityChoice; detail: string }[] = [
    { value: 'auto', detail: t('voice:viewerQuality.autoDescription') },
    ...sourceOptions.map((option) => ({ value: option.value, detail: description(option) })),
  ];

  return (
    <div
      className="flex-shrink-0"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('voice:viewerQuality.buttonLabel', { quality: t(QUALITY_KEYS[selectedQuality]) })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="min-h-9 [@media(pointer:coarse)]:min-h-11 flex items-center justify-center gap-1.5 px-2.5 rounded-lg border border-white/15 bg-black/60 text-white/90 hover:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary text-xs font-medium transition-colors"
      >
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M4 7h16M4 17h16" />
          <circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none" />
          <circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none" />
        </svg>
        <span>{t('voice:viewerQuality.button')}</span>
        <span className="hidden desktop:inline text-white/60">· {t(QUALITY_KEYS[selectedQuality])}</span>
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className={open ? '' : 'rotate-180'}>
          <path d="m7 14 5-5 5 5z" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={titleId}
          onKeyDown={handleMenuKeyDown}
          style={style}
          className="w-[276px] max-w-[calc(calc(100*var(--app-vw))-16px)] max-h-[calc(calc(100*var(--app-vh))-16px)] overflow-y-auto scrollbar-thin glass border border-border-hard rounded-xl p-1.5 shadow-xl"
        >
          <div id={titleId} className="px-2.5 pt-2 pb-2.5 text-sm font-semibold text-txt-primary">{t('voice:viewerQuality.title')}</div>
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={selectedQuality === choice.value}
              tabIndex={-1}
              onClick={() => {
                onQualityChange(choice.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className={`w-full min-h-[54px] px-2.5 py-2 rounded-lg text-left flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary ${selectedQuality === choice.value ? 'bg-accent-primary/15' : 'hover:bg-interactive-hover'}`}
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[13px] font-medium text-txt-primary">{t(QUALITY_KEYS[choice.value])}</span>
                <span className="block text-xs text-txt-secondary mt-0.5">{choice.detail}</span>
              </span>
              {selectedQuality === choice.value && (
                <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-accent-primary">
                  <path d="m5 12 4 4L19 6" />
                </svg>
              )}
            </button>
          ))}
          <p className="border-t border-border-hard mx-1 mt-1.5 px-1.5 pt-2.5 pb-1.5 text-xs text-txt-secondary">
            {t(options.length > 1 ? 'voice:viewerQuality.localOnly' : 'voice:viewerQuality.sourceOnly')}
          </p>
        </div>,
        portalContainer,
      )}
    </div>
  );
}
