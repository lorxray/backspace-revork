import { create } from 'zustand';

export interface CinemaTarget {
  identity: string;
  userId: string;
  channelId: string | null;
  dmCallId: string | null;
}

/** Local viewing state, never a room signal or a persisted stream subscription. */
export const useCinemaStore = create<{
  target: CinemaTarget | null;
  voiceVolume: number;
  open: (target: CinemaTarget) => void;
  close: () => void;
  setVoiceVolume: (volume: number) => void;
}>((set) => ({
  target: null,
  voiceVolume: 100,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
  setVoiceVolume: (volume) => set({ voiceVolume: Math.max(0, Math.min(200, volume)) }),
}));
