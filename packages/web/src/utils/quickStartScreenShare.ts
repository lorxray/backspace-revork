import { ConnectionState, type Room } from 'livekit-client';
import { getActiveRoom } from '../hooks/useLiveKit';
import { getElectronAPI, isElectron } from '../platform/platform';
import {
  beginScreenShareStart, finishScreenShareStart, openScreenShareSetup, useScreenShareSetupStore,
} from '../stores/screenShareSetupStore';
import { useVoiceStore } from '../stores/voiceStore';
import { getLastScreenShareSource, matchesLastScreenShareSource, rememberScreenShareSource } from './lastScreenShareSource';
import { publishScreenShare, stageScreenCapture, stopStagedCapture } from './screenShare';
import { broadcastVoiceStatus } from './voice';

/** Start only the last successful desktop source, otherwise ask the user to choose. */
export async function quickStartScreenShare(room: Room): Promise<void> {
  const voice = useVoiceStore.getState();
  const setup = useScreenShareSetupStore.getState();
  if (voice.isScreenSharing || !voice.isLiveKitConnected || room.state !== ConnectionState.Connected
    || getActiveRoom() !== room || setup.isOpen || !beginScreenShareStart()) return;

  let abandoned = false;
  let fallback = false;
  let preselected = false;
  let stream: MediaStream | null = null;
  const api = getElectronAPI();
  const unsubscribe = useVoiceStore.subscribe((state) => {
    if (!state.isLiveKitConnected || getActiveRoom() !== room) abandoned = true;
  });
  const isCurrent = () => !abandoned && getActiveRoom() === room
    && room.state === ConnectionState.Connected && useVoiceStore.getState().isLiveKitConnected
    && !useScreenShareSetupStore.getState().isOpen;
  try {
    const savedConfig = voice.lastSuccessfulScreenShareConfig;
    if (savedConfig) useVoiceStore.getState().setScreenShareConfig(savedConfig);
    const savedSource = getLastScreenShareSource();
    // Browser/portal permission and old desktop pickers keep their normal user
    // gesture flow. Merely clicking quick start must never choose another source.
    if (!savedConfig || !savedSource || !isElectron() || !api?.getScreenSources
      || !api.preselectScreenSource || !api.getScreenSharePickerMode) {
      fallback = true;
      return;
    }
    if (await api.getScreenSharePickerMode() !== 'app') { fallback = true; return; }
    if (!isCurrent()) return;
    const sources = await api.getScreenSources();
    if (!isCurrent()) return;
    const source = sources.find((candidate) => matchesLastScreenShareSource(candidate, savedSource));
    if (!source) {
      rememberScreenShareSource(null);
      fallback = true;
      return;
    }
    await api.preselectScreenSource(source.id, savedConfig.shareAudio);
    preselected = true;
    if (!isCurrent()) return;
    stream = await stageScreenCapture();
    preselected = false; // getDisplayMedia consumed the one-shot selection.
    if (!isCurrent()) return;
    const ok = await publishScreenShare(room, stream, {
      sourceId: source.id, source, pickerMode: 'app', isCurrent,
    });
    if (!ok) { fallback = true; return; }
    stream = null; // LiveKit now owns the capture.
    broadcastVoiceStatus();
  } catch {
    // A vanished source or denied capture needs the ordinary preview/chooser,
    // rather than an automatic retry with a different monitor or window.
    fallback = true;
  } finally {
    stopStagedCapture(stream);
    if (preselected) {
      try { await api?.preselectScreenSource?.(null); } catch { /* The desktop may be exiting. */ }
    }
    unsubscribe();
    finishScreenShareStart();
    if (fallback && isCurrent() && !useVoiceStore.getState().isScreenSharing) openScreenShareSetup();
  }
}
