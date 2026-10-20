import { useVoiceStore } from '../stores/voiceStore';
import type { StreamViewerQualityChoice, StreamViewerQualityOption } from '../utils/streamViewerQuality';

const NO_OPTIONS: readonly StreamViewerQualityOption[] = [];

export function useStreamViewerQuality(identity: string) {
  const quality = useVoiceStore((state) => state.streamViewerQualities.get(identity) ?? 'auto');
  const options = useVoiceStore((state) => state.streamViewerQualityOptions.get(identity) ?? NO_OPTIONS);
  const setStreamViewerQuality = useVoiceStore((state) => state.setStreamViewerQuality);
  // A republish may offer fewer layers. Keep the preference for a resumed
  // compatible publication, but label the currently available choice honestly.
  const effectiveQuality = quality === 'auto' || options.some((option) => option.value === quality)
    ? quality : 'original';
  return {
    quality: effectiveQuality,
    options,
    setQuality: (choice: StreamViewerQualityChoice) => setStreamViewerQuality(identity, choice),
  };
}
