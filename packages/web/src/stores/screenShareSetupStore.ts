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
  open: () => void;
  close: () => void;
}

export const useScreenShareSetupStore = create<ScreenShareSetupState>((set, get) => ({
  isOpen: false,
  isStarting: false,
  open: () => { if (!get().isStarting) set({ isOpen: true }); },
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

export function openScreenShareSetup(): void {
  useScreenShareSetupStore.getState().open();
}

export function closeScreenShareSetup(): void {
  useScreenShareSetupStore.getState().close();
}
