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
  errorMessage?: string;
}

export function AnimatedImage(props: AnimatedImageProps) {
  return <ImageSurface key={props.src} {...props} />;
}

function ImageSurface({ src, fallbackSrc, alt, className = '', style, fit = 'cover', onLoad, onError, onClick, stickerSource, errorMessage }: AnimatedImageProps) {
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
    // A streaming GIF can already show frames before its load event fires.
    // Let the browser finish or report a real network error; a wall-clock
    // timeout would discard useful bytes and restart the same slow download.
    let initialized = false;
    let painted = false;
    let inViewport = true;
    // An interaction owns a finite run even after the pointer/focus leaves.
    // Keeping the request while decoding also covers a brief hover before load.
    let run: 'autoplay' | 'interaction' | null = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.hidden ? null : 'autoplay';
    const canPlay = () => run !== null && inViewport && !document.hidden;
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
      run = null;
      clearTimeout(fallbackTimer);
      player?.pause();
      if (!painted) snapshot();
      setPhase('paused');
    };
    const fallback = () => {
      if (controller.signal.aborted) return;
      player?.dispose();
      player = null;
      painted = false;
      clearTimeout(fallbackTimer);
      if (!canPlay()) { freeze(); return; }
      setCanvasVisible(false);
      setMode('native');
      setPhase('playing');
      // Native images expose no loop boundary; allow a bounded continuation
      // after hover rather than interrupting or looping forever.
      fallbackTimer = setTimeout(freeze, 8_000);
    };
    load.current = () => {
      callbacks.current.onLoad?.();
      loaded = true;
      if (initialized) return;
      initialized = true;
      // Keep the loaded native image visible until a decoded frame is painted.
      // A slow/CORS-blocked decode must never leave a blank preview.
      if (canPlay()) fallbackTimer = setTimeout(freeze, 8_000);
      else freeze();
      if (!supportsImageAnimation()) {
        fallback();
        return;
      }
      void openImageAnimation(mediaSrc, drawing, {
        onPaint: () => { if (!controller.signal.aborted) { painted = true; clearTimeout(fallbackTimer); setCanvasVisible(true); setMode('decoded'); setPhase('playing'); } },
        onFinish: () => { run = null; if (!controller.signal.aborted) setPhase('paused'); },
        onError: fallback,
      }, controller.signal).then((opened) => {
        if (controller.signal.aborted) { opened.dispose(); return; }
        player = opened;
        if (canPlay()) player.play(run === 'interaction' ? 2 : 3);
        else freeze();
      }).catch(() => { if (!controller.signal.aborted) fallback(); });
    };
    const enter = () => {
      if (run === 'interaction' || !inViewport || document.hidden) return;
      run = 'interaction';
      clearTimeout(fallbackTimer);
      if (!loaded) return;
      if (player) player.play(2);
      else fallback();
    };
    const stop = () => { run = null; if (loaded) freeze(); };
    const visibility = () => { if (document.hidden) stop(); };
    // Category/result buttons own the hover/focus, including their text overlay.
    const target = surface.closest('button') ?? surface;
    target.addEventListener('mouseenter', enter);
    target.addEventListener('focus', enter);
    document.addEventListener('visibilitychange', visibility);
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      inViewport = entries.some((entry) => entry.isIntersecting);
      if (!inViewport) {
        // An initially offscreen lazy image may still autoplay on first load.
        if (loaded || run === 'interaction') stop();
      }
    });
    observer?.observe(surface);
    return () => {
      controller.abort();
      clearTimeout(fallbackTimer);
      player?.dispose();
      observer?.disconnect();
      target.removeEventListener('mouseenter', enter);
      target.removeEventListener('focus', enter);
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
      {failed && <span role="alert" className="flex min-h-[80px] items-center justify-center bg-surface-elevated p-3 text-center text-xs text-txt-secondary">{errorMessage ?? t('gif.previewFailed')}</span>}
    </span>
  );
}
