// Dev-only visual QA of the real viewer control, without a microphone/call.
// ?lang=ru and ?scene=source select the language and single-layer fallback.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StreamViewerQualityControls } from '../components/voice/StreamViewerQualityControls';
import type { StreamViewerQualityChoice, StreamViewerQualityOption } from '../utils/streamViewerQuality';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const params = new URLSearchParams(location.search);
const sourceOnly = params.get('scene') === 'source';
const options: StreamViewerQualityOption[] = [
  { value: 'original', height: 1440, maxBitrate: 30_000_000 },
  ...sourceOnly ? [] : [
    { value: 'medium' as const, height: 1440, maxBitrate: 15_000_000 },
    { value: 'economy' as const, height: 1440, maxBitrate: 7_500_000 },
  ],
];

function Preview() {
  const [quality, setQuality] = useState<StreamViewerQualityChoice>('auto');
  return (
    <main className="min-h-screen p-4 desktop:p-10 flex flex-col items-center gap-4">
      <h1 className="text-lg font-semibold">Stream viewer · 1440p / 30 Mbps</h1>
      <div className="relative w-full max-w-[900px] min-h-[440px] rounded-xl bg-surface-channel ring-1 ring-border-hard flex items-center justify-center">
        <span className="text-txt-tertiary">2560 × 1440</span>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 p-3 bg-black/60 rounded-b-xl">
          <span className="text-white font-medium truncate">misha</span>
          <StreamViewerQualityControls quality={quality} options={options} onQualityChange={setQuality} />
        </div>
      </div>
      <output data-testid="selected-quality" className="text-sm text-txt-secondary">{quality}</output>
    </main>
  );
}

await initI18n({ browserLanguages: [params.get('lang') ?? 'ru'] });
initializeInterfaceScale();
createRoot(document.getElementById('root')!).render(<Preview />);
