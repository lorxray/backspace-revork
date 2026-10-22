import { create } from 'zustand';

/**
 * Open/closed state of the screen-share setup screen (ScreenShareSetup).
 *
 * Settings and quick start share one synchronous start lock. A second click or
 * a keybind must not arm a second desktop source while capture is pending.
 */
interface ScreenShareSetupState {
  isOpen: boolean;
  isStarting: boolean;
  mode: 'start' | 'replace';
  open: (mode?: 'start' | 'replace') => void;
  close: () => void;
}

export const useScreenShareSetupStore = create<ScreenShareSetupState>((set, get) => ({
  isOpen: false,
  isStarting: false,
  mode: 'start',
  open: (mode = 'start') => { if (!get().isStarting) set({ isOpen: true, mode }); },
  close: () => set({ isOpen: false }),
}));

export function beginScreenShareStart(): boolean {
  if (useScreenShareSetupStore.getState().isStarting) return false;
  useScreenShareSetupStore.setState({ isStarting: true });
  return true;
}

export function finishScreenShareStart(): void {
  useScreenShareSetupStore.setState({ isStarting: false });
}

export function openScreenShareSetup(mode: 'start' | 'replace' = 'start'): void {
  useScreenShareSetupStore.getState().open(mode);
}

export function closeScreenShareSetup(): void {
  useScreenShareSetupStore.getState().close();
}
