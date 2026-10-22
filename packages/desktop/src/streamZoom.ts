/**
 * Runs in its own renderer world. Keep every runtime dependency inside this
 * function: main serializes the compiled function into the sandboxed renderer.
 * It enhances the existing stream video without replacing LiveKit's element.
 */
export function installStreamZoom(): () => void {
  const scope = window as Window & { backspaceStreamZoomCleanup?: () => void };
  scope.backspaceStreamZoomCleanup?.();

  type View = { scale: number; x: number; y: number };
  type Controller = { refresh: () => void; destroy: () => void; video: HTMLVideoElement };
  const controllers = new Map<HTMLElement, Controller>();
  const catalogs: Record<string, readonly [string, string, string, string, string]> = {
    en: ['Stream zoom', 'Zoom out', 'Reset zoom', 'Zoom in', 'Scroll to zoom · Drag to pan'],
    ru: ['Масштаб трансляции', 'Отдалить', 'Сбросить масштаб', 'Приблизить', 'Колесо — масштаб · Перетаскивание — перемещение'],
    de: ['Stream-Zoom', 'Verkleinern', 'Zoom zurücksetzen', 'Vergrößern', 'Scrollen zum Zoomen · Ziehen zum Verschieben'],
    pt: ['Zoom da transmissão', 'Diminuir zoom', 'Redefinir zoom', 'Aumentar zoom', 'Role para ampliar · Arraste para mover'],
    zh: ['直播缩放', '缩小', '重置缩放', '放大', '滚动以缩放 · 拖动以移动'],
  };

  function interfaceScale(): number {
    const root = getComputedStyle(document.documentElement);
    const value = Number.parseFloat(root.getPropertyValue('--interface-scale')) || Number.parseFloat(root.zoom);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function focusedStreams(): Map<HTMLElement, HTMLVideoElement> {
    const found = new Map<HTMLElement, HTMLVideoElement>();
    for (const caption of document.querySelectorAll('[data-testid="stream-tile-caption"]')) {
      const tile = caption.parentElement;
      const wrapper = tile?.parentElement;
      if (!tile?.hasAttribute('data-context-menu') || !wrapper) continue;
      // Focus mode has the Grid button alongside its tile. Grid and strip
      // wrappers contain only a tile; cameras and chat videos lack the caption.
      if (!Array.from(wrapper.children).some((child) => child.tagName === 'BUTTON')) continue;
      const video = Array.from(tile.children).find((child): child is HTMLVideoElement => child instanceof HTMLVideoElement);
      if (video) found.set(tile, video);
    }
    return found;
  }

  function preserveStyles(element: HTMLElement, properties: readonly string[]): () => void {
    const saved = properties.map((property) => ({
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    }));
    return () => {
      for (const { property, value, priority } of saved) {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      }
    };
  }

  function createController(tile: HTMLElement, video: HTMLVideoElement): Controller {
    let view: View = { scale: 1, x: 0, y: 0 };
    let drag: { id: number; x: number; y: number } | null = null;
    let source = video.srcObject;
    let sourceTracks = trackSignature();
    const originalTouchAction = tile.style.touchAction;
    const originalCursor = tile.style.cursor;
    let formatterLanguage = '';
    let percentageFormatter: Intl.NumberFormat;
    let requestedTransform = '';
    let appliedTransform = '';
    let hideControlsTimer: number | undefined;
    let controlsHovered = false;
    let controlsFocused = false;
    const restoreVideo = preserveStyles(video, ['transform', 'transform-origin', 'pointer-events']);
    const restoreTile = preserveStyles(tile, ['touch-action', 'cursor']);
    const host = document.createElement('div');
    host.setAttribute('data-backspace-stream-zoom', '');
    host.setAttribute('role', 'group');
    host.style.cssText = 'position:absolute;left:50%;transform:translateX(-50%);bottom:48px;z-index:10;transition:opacity .15s;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { color: #fff; font: 12px system-ui, sans-serif; }
      .controls { display:flex;align-items:center;gap:4px;padding:4px;border-radius:999px;
        background:rgba(20,20,26,.72);border:1px solid rgba(255,255,255,.1);
        backdrop-filter:blur(20px) saturate(120%);box-shadow:0 2px 8px rgba(0,0,0,.2); }
      button { all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
        width:32px;height:32px;border-radius:999px;cursor:pointer;color:rgba(255,255,255,.9); }
      button:hover { background:rgba(255,255,255,.1); }
      button:focus-visible { outline:2px solid #7c6cf6;outline-offset:1px; }
      button:disabled { opacity:.3;cursor:default; }
      .reset { min-width:64px;width:auto;padding:0 8px;font-weight:600;font-variant-numeric:tabular-nums; }
    `;
    const controls = document.createElement('div');
    controls.className = 'controls';
    const minus = document.createElement('button');
    const reset = document.createElement('button');
    const plus = document.createElement('button');
    for (const button of [minus, reset, plus]) button.type = 'button';
    minus.textContent = '−';
    plus.textContent = '+';
    reset.className = 'reset';
    controls.append(minus, reset, plus);
    shadow.append(style, controls);
    tile.append(host);

    function hideControls(): void {
      window.clearTimeout(hideControlsTimer);
      hideControlsTimer = undefined;
      host.style.opacity = '0';
      host.style.pointerEvents = 'none';
    }

    function showControls(): void {
      window.clearTimeout(hideControlsTimer);
      host.style.opacity = '1';
      host.style.pointerEvents = 'auto';
      hideControlsTimer = window.setTimeout(() => {
        hideControlsTimer = undefined;
        if (!controlsHovered && !controlsFocused && !drag) hideControls();
      }, 2000);
    }

    function onControlsEnter(): void {
      controlsHovered = true;
      showControls();
    }

    function onControlsLeave(): void {
      controlsHovered = false;
      showControls();
    }

    function onControlsFocus(): void {
      // A mouse click must not pin the panel after the pointer moves away.
      controlsFocused = !!shadow.querySelector('button:focus-visible');
      showControls();
    }

    function onControlsBlur(): void {
      controlsFocused = false;
      showControls();
    }

    function onPointerLeave(): void {
      if (!controlsFocused && !drag) hideControls();
    }

    function trackSignature(): string {
      const stream = video.srcObject;
      return stream && 'getVideoTracks' in stream
        ? stream.getVideoTracks().map((track) => `${track.id}:${track.readyState}`).join(',')
        : video.currentSrc;
    }

    function clamp(next: View): View {
      const scale = Math.min(4, Math.max(1, next.scale));
      const rect = tile.getBoundingClientRect();
      const factor = interfaceScale();
      const width = rect.width / factor;
      const height = rect.height / factor;
      if (scale === 1 || width <= 0 || height <= 0) return { scale, x: 0, y: 0 };
      const videoWidth = video.videoWidth || width;
      const videoHeight = video.videoHeight || height;
      const fit = Math.min(width / videoWidth, height / videoHeight);
      const maxX = Math.max(0, (videoWidth * fit * scale - width) / 2);
      const maxY = Math.max(0, (videoHeight * fit * scale - height) / 2);
      return { scale, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
    }

    function render(): void {
      const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      // Chromium may serialize fractional numbers with less precision. Compare
      // with its actual result so our observer does not repeat the same write.
      if (transform !== requestedTransform || video.style.transform !== appliedTransform) {
        video.style.transform = transform;
        requestedTransform = transform;
        appliedTransform = video.style.transform;
      }
      if (video.style.transformOrigin !== '50% 50%') video.style.transformOrigin = '50% 50%';
      if (video.style.pointerEvents !== 'none') video.style.pointerEvents = 'none';
      const touchAction = view.scale > 1 ? 'pinch-zoom' : originalTouchAction;
      if (tile.style.touchAction !== touchAction) tile.style.touchAction = touchAction;
      const cursor = view.scale > 1 ? (drag ? 'grabbing' : 'grab') : originalCursor;
      if (tile.style.cursor !== cursor) tile.style.cursor = cursor;
      minus.disabled = view.scale <= 1;
      plus.disabled = view.scale >= 4;
      const language = document.documentElement.lang.toLowerCase().split('-')[0] || 'en';
      const locale = Object.hasOwn(catalogs, language) ? language : 'en';
      const labels = catalogs[locale]!;
      if (formatterLanguage !== locale) {
        formatterLanguage = locale;
        percentageFormatter = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
      }
      const percentage = percentageFormatter.format(view.scale);
      if (reset.textContent !== percentage) reset.textContent = percentage;
      if (host.getAttribute('aria-label') !== labels[0]) host.setAttribute('aria-label', labels[0]);
      for (const [button, label] of [[minus, labels[1]], [reset, labels[2]], [plus, labels[3]]] as const) {
        button.setAttribute('aria-label', label);
        button.title = label;
      }
      host.title = labels[4];
      const voiceContainer = tile.closest('.group\\/voice');
      const fullscreen = document.fullscreenElement?.contains(tile) || voiceContainer?.classList.contains('h-screen');
      const bottom = fullscreen ? '96px' : '48px';
      if (host.style.bottom !== bottom) host.style.bottom = bottom;
      // React may recreate siblings while keeping this video. Reinsert only the
      // controls it removed; never move or replace the attached video element.
      if (host.parentElement !== tile) tile.append(host);
    }

    function zoom(scale: number, x = 0, y = 0): void {
      const nextScale = Math.min(4, Math.max(1, scale));
      const ratio = nextScale / view.scale;
      view = clamp({ scale: nextScale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio });
      render();
      showControls();
    }

    function isControlEvent(event: Event): boolean {
      // Native capture runs before React's delegated handlers. Let controls
      // receive their events, including clicks on nested SVGs and shadow DOM.
      for (const target of event.composedPath()) {
        if (target === tile) break;
        if (target instanceof Element && target.matches(
          'button, a[href], input, select, textarea, label, summary, [role="button"], [role="slider"], [role^="menuitem"], [contenteditable]:not([contenteditable="false"]), [data-backspace-stream-zoom]',
        )) return true;
      }
      return false;
    }

    function onWheel(event: WheelEvent): void {
      if (isControlEvent(event) || event.ctrlKey || event.metaKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = tile.getBoundingClientRect();
      const factor = interfaceScale();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      zoom(view.scale * Math.exp(-Math.min(100, Math.max(-100, pixels)) * .002),
        (event.clientX - rect.left - rect.width / 2) / factor,
        (event.clientY - rect.top - rect.height / 2) / factor);
    }

    function onPointerDown(event: PointerEvent): void {
      if (isControlEvent(event) || view.scale <= 1 || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      tile.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      render();
      showControls();
    }

    function onPointerMove(event: PointerEvent): void {
      showControls();
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = interfaceScale();
      view = clamp({ ...view, x: view.x + (event.clientX - drag.x) / factor, y: view.y + (event.clientY - drag.y) / factor });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
      render();
    }

    function releaseDrag(): void {
      const pointerId = drag?.id;
      drag = null;
      if (pointerId !== undefined && tile.hasPointerCapture(pointerId)) tile.releasePointerCapture(pointerId);
    }

    function onPointerEnd(event: PointerEvent): void {
      if (drag?.id !== event.pointerId) return;
      releaseDrag();
      render();
      showControls();
    }

    function onClick(event: MouseEvent): void {
      // Capture before React's delegated click handler can return to the grid.
      // Toolbar events reach their own buttons before being stopped at the host.
      if (view.scale > 1 && !isControlEvent(event)) event.stopPropagation();
    }

    function checkSource(): boolean {
      const tracks = trackSignature();
      if (source !== video.srcObject || sourceTracks !== tracks) {
        source = video.srcObject;
        sourceTracks = tracks;
        // A source reset can end a drag after its idle timer already expired.
        if (drag) showControls();
        releaseDrag();
        view = { scale: 1, x: 0, y: 0 };
        return true;
      }
      return false;
    }

    function refresh(): void {
      checkSource();
      view = clamp(view);
      render();
    }

    minus.addEventListener('click', () => zoom(view.scale - .25));
    plus.addEventListener('click', () => zoom(view.scale + .25));
    reset.addEventListener('click', () => { releaseDrag(); view = { scale: 1, x: 0, y: 0 }; render(); showControls(); });
    host.addEventListener('click', (event) => event.stopPropagation());
    host.addEventListener('pointerdown', (event) => { controlsFocused = false; showControls(); event.stopPropagation(); });
    host.addEventListener('pointerenter', onControlsEnter);
    host.addEventListener('pointerleave', onControlsLeave);
    host.addEventListener('focusin', onControlsFocus);
    host.addEventListener('focusout', onControlsBlur);
    host.addEventListener('keydown', () => { controlsFocused = true; showControls(); });
    tile.addEventListener('wheel', onWheel, { passive: false, capture: true });
    tile.addEventListener('pointerenter', showControls);
    tile.addEventListener('pointerleave', onPointerLeave);
    tile.addEventListener('pointerdown', onPointerDown, true);
    tile.addEventListener('pointermove', onPointerMove, true);
    tile.addEventListener('pointerup', onPointerEnd, true);
    tile.addEventListener('pointercancel', onPointerEnd, true);
    tile.addEventListener('lostpointercapture', onPointerEnd, true);
    tile.addEventListener('click', onClick, true);
    video.addEventListener('loadedmetadata', refresh);
    video.addEventListener('emptied', refresh);
    video.addEventListener('resize', refresh);
    const resizeObserver = new ResizeObserver(refresh);
    resizeObserver.observe(tile);
    // srcObject assignments and track endings are not DOM mutations.
    const sourceTimer = window.setInterval(() => {
      if (!tile.isConnected) scan();
      else if (checkSource()) { view = clamp(view); render(); }
    }, 250);
    render();
    showControls();

    return {
      video,
      refresh,
      destroy: () => {
        window.clearTimeout(hideControlsTimer);
        window.clearInterval(sourceTimer);
        resizeObserver.disconnect();
        tile.removeEventListener('wheel', onWheel, true);
        tile.removeEventListener('pointerenter', showControls);
        tile.removeEventListener('pointerleave', onPointerLeave);
        tile.removeEventListener('pointerdown', onPointerDown, true);
        tile.removeEventListener('pointermove', onPointerMove, true);
        tile.removeEventListener('pointerup', onPointerEnd, true);
        tile.removeEventListener('pointercancel', onPointerEnd, true);
        tile.removeEventListener('lostpointercapture', onPointerEnd, true);
        tile.removeEventListener('click', onClick, true);
        video.removeEventListener('loadedmetadata', refresh);
        video.removeEventListener('emptied', refresh);
        video.removeEventListener('resize', refresh);
        releaseDrag();
        host.remove();
        restoreVideo();
        restoreTile();
      },
    };
  }

  function scan(): void {
    const focused = focusedStreams();
    for (const [tile, controller] of controllers) {
      if (focused.get(tile) !== controller.video) {
        controller.destroy();
        controllers.delete(tile);
      }
    }
    for (const [tile, video] of focused) {
      const controller = controllers.get(tile);
      if (controller) controller.refresh();
      else controllers.set(tile, createController(tile, video));
    }
  }

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['lang', 'style', 'class', 'src'],
  });
  window.addEventListener('resize', scan);
  document.addEventListener('fullscreenchange', scan);
  scan();

  const cleanup = () => {
    observer.disconnect();
    window.removeEventListener('resize', scan);
    document.removeEventListener('fullscreenchange', scan);
    window.removeEventListener('pagehide', cleanup);
    for (const controller of controllers.values()) controller.destroy();
    controllers.clear();
    if (scope.backspaceStreamZoomCleanup === cleanup) delete scope.backspaceStreamZoomCleanup;
  };
  scope.backspaceStreamZoomCleanup = cleanup;
  window.addEventListener('pagehide', cleanup);
  return cleanup;
}
