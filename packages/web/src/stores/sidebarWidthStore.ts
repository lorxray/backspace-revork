import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Total left column, including the fixed 72px space strip. */
export const DEFAULT_SIDEBAR_WIDTH = 312;
export const MIN_SIDEBAR_WIDTH = 280;
export const MAX_SIDEBAR_WIDTH = 520;

export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)));
}

interface SidebarWidthState {
  width: number;
  setWidth: (width: number) => void;
}

export const useSidebarWidthStore = create<SidebarWidthState>()(persist(
  set => ({
    width: DEFAULT_SIDEBAR_WIDTH,
    setWidth: width => set({ width: normalizeSidebarWidth(width) }),
  }),
  {
    name: 'backspace-sidebar-width',
    partialize: state => ({ width: state.width }),
    merge: (stored, current) => ({
      ...current,
      width: normalizeSidebarWidth((stored as Partial<SidebarWidthState> | undefined)?.width),
    }),
  },
));
