import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { appHistoryOffset, updateAppHistory, type AppHistory } from '../../utils/appNavigationHistory';

export function NavigationButtons() {
  const { t } = useTranslation('common');
  const location = useLocation();
  const action = useNavigationType();
  const navigate = useNavigate();
  const entry = { key: location.key, href: location.pathname + location.search + location.hash };
  const [history, setHistory] = useState<AppHistory>(() => ({ entries: [entry], index: 0 }));
  // A matching key identifies the real BrowserRouter stack. Memory/custom
  // routers can have a separate history from the containing browser window.
  const retainedEntries = window.history.state?.key === entry.key ? window.history.length : Infinity;
  const updated = updateAppHistory(history, action, entry, retainedEntries);
  // Adjust during render so a newly committed route never exposes stale button
  // bounds for a frame. The location guard makes this update converge immediately.
  if (updated !== history) setHistory(updated);
  const back = appHistoryOffset(updated, -1);
  const forward = appHistoryOffset(updated, 1);
  const pending = useRef(false);
  useEffect(() => { pending.current = false; }, [location.key, entry.href]);

  const move = useCallback((offset: number | null) => {
    if (offset === null || pending.current) return;
    pending.current = true;
    void navigate(offset);
  }, [navigate]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      // Stop native back navigation at our boundary too.
      event.preventDefault();
      if (!event.repeat) move(event.key === 'ArrowLeft' ? back : forward);
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [back, forward, move]);

  const buttonClass = 'titlebar-no-drag flex h-6 w-6 items-center justify-center rounded text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary disabled:text-txt-tertiary disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary';
  return (
    <nav aria-label={t('navigation.label')} className="titlebar-no-drag flex h-8 items-center gap-1 px-2">
      <button type="button" className={buttonClass} disabled={back === null} onClick={() => move(back)}
        aria-label={t('navigation.back')} title={t('navigation.backTooltip')} aria-keyshortcuts="Alt+ArrowLeft">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5m6-6-6 6 6 6" />
        </svg>
      </button>
      <button type="button" className={buttonClass} disabled={forward === null} onClick={() => move(forward)}
        aria-label={t('navigation.forward')} title={t('navigation.forwardTooltip')} aria-keyshortcuts="Alt+ArrowRight">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h14m-6-6 6 6-6 6" />
        </svg>
      </button>
    </nav>
  );
}
