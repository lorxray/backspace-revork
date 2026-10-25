import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VoiceVibeGifPicker } from './VoiceVibeGifPicker';
import { Modal } from '../ui/Modal';
import { AnimatedImage } from '../ui/AnimatedImage';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { describeError } from '../../i18n/errors';
import {
  normalizeVibeUrl, readRecentVoiceVibes, readVoiceChannelVibe, rememberVoiceVibe,
  topicWithoutVoiceChannelVibe, topicWithVoiceChannelVibe,
} from '../../utils/voiceChannelVibe';

interface VoiceChannelVibeProps {
  channelId: string;
  topic: string | null;
  canManage: boolean;
}

function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="m3 17 5-5 4 4 4-6 5 7" />
    </svg>
  );
}

export function VoiceChannelVibe({ channelId, topic, canManage }: VoiceChannelVibeProps) {
  const { t } = useTranslation('voice');
  const vibe = readVoiceChannelVibe(topic);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removingRef = useRef(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const remove = async () => {
    if (!canManage || removingRef.current) return;
    const latest = useSpaceStore.getState().channels.find((channel) => channel.id === channelId);
    if (!latest || latest.type !== 'voice' || !readVoiceChannelVibe(latest.topic)) return;
    removingRef.current = true;
    setRemoving(true);
    try {
      await useSpaceStore.getState().updateChannel(channelId, { topic: topicWithoutVoiceChannelVibe(latest.topic) });
    } catch (error) {
      useUIStore.getState().addToast(describeError(error), 'warning');
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  };

  if (!vibe && !canManage) return null;

  return (
    <>
      {vibe ? (
        <div className="group/vibe relative ml-9 mr-2 mt-1 mb-1 overflow-hidden rounded-lg bg-surface-elevated" data-testid="voice-channel-vibe">
          {failedUrl === vibe.url ? (
            <div className="flex aspect-video items-center justify-center gap-2 px-3 text-xs text-txt-tertiary" role="status">
              <ImageIcon />{t('vibe.imageFailed')}
            </div>
          ) : (
            <AnimatedImage
              src={vibe.url}
              alt={t('vibe.imageAlt')}
              className="aspect-video w-full object-contain"
              fit="contain"
              onError={() => setFailedUrl(vibe.url)}
            />
          )}
          {canManage && (
            <div className="absolute right-1 top-1 flex gap-0.5 rounded-md bg-black/65 p-0.5 desktop:opacity-0 desktop:group-hover/vibe:opacity-100 desktop:group-focus-within/vibe:opacity-100 transition-opacity">
              <button type="button" onClick={() => setEditing(true)} disabled={removing} title={t('vibe.change')} aria-label={t('vibe.change')} className="flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-50">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z" /><path d="m14 5 5 5" /></svg>
              </button>
              <button type="button" onClick={() => { void remove(); }} disabled={removing} title={t('vibe.remove')} aria-label={t('vibe.remove')} className="flex h-7 w-7 items-center justify-center rounded text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-50">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
              </button>
            </div>
          )}
        </div>
      ) : (
        <button type="button" onClick={() => setEditing(true)} className="ml-9 mt-0.5 mb-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary transition-colors">
          <ImageIcon />{t('vibe.set')}
        </button>
      )}
      {editing && canManage && (
        <VoiceVibeEditor channelId={channelId} initialUrl={vibe?.url ?? ''} onClose={() => setEditing(false)} />
      )}
    </>
  );
}

function VoiceVibeEditor({ channelId, initialUrl, onClose }: { channelId: string; initialUrl: string; onClose: () => void }) {
  const { t } = useTranslation(['voice', 'common']);
  const gifEnabled = useSettingsStore((state) => state.gifEnabled);
  const [url, setUrl] = useState(initialUrl);
  const [tab, setTab] = useState<'link' | 'gif'>(gifEnabled ? 'gif' : 'link');
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [recents] = useState(readRecentVoiceVibes);
  const previewUrl = normalizeVibeUrl(url);
  const previewFailed = !!previewUrl && failedUrl === previewUrl;

  const select = (selected: string) => {
    setUrl(selected);
    setError('');
    setTab('link');
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving.current || !previewUrl || loadedUrl !== previewUrl || previewFailed) return;
    const latest = useSpaceStore.getState().channels.find((channel) => channel.id === channelId);
    if (!latest || latest.type !== 'voice') return;
    const topic = topicWithVoiceChannelVibe(latest.topic, previewUrl);
    if (!topic) {
      setError(t('voice:vibe.tooLong'));
      return;
    }
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      await useSpaceStore.getState().updateChannel(channelId, { topic });
      rememberVoiceVibe(previewUrl);
      onClose();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('voice:vibe.set')} maxWidth="max-w-lg" mobileStyle="sheet">
      <p className="mb-4 text-sm text-txt-secondary">{t('voice:vibe.description')}</p>
      <div className="mb-4 flex gap-2" role="tablist" aria-label={t('voice:vibe.source')}>
        {(['gif', 'link'] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} disabled={busy} onClick={() => setTab(value)} className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${tab === value ? 'bg-interactive-selected text-txt-primary' : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-primary'}`}>
            {t(value === 'link' ? 'voice:vibe.linkTab' : 'voice:vibe.gifTab')}
          </button>
        ))}
      </div>
      {tab === 'gif' ? (
        <div className="flex h-[min(390px,calc(45*var(--app-vh)))] min-h-0 flex-col overflow-hidden rounded-lg border border-border-soft">
          {gifEnabled ? <VoiceVibeGifPicker onGifSelect={select} /> : (
            <p className="m-auto max-w-sm px-4 text-center text-sm text-txt-secondary">{t('voice:vibe.searchDisabled')}</p>
          )}
        </div>
      ) : (
        <form onSubmit={(event) => { void save(event); }} className="space-y-3">
          <div>
            <label htmlFor="voice-vibe-url" className="mb-1.5 block text-xs font-bold text-txt-secondary">{t('voice:vibe.urlLabel')}</label>
            <input id="voice-vibe-url" type="url" value={url} onChange={(event) => select(event.target.value)} autoFocus disabled={busy} className="input-search w-full" aria-describedby="voice-vibe-url-hint" />
            <p id="voice-vibe-url-hint" className="mt-1.5 text-xs text-txt-tertiary">{t('voice:vibe.urlHint')}</p>
          </div>
          {previewUrl && (
            <div className="overflow-hidden rounded-lg bg-surface-elevated">
              <AnimatedImage key={previewUrl} src={previewUrl} alt={t('voice:vibe.preview')} fit="contain" className={`max-h-44 w-full ${previewFailed ? 'hidden' : ''}`} onLoad={() => { setLoadedUrl(previewUrl); setFailedUrl(null); }} onError={() => setFailedUrl(previewUrl)} />
              {previewFailed && <p className="p-4 text-sm text-txt-danger" role="alert">{t('voice:vibe.imageFailed')}</p>}
            </div>
          )}
          {url.trim() && !previewUrl && <p className="text-sm text-txt-danger" role="alert">{t('voice:vibe.invalidUrl')}</p>}
          {error && <p className="text-sm text-txt-danger" role="alert">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-txt-secondary hover:bg-interactive-hover">{t('common:actions.cancel')}</button>
            <button type="submit" disabled={busy || !previewUrl || loadedUrl !== previewUrl || previewFailed} className="rounded-md bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">{t(busy ? 'common:states.saving' : 'common:actions.save')}</button>
          </div>
        </form>
      )}
      {recents.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-bold text-txt-secondary">{t('voice:vibe.recent')}</p>
          <div className="grid grid-cols-3 gap-2">
            {recents.map((recent, index) => (
              <button key={recent} type="button" disabled={busy} onClick={() => select(recent)} aria-label={t('voice:vibe.selectRecent', { number: index + 1 })} className="overflow-hidden rounded-md bg-surface-elevated hover:ring-2 hover:ring-accent-primary disabled:opacity-50">
                <AnimatedImage src={recent} alt="" className="aspect-video w-full" />
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
