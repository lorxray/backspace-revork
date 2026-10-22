import { flushSync } from 'react-dom';
import { useCinemaStore } from '../stores/cinemaStore';
import { useVoiceStore } from '../stores/voiceStore';

/** Called from the viewer's click so native fullscreen retains user activation. */
export function enterCinemaMode(identity: string): void {
  const state = useVoiceStore.getState();
  const participant = state.participants.find(p => p.identity === identity && !p.isLocal);
  if (!participant?.isScreenSharing || !state.watchingStreams.has(participant.userId) || !state.isLiveKitConnected) return;
  const target = {
    identity, userId: participant.userId, channelId: state.currentVoiceChannelId,
    dmCallId: state.activeDmCall?.federatedCallId ?? state.activeDmCall?.dmChannelId ?? null,
  };
  flushSync(() => useCinemaStore.getState().open(target));
  const player = document.querySelector<HTMLElement>('[data-cinema-player]');
  player?.focus({ preventScroll: true });
  if (!player || document.fullscreenElement || typeof player.requestFullscreen !== 'function') return;
  try {
    void player.requestFullscreen().then(() => {
      // A pending native request cannot bring back a player already closed.
      if (useCinemaStore.getState().target !== target && document.fullscreenElement === player) {
        void document.exitFullscreen().catch(() => {});
      }
    }).catch(() => {}); // The same player remains usable as an in-window overlay.
  } catch { /* Platforms without generic native fullscreen keep the overlay. */ }
}
