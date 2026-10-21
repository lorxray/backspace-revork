// Development-only visual QA using the real sidebars and call controls.
// No microphone, screen capture, account or server connection is started here.
import type { CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';
import { ChannelSidebar } from '../components/layout/ChannelSidebar';
import { SpaceSidebar } from '../components/layout/SpaceSidebar';
import { SidebarResizeHandle } from '../components/layout/SidebarResizeHandle';
import { VoiceControlBar } from '../components/voice/VoiceControlBar';
import { useSidebarWidth } from '../hooks/useSidebarWidth';
import { useAuthStore } from '../stores/authStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useUIStore } from '../stores/uiStore';
import { useScreenShareSetupStore } from '../stores/screenShareSetupStore';
import { useSidebarWidthStore } from '../stores/sidebarWidthStore';
import { useInterfaceScaleStore } from '../stores/interfaceScaleStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const params = new URLSearchParams(location.search);
window.backspace = {
  platform: 'win32',
  getScreenSources: async () => [],
  getScreenSharePickerMode: async () => 'app',
} as unknown as BackspaceElectronAPI;

useAuthStore.setState({ user: {
  id: 'preview-self', username: 'misha', displayName: 'Миша', avatar: null, banner: null,
  avatarColor: 'mint', accentColor: null, bio: null, status: 'online', customStatus: null,
  isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
} as User });
useSpaceStore.setState({ spaces: [], currentSpaceId: null, channels: [], dmChannels: [] });
useVoiceStore.setState({
  activeDmCall: { dmChannelId: 'preview-dm', federatedCallId: null, callOrigin: null, livekit: null },
  isLiveKitConnected: true, voiceConnectionStatus: 'connected', connectionError: null,
  isScreenSharing: params.get('scene') === 'live',
});
useUIStore.setState({ showDms: true, voiceFullscreen: true });
if (params.has('width')) useSidebarWidthStore.getState().setWidth(Number(params.get('width')));
if (params.has('scale')) useInterfaceScaleStore.getState().setScale(Number(params.get('scale')));
if (params.get('scene') === 'pending') useScreenShareSetupStore.setState({ isStarting: true });

function Preview() {
  const sidebar = useSidebarWidth();
  return (
    <MemoryRouter initialEntries={['/channels/@me']}>
      <div className="h-screen flex flex-col">
        <header className="flex-shrink-0 px-4 flex items-center text-xs text-txt-tertiary border-b border-border-hard" style={{ height: 'var(--titlebar-inset)' }}>Backspace</header>
        <div
          className="flex-1 min-h-0 grid grid-cols-[var(--sidebar-width)_minmax(0,1fr)]"
          style={{ '--sidebar-width': `${sidebar.width}px` } as CSSProperties}
        >
          <aside className="relative flex min-h-0" id="desktop-channel-sidebar">
            <SpaceSidebar />
            <ChannelSidebar />
            <SidebarResizeHandle {...sidebar} />
          </aside>
          <main className="relative min-w-0 flex flex-col bg-surface-chat">
            <header className="h-12 border-b border-border-hard px-5 flex items-center font-semibold">Клиентские настройки</header>
            <div className="p-8 flex-1 flex flex-col gap-4">
              <p className="text-txt-secondary">Потяните правую границу левой панели.</p>
              <output data-testid="sidebar-width" className="text-txt-tertiary">{sidebar.width}px</output>
            </div>
            <VoiceControlBar revealed />
          </main>
        </div>
      </div>
    </MemoryRouter>
  );
}

await initI18n({ browserLanguages: [params.get('lang') ?? 'ru'] });
initializeInterfaceScale();
createRoot(document.getElementById('root')!).render(<Preview />);
