import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useCinemaStore, type CinemaTarget } from '../../stores/cinemaStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { usePointerReveal, VOICE_CHROME_ATTR } from '../../hooks/usePointerReveal';
import { useStreamViewerQuality } from '../../hooks/useStreamViewerQuality';
import { toggleMuteFromControl, getSpaceEnforcementState } from '../../utils/voiceActions';
import { StreamViewerQualityControls } from './StreamViewerQualityControls';

const controlClass = 'min-h-10 px-3 rounded-lg bg-white/10 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary text-sm';

function isolateBackground(root: HTMLElement): () => void {
  const saved: Array<{ element: HTMLElement; inert: boolean }> = [];
  let branch = root;
  while (branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        saved.push({ element: sibling, inert: sibling.inert === true });
        sibling.inert = true;
      }
    }
    if (branch.parentElement === document.body) break;
    branch = branch.parentElement;
  }
  return () => { for (const entry of saved) entry.element.inert = entry.inert; };
}

function CinemaPlayer({ target }: { target: CinemaTarget }) {
  const { t } = useTranslation('voice');
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Keep a stable portal parent: changing it during fullscreen would remount
  // the player and detach the remote video in the middle of the transition.
  const [container] = useState(() => document.fullscreenElement ?? document.body);
  const [hadNativeFullscreen] = useState(() => !!document.fullscreenElement);
  const [controlsFocused, setControlsFocused] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [ended, setEnded] = useState(false);
  const close = useCinemaStore(s => s.close);
  const voiceVolume = useCinemaStore(s => s.voiceVolume);
  const setVoiceVolume = useCinemaStore(s => s.setVoiceVolume);
  const participant = useVoiceStore(s => s.participants.find(p => p.identity === target.identity && p.userId === target.userId));
  const streamVolume = useVoiceStore(s => s.streamVolumes.get(target.userId) ?? 100);
  const streamMuted = useVoiceStore(s => s.streamMutes.get(target.userId) ?? false);
  const isMuted = useVoiceStore(s => s.isMuted);
  const { quality, options, setQuality } = useStreamViewerQuality(target.identity);
  const revealed = usePointerReveal(rootRef, true);
  const visible = revealed || controlsFocused || qualityOpen;
  const raw = participant?.screenTrack;
  const track = participant?.lkScreenTrack;

  useEffect(() => {
    const valid = () => {
      const state = useVoiceStore.getState();
      const current = state.participants.find(p => p.identity === target.identity && p.userId === target.userId && !p.isLocal);
      return state.isLiveKitConnected && state.currentVoiceChannelId === target.channelId
        && (state.activeDmCall?.federatedCallId ?? state.activeDmCall?.dmChannelId ?? null) === target.dmCallId
        && !!current?.isScreenSharing && state.watchingStreams.has(target.userId);
    };
    if (!valid()) { close(); return; }
    return useVoiceStore.subscribe(() => { if (!valid()) close(); });
  }, [target, close]);

  useEffect(() => {
    const video = videoRef.current;
    setEnded(raw?.readyState !== 'live');
    if (!video || !track || raw?.readyState !== 'live') return;
    const onEnded = () => setEnded(true);
    raw.addEventListener('ended', onEnded);
    track.attach(video);
    return () => {
      raw.removeEventListener('ended', onEnded);
      track.detach(video);
      video.srcObject = null;
    };
  }, [track, raw]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // Disable background interaction without unmounting audio pipelines.
    const restoreBackground = isolateBackground(root);
    const previousFocus = document.activeElement;
    let ownedNativeFullscreen = false;
    const fullscreenChange = () => {
      if (document.fullscreenElement === root) ownedNativeFullscreen = true;
      if (!document.fullscreenElement && (ownedNativeFullscreen || hadNativeFullscreen)) {
        useUIStore.getState().setVoiceFullscreen(false);
        close();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); }
    };
    document.addEventListener('fullscreenchange', fullscreenChange);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', fullscreenChange);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement === root) void document.exitFullscreen?.().catch(() => {});
      restoreBackground();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [close, hadNativeFullscreen]);

  const enforcement = getSpaceEnforcementState();
  return createPortal(
    <div ref={rootRef} data-cinema-player role="dialog" aria-modal="true" aria-label={t('cinema.title')} tabIndex={-1}
      className={`fixed inset-0 z-[500] overflow-hidden bg-black text-white outline-none ${visible ? '' : 'cursor-none'}`}
      style={{ width: 'calc(100 * var(--app-vw, 1vw))', height: 'calc(100 * var(--app-vh, 1vh))' }}
      onContextMenu={event => event.preventDefault()}
      onPointerMove={event => {
        if (event.target instanceof Element && !event.target.closest(`[${VOICE_CHROME_ATTR}]`)) setControlsFocused(false);
      }}
      onKeyDown={event => {
        setControlsFocused(true);
        if (event.key !== 'Tab') return;
        const buttons = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('*') ?? [])
          .filter(element => element.matches('button:not(:disabled), input:not(:disabled), [data-backspace-stream-zoom]'))
          .flatMap(element => element.shadowRoot
          ? Array.from(element.shadowRoot.querySelectorAll<HTMLElement>('button:not(:disabled)')) : [element]);
        if (!buttons?.length) return;
        const first = buttons[0], last = buttons[buttons.length - 1];
        const active = document.activeElement?.shadowRoot?.activeElement ?? document.activeElement;
        if (active === rootRef.current || (!event.shiftKey && active === last)) {
          event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && active === first) { event.preventDefault(); last?.focus(); }
      }}>
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain bg-black" />
      {(!track || ended) && <div role="status" className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">{t('cinema.waiting')}</div>}
      <div data-testid="cinema-controls" {...{ [VOICE_CHROME_ATTR]: '' }}
        className={`absolute bottom-0 inset-x-0 px-4 pt-12 pb-5 transition-opacity duration-300 bg-gradient-to-t from-black/95 via-black/60 to-transparent ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onFocusCapture={() => setControlsFocused(true)}
        onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setControlsFocused(false); }}>
        <div className="mx-auto max-w-6xl flex flex-wrap justify-center items-center gap-3">
          <div data-cinema-zoom />
          <button type="button" className={controlClass} aria-pressed={streamMuted}
            onClick={() => useVoiceStore.getState().setStreamMute(target.userId, !streamMuted)}>{t(streamMuted ? 'cinema.unmuteFilm' : 'cinema.muteFilm')}</button>
          <label className="flex items-center gap-2 text-xs text-white/80">
            <span>{t('cinema.filmVolume')}</span>
            <input type="range" min="0" max="200" value={streamVolume} className="w-24 accent-accent-primary"
              onChange={event => useVoiceStore.getState().setStreamVolume(target.userId, Number(event.target.value))} />
          </label>
          <label className="flex items-center gap-2 text-xs text-white/80">
            <span>{t('cinema.voiceVolume')}</span>
            <input type="range" min="0" max="200" value={voiceVolume} className="w-24 accent-accent-primary"
              onChange={event => setVoiceVolume(Number(event.target.value))} />
          </label>
          <StreamViewerQualityControls quality={quality} options={options} onQualityChange={setQuality} onOpenChange={setQualityOpen} />
          <button type="button" className={controlClass} disabled={enforcement.isSpaceMuted || enforcement.isSpaceDeafened}
            aria-pressed={isMuted} onClick={toggleMuteFromControl}>{t(isMuted ? 'controls.unmute' : 'controls.mute')}</button>
          <button type="button" className={controlClass} onClick={close}>{t('cinema.exit')}</button>
        </div>
      </div>
    </div>, container,
  );
}

export function CinemaMode() {
  const target = useCinemaStore(s => s.target);
  return target ? <CinemaPlayer key={target.identity} target={target} /> : null;
}
