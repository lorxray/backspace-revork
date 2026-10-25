import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { openImageAnimation, supportsImageAnimation, type ImageAnimation } from '../../utils/imageAnimation';

interface AnimatedImageProps {
  src: string;
  fallbackSrc?: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
  fit?: 'cover' | 'contain';
  onClick?: () => void;
  stickerSource?: string;
  onLoad?: () => void;
  onError?: () => void;
}

export function AnimatedImage(props: AnimatedImageProps) {
  return <ImageSurface key={props.src} {...props} />;
}

function ImageSurface({ src, fallbackSrc, alt, className = '', style, fit = 'cover', onLoad, onError, onClick, stickerSource }: AnimatedImageProps) {
  const { t } = useTranslation('chat');
  const [usingFallback, setUsingFallback] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const mediaSrc = usingFallback && fallbackSrc ? fallbackSrc : src;
  const root = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const load = useRef<() => void>(() => {});
  const imageError = useRef<() => void>(() => {});
  const callbacks = useRef({ onLoad, onError });
  callbacks.current = { onLoad, onError };
  const [canvasVisible, setCanvasVisible] = useState(false);
  const [phase, setPhase] = useState('loading');
  const [mode, setMode] = useState('native');
  imageError.current = () => {
    if (!usingFallback && fallbackSrc && fallbackSrc !== src) { setUsingFallback(true); return; }
    setFailed(true); setPhase('error'); callbacks.current.onError?.();
  };

  useEffect(() => {
    const surface = root.current;
    const drawing = canvas.current;
    if (!surface || !drawing) return;
    setCanvasVisible(false);
    setPhase('loading');
    setMode('native');
    const controller = new AbortController();
    let player: ImageAnimation | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let loaded = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    const startLoadTimer = () => {
      clearTimeout(loadTimer);
      if (!loaded) loadTimer = setTimeout(() => imageError.current(), 15_000);
    };
    let initialized = false;
    let hovering = false;
    let painted = false;
    let autoplayFinished = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const snapshot = () => {
      const source = image.current;
      if (!source?.naturalWidth) return false;
      try {
        const context = drawing.getContext('2d');
        if (!context) return false;
        const scale = Math.min(1, 1024 / Math.max(source.naturalWidth, source.naturalHeight));
        drawing.width = Math.max(1, Math.round(source.naturalWidth * scale));
        drawing.height = Math.max(1, Math.round(source.naturalHeight * scale));
        context.drawImage(source, 0, 0, drawing.width, drawing.height);
        setCanvasVisible(true);
        return true;
      } catch { return false; }
    };
    const freeze = () => {
      clearTimeout(fallbackTimer);
      player?.pause();
      if (!painted) snapshot();
      setPhase('paused');
    };
    const fallback = () => {
      if (controller.signal.aborted) return;
      player?.dispose();
      player = null;
      clearTimeout(fallbackTimer);
      if (autoplayFinished && !hovering) { freeze(); return; }
      setCanvasVisible(false);
      setMode('native');
      setPhase('playing');
      if (!hovering) fallbackTimer = setTimeout(() => { autoplayFinished = true; freeze(); }, 8_000);
    };
    load.current = () => {
      clearTimeout(loadTimer);
      callbacks.current.onLoad?.();
      loaded = true;
      if (initialized) return;
      initialized = true;
      // Keep the loaded native image visible until a decoded frame is painted.
      // A slow/CORS-blocked decode must never leave a blank preview.
      if (!autoplayFinished) fallbackTimer = setTimeout(() => { autoplayFinished = true; freeze(); }, 8_000);
      else if (!hovering) freeze();
      if (!supportsImageAnimation()) {
        if (!autoplayFinished || hovering) fallback();
        else freeze();
        return;
      }
      void openImageAnimation(mediaSrc, drawing, {
        onPaint: () => { if (!controller.signal.aborted) { painted = true; clearTimeout(fallbackTimer); setCanvasVisible(true); setMode('decoded'); setPhase('playing'); } },
        onFinish: () => { autoplayFinished = true; if (!controller.signal.aborted) setPhase('paused'); },
        onError: fallback,
      }, controller.signal).then((opened) => {
        if (controller.signal.aborted) { opened.dispose(); return; }
        player = opened;
        if (hovering || !autoplayFinished) player.play(hovering ? 0 : 3);
        else freeze();
      }).catch(() => { if (!controller.signal.aborted) { if (hovering || !autoplayFinished) fallback(); else freeze(); } });
    };
    const enter = () => {
      hovering = true;
      autoplayFinished = true;
      clearTimeout(fallbackTimer);
      if (!loaded) return;
      if (player) player.play(0);
      else fallback();
    };
    const leave = () => { hovering = false; autoplayFinished = true; if (loaded) freeze(); };
    const visibility = () => { if (document.hidden) leave(); };
    // Category/result buttons own the hover/focus, including their text overlay.
    const target = surface.closest('button') ?? surface;
    target.addEventListener('mouseenter', enter);
    target.addEventListener('mouseleave', leave);
    target.addEventListener('focus', enter);
    target.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) startLoadTimer();
      else { clearTimeout(loadTimer); if (loaded) leave(); }
    });
    if (!observer) startLoadTimer();
    observer?.observe(surface);
    return () => {
      controller.abort();
      clearTimeout(loadTimer);
      clearTimeout(fallbackTimer);
      player?.dispose();
      observer?.disconnect();
      target.removeEventListener('mouseenter', enter);
      target.removeEventListener('mouseleave', leave);
      target.removeEventListener('focus', enter);
      target.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [mediaSrc, attempt]);

  useEffect(() => {
    if (!failed || attempt > 0) return;
    const timer = setTimeout(() => { setFailed(false); setAttempt(1); }, 1_500);
    return () => clearTimeout(timer);
  }, [failed, attempt]);

  const mediaClass = `block h-full max-h-[inherit] w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`;
  return (
    <span ref={root} className={`block overflow-hidden ${className}`} style={style} data-animation-state={phase} data-animation-mode={mode} data-image-source={stickerSource ?? src} data-image-alt={alt} data-sticker-source={stickerSource} onClick={(event) => {
      if (failed) { event.preventDefault(); event.stopPropagation(); setFailed(false); setAttempt((value) => value + 1); }
      else onClick?.();
    }}>
      <img key={`${mediaSrc}:${attempt}`} ref={image} src={failed ? undefined : mediaSrc} alt={alt} hidden={canvasVisible || failed} style={{ display: canvasVisible || failed ? 'none' : undefined }} className={mediaClass} loading="lazy" draggable={false} referrerPolicy="no-referrer" onLoad={() => { setFailed(false); load.current(); }} onError={() => imageError.current()} />
      <canvas ref={canvas} hidden={!canvasVisible} style={{ display: canvasVisible ? undefined : 'none' }} className={mediaClass} role={alt ? 'img' : undefined} aria-label={alt || undefined} aria-hidden={!canvasVisible || !alt} />
      {failed && <span className="flex min-h-[80px] items-center justify-center bg-surface-elevated p-3 text-center text-xs text-txt-secondary">{t('gif.previewFailed')}</span>}
    </span>
  );
}
