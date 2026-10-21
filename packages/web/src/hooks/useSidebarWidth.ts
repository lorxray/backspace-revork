import { useCallback, useEffect, useState } from 'react';
import { useInterfaceScaleStore } from '../stores/interfaceScaleStore';
import {
  DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useSidebarWidthStore,
} from '../stores/sidebarWidthStore';

export function useSidebarWidth() {
  const preferredWidth = useSidebarWidthStore(state => state.width);
  const setPreferredWidth = useSidebarWidthStore(state => state.setWidth);
  const scale = useInterfaceScaleStore(state => state.scale);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Keep space for the conversation on small desktop windows. Clamping the
  // rendered width only restores the user's preference when the window grows.
  const maxWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.floor(viewportWidth / (scale / 100) - 400)));
  const width = Math.min(preferredWidth, maxWidth);
  const setWidth = useCallback((next: number) => {
    setPreferredWidth(Math.min(next, maxWidth));
  }, [maxWidth, setPreferredWidth]);
  const resetWidth = useCallback(() => setPreferredWidth(DEFAULT_SIDEBAR_WIDTH), [setPreferredWidth]);

  return { width, maxWidth, setWidth, resetWidth };
}
