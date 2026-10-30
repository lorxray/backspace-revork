// Standalone titlebar/history workbench. No account, API, microphone or call.
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useNavigate } from 'react-router-dom';
import { DesktopTitleBar } from '../components/layout/DesktopTitleBar';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import { useInterfaceScaleStore } from '../stores/interfaceScaleStore';
import '../styles/globals.css';

window.backspace = { platform: 'win32' } as BackspaceElectronAPI;
const params = new URLSearchParams(location.search);
useInterfaceScaleStore.getState().setScale(Number(params.get('scale') ?? 100));
initializeInterfaceScale();
await initI18n({ browserLanguages: ['ru'] });
window.history.replaceState(window.history.state, '', '/channels/@me');

function Preview() {
  const navigate = useNavigate();
  const location = useLocation();
  return <div className="flex flex-col h-screen bg-surface-base">
    <DesktopTitleBar />
    <div className="p-8 flex flex-col gap-4 text-txt-primary">
      <div className="flex gap-4">
        <button className="glass px-4 py-2 rounded" onClick={() => navigate('/channels/demo/general')}>General</button>
        <button className="glass px-4 py-2 rounded" onClick={() => navigate('/channels/@me/person')}>DM</button>
        <button className="glass px-4 py-2 rounded" onClick={() => navigate('/explore')}>Explore</button>
      </div>
      <output data-testid="navigation-path">{location.pathname}</output>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Preview /></BrowserRouter>);
