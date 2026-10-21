import { useTranslation } from 'react-i18next';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { isElectron } from '../../platform/platform';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { quickStartScreenShare } from '../../utils/quickStartScreenShare';

/** The desktop shortcut sits beside the source/settings button in both call bars. */
export function QuickStartStreamButton({ className }: { className: string }) {
  const { t } = useTranslation('voice');
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const isLiveKitConnected = useVoiceStore((s) => s.isLiveKitConnected);
  const voiceConnectionStatus = useVoiceStore((s) => s.voiceConnectionStatus);
  const connectionError = useVoiceStore((s) => s.connectionError);
  const isStarting = useScreenShareSetupStore((s) => s.isStarting);
  const isSetupOpen = useScreenShareSetupStore((s) => s.isOpen);

  if (!isElectron() || isScreenSharing) return null;

  const label = t(isStarting ? 'controls.startingStream' : 'controls.quickStartStream');
  const disabled = isStarting || isSetupOpen || !isLiveKitConnected
    || voiceConnectionStatus !== 'connected' || !!connectionError;

  const handleQuickStart = () => {
    const room = getActiveRoom();
    if (disabled || !room) return;
    void quickStartScreenShare(room);
  };

  return (
    <button
      type="button"
      onClick={handleQuickStart}
      className={`${className} disabled:opacity-40 disabled:cursor-not-allowed`}
      disabled={disabled}
      aria-label={label}
      aria-busy={isStarting || undefined}
      title={label}
    >
      {isStarting ? (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" className="animate-spin">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
          <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <rect x="2.5" y="3.5" width="19" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.7" />
          <path d="M9.5 7v6l5-3-5-3Z" fill="currentColor" />
          <path d="M9 20h6m-3-3.5V20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
