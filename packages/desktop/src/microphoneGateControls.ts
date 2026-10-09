/**
 * Runs in the renderer's main world. Keep runtime dependencies inside this
 * function so Electron can serialize the compiled function into a remote UI.
 * The audio adapter supplies level readings; these controls never open a mic.
 */
export function installMicrophoneGateControls(): () => void {
  const scope = window as Window & { backspaceMicrophoneGateControlsCleanup?: () => void };
  scope.backspaceMicrophoneGateControlsCleanup?.();

  type Settings = { enabled: boolean; thresholdDb: number };
  type Status = { db: number; open: boolean; available: boolean; error: boolean };
  type Labels = {
    title: string; enabled: string; threshold: string; description: string;
    unavailable: string; error: string; open: string; closed: string;
    bypassed: string; level: string; unit: string;
  };
  type Controller = { render: () => void; destroy: () => void };
  const storageKey = 'backspace-desktop-microphone-gate';
  const settingsEvent = 'backspace-microphone-gate-settings';
  const statusEvent = 'backspace-microphone-gate-status';
  const controllers = new Map<HTMLElement, Controller>();
  const inputLabels = new Set(['Input Volume', 'Громкость микрофона', 'Eingabelautstärke', 'Volume de entrada', '输入音量']);
  const catalogs: Record<string, Labels> = {
    en: {
      title: 'Microphone activation', enabled: 'Use activation threshold', threshold: 'Activation threshold',
      description: 'Quiet sounds below the threshold are not transmitted. Move left to pick up a quieter voice, right to block more background noise.',
      unavailable: 'Join a voice channel or call to see your microphone level.',
      error: 'Microphone activation could not be applied. Your microphone continues to work without the threshold.',
      open: 'Microphone open', closed: 'Microphone closed', bypassed: 'Threshold disabled', level: 'Microphone level', unit: 'dB',
    },
    ru: {
      title: 'Активация микрофона', enabled: 'Включить порог срабатывания', threshold: 'Порог срабатывания',
      description: 'Тихие звуки ниже порога не передаются. Влево — для тихого голоса, вправо — чтобы отсечь больше фонового шума.',
      unavailable: 'Подключитесь к голосовому каналу или звонку, чтобы увидеть уровень микрофона.',
      error: 'Не удалось применить порог срабатывания. Микрофон продолжает работать без порога.',
      open: 'Микрофон открыт', closed: 'Микрофон закрыт', bypassed: 'Порог выключен', level: 'Уровень микрофона', unit: 'дБ',
    },
    de: {
      title: 'Mikrofonaktivierung', enabled: 'Aktivierungsschwelle verwenden', threshold: 'Aktivierungsschwelle',
      description: 'Leise Geräusche unterhalb der Schwelle werden nicht übertragen. Nach links für eine leisere Stimme, nach rechts gegen mehr Hintergrundgeräusche.',
      unavailable: 'Tritt einem Sprachkanal oder Anruf bei, um den Mikrofonpegel zu sehen.',
      error: 'Die Mikrofonaktivierung konnte nicht angewendet werden. Dein Mikrofon funktioniert weiterhin ohne Schwelle.',
      open: 'Mikrofon offen', closed: 'Mikrofon geschlossen', bypassed: 'Schwelle deaktiviert', level: 'Mikrofonpegel', unit: 'dB',
    },
    pt: {
      title: 'Ativação do microfone', enabled: 'Usar limiar de ativação', threshold: 'Limiar de ativação',
      description: 'Sons baixos abaixo do limiar não são transmitidos. Mova para a esquerda para captar uma voz mais baixa ou para a direita para bloquear mais ruído de fundo.',
      unavailable: 'Entre em um canal de voz ou chamada para ver o nível do microfone.',
      error: 'Não foi possível aplicar a ativação do microfone. Seu microfone continua funcionando sem o limiar.',
      open: 'Microfone aberto', closed: 'Microfone fechado', bypassed: 'Limiar desativado', level: 'Nível do microfone', unit: 'dB',
    },
    zh: {
      title: '麦克风激活', enabled: '启用激活阈值', threshold: '激活阈值',
      description: '低于阈值的轻微声音不会传输。向左移动可拾取较轻的语音，向右移动可阻挡更多背景噪声。',
      unavailable: '加入语音频道或通话后即可查看麦克风音量。',
      error: '无法应用麦克风激活阈值。麦克风将继续工作，不使用阈值。',
      open: '麦克风已打开', closed: '麦克风已关闭', bypassed: '阈值已禁用', level: '麦克风音量', unit: 'dB',
    },
  };

  function readSettings(): Settings {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      if (typeof saved === 'object' && saved !== null) {
        const values = saved as Partial<Settings>;
        return {
          enabled: values.enabled === true,
          thresholdDb: typeof values.thresholdDb === 'number' && Number.isFinite(values.thresholdDb)
            ? Math.round(Math.min(-10, Math.max(-80, values.thresholdDb))) : -50,
        };
      }
    } catch { /* Unavailable or invalid storage leaves the gate disabled. */ }
    return { enabled: false, thresholdDb: -50 };
  }

  let settings = readSettings();
  let status: Status = { db: -80, open: true, available: false, error: false };

  function publishSettings(): void {
    document.dispatchEvent(new CustomEvent(settingsEvent, { detail: { ...settings } }));
  }

  function renderAll(): void {
    for (const controller of controllers.values()) controller.render();
  }

  function updateSettings(next: Settings): void {
    if (next.enabled === settings.enabled && next.thresholdDb === settings.thresholdDb) return;
    settings = next;
    try { localStorage.setItem(storageKey, JSON.stringify(settings)); } catch { /* Still apply changes for this session. */ }
    publishSettings();
    renderAll();
  }

  function createController(volume: HTMLElement): Controller {
    const host = document.createElement('div');
    host.setAttribute('data-backspace-microphone-gate', '');
    host.setAttribute('role', 'group');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display:block;padding-top:12px;border-top:1px solid rgba(255,255,255,.07);
        color:rgb(var(--text-primary, 237 237 243));font:inherit; }
      * { box-sizing:border-box; }
      h3 { font-size:13px;font-weight:600;margin:0 0 10px; }
      .switch { display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer;font-size:13px; }
      .switch input { appearance:none;width:30px;height:18px;flex-shrink:0;margin:0;position:relative;border-radius:999px;
        background:rgb(var(--interactive-muted, 66 66 77));cursor:pointer; }
      .switch input::after { content:'';position:absolute;width:12px;height:12px;top:3px;left:3px;border-radius:50%;background:white; }
      .switch input:checked { background:rgb(var(--accent-primary, 124 108 246)); }
      .switch input:checked::after { left:15px; }
      .row { display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0 7px;font-size:13px; }
      output, .scale, .status, p { font-size:12px;color:rgb(var(--text-tertiary, 149 149 163)); }
      output { font-variant-numeric:tabular-nums;white-space:nowrap; }
      input[type=range] { appearance:none;display:block;width:100%;height:6px;margin:0;border-radius:999px;cursor:pointer;
        background:rgb(var(--interactive-muted, 66 66 77)); }
      input[type=range]::-webkit-slider-thumb { appearance:none;width:12px;height:12px;border-radius:50%;background:white; }
      input:focus-visible { outline:2px solid rgb(var(--accent-primary, 124 108 246));outline-offset:4px; }
      .meter { position:relative;height:7px;margin-top:13px;border-radius:2px;background:rgb(var(--interactive-muted, 66 66 77)); }
      .fill { height:100%;width:0;border-radius:2px;background:rgb(var(--status-online, 116 199 166)); }
      .marker { position:absolute;top:-3px;bottom:-3px;width:2px;transform:translateX(-1px);background:rgb(var(--accent-primary, 124 108 246)); }
      .scale { display:flex;justify-content:space-between;margin-top:5px;font-variant-numeric:tabular-nums; }
      .status { margin-top:7px; }
      .status[data-error=true] { color:rgb(var(--text-danger, 234 138 148)); }
      p { margin:7px 0 0;line-height:1.5; }
    `;
    const title = document.createElement('h3');
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'switch';
    const toggleText = document.createElement('span');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.setAttribute('role', 'switch');
    toggleLabel.append(toggleText, toggle);
    const row = document.createElement('div');
    row.className = 'row';
    const thresholdLabel = document.createElement('label');
    thresholdLabel.htmlFor = 'microphone-gate-threshold';
    const output = document.createElement('output');
    output.htmlFor = 'microphone-gate-threshold';
    row.append(thresholdLabel, output);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'microphone-gate-threshold';
    slider.min = '-80';
    slider.max = '-10';
    slider.step = '1';
    slider.setAttribute('aria-describedby', 'microphone-gate-description');
    const meter = document.createElement('div');
    meter.className = 'meter';
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-valuemin', '-80');
    meter.setAttribute('aria-valuemax', '0');
    const fill = document.createElement('div');
    fill.className = 'fill';
    const marker = document.createElement('div');
    marker.className = 'marker';
    marker.setAttribute('aria-hidden', 'true');
    meter.append(fill, marker);
    const scale = document.createElement('div');
    scale.className = 'scale';
    scale.setAttribute('aria-hidden', 'true');
    const minimum = document.createElement('span');
    const maximum = document.createElement('span');
    scale.append(minimum, maximum);
    const state = document.createElement('div');
    state.className = 'status';
    state.setAttribute('role', 'status');
    const description = document.createElement('p');
    description.id = 'microphone-gate-description';
    shadow.append(style, title, toggleLabel, row, slider, meter, scale, state, description);
    let formatterLanguage = '';
    let formatter: Intl.NumberFormat;

    function render(): void {
      const language = document.documentElement.lang.toLowerCase().split('-')[0] || 'en';
      const locale = Object.hasOwn(catalogs, language) ? language : 'en';
      const labels = catalogs[locale]!;
      if (formatterLanguage !== locale) {
        formatterLanguage = locale;
        formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
      }
      const decibels = (value: number) => `${formatter.format(value)} ${labels.unit}`;
      host.setAttribute('aria-label', labels.title);
      title.textContent = labels.title;
      toggleText.textContent = labels.enabled;
      toggle.checked = settings.enabled;
      toggle.setAttribute('aria-label', labels.enabled);
      thresholdLabel.textContent = labels.threshold;
      slider.setAttribute('aria-label', labels.threshold);
      slider.value = String(settings.thresholdDb);
      slider.setAttribute('aria-valuetext', decibels(settings.thresholdDb));
      output.value = decibels(settings.thresholdDb);
      description.textContent = labels.description;
      meter.setAttribute('aria-label', labels.level);
      meter.setAttribute('aria-valuenow', String(status.db));
      meter.setAttribute('aria-valuetext', status.available ? decibels(status.db) : labels.unavailable);
      fill.style.width = `${status.available ? (status.db + 80) / 80 * 100 : 0}%`;
      marker.style.left = `${(settings.thresholdDb + 80) / 80 * 100}%`;
      marker.title = `${labels.threshold}: ${decibels(settings.thresholdDb)}`;
      minimum.textContent = decibels(-80);
      maximum.textContent = decibels(0);
      const text = status.error ? labels.error : !status.available ? labels.unavailable
        : !settings.enabled ? labels.bypassed : status.open ? labels.open : labels.closed;
      if (state.textContent !== text) state.textContent = text;
      state.dataset.error = String(status.error);
      // React can remove an injected sibling while retaining the volume block.
      if (host.previousElementSibling !== volume) volume.after(host);
    }

    function onToggle(): void {
      updateSettings({ ...settings, enabled: toggle.checked });
    }

    function onThreshold(): void {
      const value = Number(slider.value);
      if (Number.isFinite(value)) updateSettings({ ...settings, thresholdDb: Math.round(Math.min(-10, Math.max(-80, value))) });
    }

    toggle.addEventListener('change', onToggle);
    slider.addEventListener('input', onThreshold);
    slider.addEventListener('change', onThreshold);
    // Avoid React's delegated handlers treating shadow controls as panel actions.
    const stopClick = (event: Event) => event.stopPropagation();
    host.addEventListener('click', stopClick);
    render();
    return { render, destroy: () => {
      toggle.removeEventListener('change', onToggle);
      slider.removeEventListener('input', onThreshold);
      slider.removeEventListener('change', onThreshold);
      host.removeEventListener('click', stopClick);
      host.remove();
    } };
  }

  function scan(): void {
    const volumes = new Set<HTMLElement>();
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"][min="0"][max="200"]')) {
      const volume = input.parentElement;
      const label = volume?.firstElementChild?.firstElementChild?.textContent?.trim();
      if (volume && label && inputLabels.has(label)) volumes.add(volume);
    }
    for (const [volume, controller] of controllers) {
      if (!volumes.has(volume)) { controller.destroy(); controllers.delete(volume); }
    }
    for (const volume of volumes) {
      const existing = controllers.get(volume);
      if (existing) existing.render();
      else controllers.set(volume, createController(volume));
    }
  }

  function onStatus(event: Event): void {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== 'object' || detail === null) return;
    const next = detail as Partial<Status>;
    if (typeof next.db !== 'number' || !Number.isFinite(next.db)
      || typeof next.open !== 'boolean' || typeof next.available !== 'boolean') return;
    status = { db: Math.min(0, Math.max(-80, next.db)), open: next.open, available: next.available, error: next.error === true };
    renderAll();
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== storageKey && event.key !== null) return;
    settings = readSettings();
    publishSettings();
    renderAll();
  }

  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['lang'] });
  document.addEventListener(statusEvent, onStatus);
  window.addEventListener('storage', onStorage);
  publishSettings();
  scan();
  document.dispatchEvent(new CustomEvent('backspace-microphone-gate-status-request'));

  const cleanup = () => {
    observer.disconnect();
    document.removeEventListener(statusEvent, onStatus);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('pagehide', cleanup);
    for (const controller of controllers.values()) controller.destroy();
    controllers.clear();
    if (scope.backspaceMicrophoneGateControlsCleanup === cleanup) delete scope.backspaceMicrophoneGateControlsCleanup;
  };
  scope.backspaceMicrophoneGateControlsCleanup = cleanup;
  window.addEventListener('pagehide', cleanup);
  return cleanup;
}
