import type { ScreenShareConfig } from '../stores/voiceStore';

interface CaptureOptions {
  capture: { width: number; height: number; frameRate: number };
  publish: { videoEncoding: { maxBitrate: number } };
}

/** Small, source-content-free failure record consumed by the desktop logger. */
export function logScreenShareFailure(
  phase: 'capture' | 'video-publish' | 'audio-publish',
  error: unknown,
  config: ScreenShareConfig,
  options: CaptureOptions,
  stream?: MediaStream,
  source?: Pick<ElectronScreenSource, 'isScreen'> | null,
): void {
  // Diagnostics must never interrupt capture cleanup or replace its exception.
  try {
    const video = stream?.getVideoTracks()[0];
    const settings = video?.getSettings?.() ?? {};
    const audio = stream?.getAudioTracks() ?? [];
    const failure = error instanceof Error
      || (typeof DOMException !== 'undefined' && error instanceof DOMException) ? error : null;
    console.error('[ScreenShare:Diagnostic] ' + JSON.stringify({
      phase,
      codec: config.codec,
      sourceKind: source ? (source.isScreen ? 'monitor' : 'window') : 'unknown',
      requested: {
        ...options.capture,
        maxBitrate: options.publish.videoEncoding.maxBitrate,
        shareAudio: config.shareAudio,
      },
      capture: {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        displaySurface: settings.displaySurface,
      },
      audio: {
        present: audio.length > 0,
        live: audio.some(track => track.readyState === 'live'),
        enabled: config.shareAudio,
      },
      error: {
        name: failure?.name ?? 'Error',
        message: (failure?.message ?? (typeof error === 'string' ? error : 'Unknown screen-share failure')).slice(0, 3000),
      },
    }));
  } catch {
    // The original failure is still reported through the normal error path.
  }
}
