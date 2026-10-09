// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMicrophoneGateControls } from './microphoneGateControls';

const storageKey = 'backspace-desktop-microphone-gate';
const settingsEvent = 'backspace-microphone-gate-settings';
const statusEvent = 'backspace-microphone-gate-status';
const cleanups: Array<() => void> = [];

function install(): () => void {
  const cleanup = installMicrophoneGateControls();
  cleanups.push(cleanup);
  return cleanup;
}

function volumeSection(label = 'Input Volume') {
  const section = document.createElement('div');
  section.innerHTML = `<div class="text-[11px]">Input Device</div>
    <div class="rounded-lg p-3.5"><div class="space-y-3">
      <div><button type="button">System Default</button></div>
      <div data-volume><div class="flex"><div>${label}</div><div>100%</div></div>
        <input type="range" min="0" max="200" value="100" />
        <div class="flex">${'<div></div>'.repeat(20)}</div>
        <div>The level meter activates once you join a voice channel.</div>
      </div>
    </div></div>`;
  document.body.append(section);
  return { section, volume: section.querySelector<HTMLElement>('[data-volume]')!, slider: section.querySelector<HTMLInputElement>('input')! };
}

function ui(section: HTMLElement) {
  const host = section.querySelector<HTMLElement>('[data-backspace-microphone-gate]');
  expect(host, 'controls are installed after microphone volume').not.toBeNull();
  const shadow = host!.shadowRoot!;
  return {
    host: host!, shadow,
    toggle: shadow.querySelector<HTMLInputElement>('input[type="checkbox"]')!,
    slider: shadow.querySelector<HTMLInputElement>('input[type="range"]')!,
    meter: shadow.querySelector<HTMLElement>('[role="meter"]')!,
    state: shadow.querySelector<HTMLElement>('[role="status"]')!,
  };
}

function emitStatus(detail: { db: number; open: boolean; available: boolean; error?: boolean }): void {
  document.dispatchEvent(new CustomEvent(statusEvent, { detail }));
}

async function mutations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  document.body.replaceChildren();
  document.documentElement.lang = 'en';
  localStorage.clear();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('bundled desktop microphone gate controls', () => {
  it('adds an isolated accessible UI after the mic volume without altering other ranges or opening a microphone', () => {
    const input = volumeSection();
    const output = volumeSection('Output Volume');
    const sounds = volumeSection('Sound Effects Volume');
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const settings = vi.fn();
    const request = vi.fn();
    document.addEventListener(settingsEvent, settings);
    document.addEventListener('backspace-microphone-gate-status-request', request);
    install();
    const controls = ui(input.section);
    expect(controls.host.previousElementSibling).toBe(input.volume);
    expect(controls.host.getAttribute('aria-label')).toBe('Microphone activation');
    expect(controls.toggle.getAttribute('role')).toBe('switch');
    expect(controls.toggle.checked).toBe(false);
    expect(controls.slider.getAttribute('aria-label')).toBe('Activation threshold');
    expect([controls.slider.min, controls.slider.max, controls.slider.step, controls.slider.value]).toEqual(['-80', '-10', '1', '-50']);
    expect(controls.state.textContent).toContain('Join a voice channel or call');
    expect(output.section.querySelector('[data-backspace-microphone-gate]')).toBeNull();
    expect(sounds.section.querySelector('[data-backspace-microphone-gate]')).toBeNull();
    expect(input.slider.value).toBe('100');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(settings).toHaveBeenCalledTimes(1);
    expect((settings.mock.calls[0]![0] as CustomEvent).detail).toEqual({ enabled: false, thresholdDb: -50 });
    expect(request).toHaveBeenCalledTimes(1);
    document.removeEventListener(settingsEvent, settings);
    document.removeEventListener('backspace-microphone-gate-status-request', request);
  });

  it('persists toggles and slider input, dispatches changes once, and keeps all visible controls in sync', () => {
    const first = volumeSection();
    const second = volumeSection();
    install();
    const settings = vi.fn();
    document.addEventListener(settingsEvent, settings);
    const controls = ui(first.section);
    controls.toggle.click();
    controls.slider.value = '-35';
    controls.slider.dispatchEvent(new Event('input', { bubbles: true }));
    controls.slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ enabled: true, thresholdDb: -35 });
    expect(settings).toHaveBeenCalledTimes(2);
    expect((settings.mock.calls[1]![0] as CustomEvent).detail).toEqual({ enabled: true, thresholdDb: -35 });
    expect(ui(second.section).toggle.checked).toBe(true);
    expect(ui(second.section).slider.value).toBe('-35');
    expect(controls.shadow.querySelector('output')!.textContent).toBe('-35 dB');
    expect(controls.shadow.querySelector<HTMLElement>('.marker')!.style.left).toBe('56.25%');
    document.removeEventListener(settingsEvent, settings);
  });

  it.each([
    ['invalid JSON', '{', false, '-50'],
    ['invalid values', '{"enabled":"true","thresholdDb":"-20"}', false, '-50'],
    ['below the range', '{"enabled":true,"thresholdDb":-100}', true, '-80'],
    ['above the range', '{"enabled":true,"thresholdDb":0}', true, '-10'],
    ['fractional value', '{"enabled":true,"thresholdDb":-41.4}', true, '-41'],
  ])('validates saved settings: %s', (_description, saved, enabled, threshold) => {
    localStorage.setItem(storageKey, saved);
    const { section } = volumeSection();
    install();
    expect(ui(section).toggle.checked).toBe(enabled);
    expect(ui(section).slider.value).toBe(threshold);
  });

  it('applies settings for the session if local storage is unavailable', () => {
    const { section } = volumeSection();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked'); });
    const settings = vi.fn();
    document.addEventListener(settingsEvent, settings);
    install();
    ui(section).toggle.click();
    expect(ui(section).toggle.checked).toBe(true);
    expect((settings.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual({ enabled: true, thresholdDb: -50 });
    document.removeEventListener(settingsEvent, settings);
  });

  it.each([
    ['ru-RU', 'Громкость микрофона', 'Активация микрофона', 'Порог срабатывания'],
    ['de', 'Eingabelautstärke', 'Mikrofonaktivierung', 'Aktivierungsschwelle'],
    ['pt-BR', 'Volume de entrada', 'Ativação do microfone', 'Limiar de ativação'],
    ['zh-CN', '输入音量', '麦克风激活', '激活阈值'],
  ])('recognizes the existing mic volume and updates language to %s', async (language, label, title, threshold) => {
    const { section, volume } = volumeSection();
    install();
    document.documentElement.lang = language;
    volume.firstElementChild!.firstElementChild!.textContent = label;
    await mutations();
    expect(ui(section).host.getAttribute('aria-label')).toBe(title);
    expect(ui(section).slider.getAttribute('aria-label')).toBe(threshold);
  });

  it('uses English when the page language is unsupported', () => {
    document.documentElement.lang = 'fr';
    const { section } = volumeSection();
    install();
    expect(ui(section).host.getAttribute('aria-label')).toBe('Microphone activation');
  });

  it('shows live input level, threshold marker, bypass, open, closed, unavailable, and failure states', () => {
    localStorage.setItem(storageKey, JSON.stringify({ enabled: true, thresholdDb: -50 }));
    const { section } = volumeSection();
    install();
    const controls = ui(section);
    emitStatus({ db: -40, open: true, available: true });
    expect(controls.state.textContent).toBe('Microphone open');
    expect(controls.meter.getAttribute('aria-valuenow')).toBe('-40');
    expect(controls.shadow.querySelector<HTMLElement>('.fill')!.style.width).toBe('50%');
    expect(controls.shadow.querySelector<HTMLElement>('.marker')!.style.left).toBe('37.5%');
    emitStatus({ db: -65, open: false, available: true });
    expect(controls.state.textContent).toBe('Microphone closed');
    controls.toggle.click();
    expect(controls.state.textContent).toBe('Threshold disabled');
    emitStatus({ db: -100, open: true, available: false });
    expect(controls.state.textContent).toContain('Join a voice channel or call');
    expect(controls.meter.getAttribute('aria-valuenow')).toBe('-80');
    emitStatus({ db: -80, open: true, available: false, error: true });
    expect(controls.state.textContent).toContain('could not be applied');
    expect(controls.state.dataset.error).toBe('true');
    document.dispatchEvent(new CustomEvent(statusEvent, { detail: { db: NaN, open: true, available: true } }));
    expect(controls.state.dataset.error).toBe('true');
  });

  it('receives the adapter status when requesting it during installation', () => {
    const { section } = volumeSection();
    const reply = () => emitStatus({ db: -80, open: true, available: false, error: true });
    document.addEventListener('backspace-microphone-gate-status-request', reply);
    install();
    expect(ui(section).state.dataset.error).toBe('true');
    document.removeEventListener('backspace-microphone-gate-status-request', reply);
  });

  it('restores controls after React removes a sibling or remounts the settings panel', async () => {
    const first = volumeSection();
    install();
    ui(first.section).toggle.click();
    ui(first.section).host.remove();
    await mutations();
    expect(ui(first.section).toggle.checked).toBe(true);
    first.section.remove();
    const second = volumeSection();
    await mutations();
    expect(first.section.querySelector('[data-backspace-microphone-gate]')).toBeNull();
    expect(ui(second.section).toggle.checked).toBe(true);
    expect(document.querySelectorAll('[data-backspace-microphone-gate]')).toHaveLength(1);
  });

  it('does not duplicate controls or listeners on repeated installation, and cleans up on pagehide', () => {
    const { section } = volumeSection();
    install();
    install();
    expect(document.querySelectorAll('[data-backspace-microphone-gate]')).toHaveLength(1);
    const settings = vi.fn();
    document.addEventListener(settingsEvent, settings);
    ui(section).toggle.click();
    expect(settings).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pagehide'));
    expect(section.querySelector('[data-backspace-microphone-gate]')).toBeNull();
    document.removeEventListener(settingsEvent, settings);
  });

  it('synchronizes storage changes from another app window with its audio adapter', () => {
    const { section } = volumeSection();
    install();
    const settings = vi.fn();
    document.addEventListener(settingsEvent, settings);
    localStorage.setItem(storageKey, JSON.stringify({ enabled: true, thresholdDb: -22 }));
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey }));
    expect(ui(section).toggle.checked).toBe(true);
    expect(ui(section).slider.value).toBe('-22');
    expect((settings.mock.calls[0]![0] as CustomEvent).detail).toEqual({ enabled: true, thresholdDb: -22 });
    document.removeEventListener(settingsEvent, settings);
  });

  it('runs from its serialized function with no imported runtime dependencies', () => {
    const { section } = volumeSection();
    const serializedInstall = new Function(`return (${installMicrophoneGateControls.toString()})();`) as () => () => void;
    cleanups.push(serializedInstall());
    expect(ui(section).slider.value).toBe('-50');
  });
});
