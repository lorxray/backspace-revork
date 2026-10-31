// Standalone UI workbench: real voice rows, no account, API, microphone or call.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VoiceChannel } from '../components/voice/VoiceChannel';
import { useVoiceStore } from '../stores/voiceStore';
import { initI18n } from '../i18n';
import '../styles/globals.css';

await initI18n({ browserLanguages: ['ru'] });
useVoiceStore.setState({
  currentVoiceChannelId: null,
  voiceUsers: new Map([['long', ['Участник']]]),
  voiceChannelElapsedSeconds: new Map([['long', { elapsedSeconds: 3665, observedAt: Date.now() }]]),
});

function Preview() {
  const [unread, setUnread] = useState(true);
  const [chatOpen, setChatOpen] = useState(false);
  const [action, setAction] = useState('Ожидание действия');
  function openChat() {
    setUnread(false);
    setChatOpen(true);
    setAction('Открыт только чат');
  }
  return <main className="p-8 space-y-6">
    <h1 className="text-xl font-bold">Действия голосового канала</h1>
    <div className="flex flex-wrap gap-8">
      {[248, 320].map(width => <section key={width} style={{ width }} className="space-y-2">
        <h2 className="text-sm text-txt-tertiary">{width} px</h2>
        <div className="bg-surface-channel p-2 rounded-lg space-y-1" data-preview-width={width}>
          <VoiceChannel channelId="unread" channelName="кубики" onClick={() => setAction('Подключение к голосу')}
            onOpenChat={openChat} canManage onSettingsClick={() => setAction('Настройки')}
            isUnread={unread} isChatOpen={chatOpen} />
          <VoiceChannel channelId="long" channelName="Очень длинное название голосового канала" onClick={() => setAction('Подключение к голосу')}
            onOpenChat={() => setAction('Чат длинного канала')} canManage onSettingsClick={() => setAction('Настройки')} />
          <VoiceChannel channelId="guest" channelName="Без права настройки" onClick={() => setAction('Подключение к голосу')}
            onOpenChat={() => setAction('Чат без прав настройки')} isUnread />
          <VoiceChannel channelId="locked" channelName="Закрытый войс" onClick={() => {}}
            onOpenChat={() => setAction('Чат закрытого войса')} locked canManage onSettingsClick={() => setAction('Настройки')} />
        </div>
      </section>)}
    </div>
    <div className="flex gap-4">
      <button className="rounded bg-surface-elevated px-3 py-2" onClick={() => { setUnread(true); setChatOpen(false); }}>Новое сообщение</button>
      <output className="text-sm text-txt-secondary" aria-live="polite">{action}</output>
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Preview />);
