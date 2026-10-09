'use strict';
/* global document, navigator, localStorage, performance, Event, OfflineAudioContext, AudioContext, AudioWorkletNode */

// A hidden Electron smoke test for the shipped preload, real AudioWorklet and
// the CSP used by existing instances. All capture devices in this test are fake.
const { app, BrowserWindow, protocol, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { MICROPHONE_GATE_SCHEME, handleMicrophoneGateRequest } = require('../dist/microphoneGateProtocol.js');

const outputDirectory = path.join(__dirname, '../../../tests/.tmp/microphone-gate-electron');
fs.mkdirSync(outputDirectory, { recursive: true });
app.setPath('userData', path.join(outputDirectory, 'profile'));
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{
  scheme: MICROPHONE_GATE_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
}]);

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' blob: data:">
<style>
:root { --text-primary:237 237 243;--text-tertiary:149 149 163;--accent-primary:124 108 246;--interactive-muted:66 66 77; }
body { background:#202127;color:#ededf3;font:14px system-ui;margin:0;padding:32px; }
main { width:480px;padding:24px;background:#292a32;border-radius:12px; }
h2 { margin:0 0 24px;font-size:20px; } .device { background:#202127;border-radius:6px;padding:10px;margin-bottom:18px; }
.volume>div { display:flex;justify-content:space-between;margin-bottom:10px;font-size:13px; }
.volume>input { width:100%;accent-color:#7c6cf6; } .level { font-size:12px;color:#9595a3;margin-top:14px; }
</style><script src="/fixture.js" defer></script></head><body>
<main><h2>Голос и видео</h2><div class="device">Микрофон — устройство по умолчанию</div>
<div class="volume"><div><span>Громкость микрофона</span><span>100%</span></div><input type="range" min="0" max="200" value="100"></div>
<div class="level">Уровень микрофона</div></main></body></html>`;
const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self' blob: data:";
const server = http.createServer((request, response) => {
  if (request.url === '/fixture.js') {
    response.writeHead(200, { 'Content-Type': 'application/javascript' });
    response.end('window.gateInstalledBeforePageScript = typeof window.backspaceMicrophoneGateCleanup === "function";');
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': csp });
    response.end(html);
  }
});

async function checkInRenderer() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (predicate, message) => {
    const end = performance.now() + 8000;
    while (!predicate()) {
      if (performance.now() >= end) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  assert(window.gateInstalledBeforePageScript, 'gate preload must run before page scripts');
  assert(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'renderer remains sandboxed');
  const shadow = document.querySelector('[data-backspace-microphone-gate]')?.shadowRoot;
  assert(shadow, 'microphone settings must appear in the server-provided UI');
  const toggle = shadow.querySelector('input[type=checkbox]');
  const slider = shadow.querySelector('input[type=range]');
  assert(!toggle.checked && slider.value === '-50', 'new installation starts with transparent bypass');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change', { bubbles: true }));
  slider.value = '-40';
  slider.dispatchEvent(new Event('input', { bubbles: true }));
  assert(JSON.parse(localStorage.getItem('backspace-desktop-microphone-gate')).thresholdDb === -40, 'threshold persists locally');

  async function render(amplitude, enabled) {
    const context = new OfflineAudioContext(1, 48000, 48000);
    await context.audioWorklet.addModule('backspace-microphone-gate://audio/processor.js', { credentials: 'omit' });
    const node = new AudioWorkletNode(context, 'backspace-microphone-gate', {
      processorOptions: { enabled, thresholdDb: -40 },
    });
    const signal = context.createConstantSource();
    signal.offset.value = amplitude;
    signal.connect(node).connect(context.destination);
    signal.start();
    const result = await context.startRendering();
    return result.getChannelData(0);
  }
  const quiet = await render(0.001, true);
  assert(quiet.every(value => value === 0), 'quiet audio must be suppressed');
  const speech = await render(0.1, true);
  assert(Math.abs(speech[2400] - 0.1) < 0.000001, 'audio above threshold must pass');
  const bypass = await render(0.001, false);
  assert(Math.abs(bypass[0] - 0.001) < 0.00000001, 'disabled gate must have no delay');

  const statuses = [];
  document.addEventListener('backspace-microphone-gate-status', event => statuses.push(event.detail));
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  const onended = () => {};
  track.onended = onended;
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const silence = context.createGain();
  silence.gain.value = 0;
  silence.connect(context.destination);
  assert(source.mediaStream === stream && source.connect(silence) === silence, 'original synchronous source API is preserved');
  await context.resume();
  await waitFor(() => statuses.at(-1)?.available, 'live microphone worklet must initialize under the server CSP');
  const before = statuses.length;
  await waitFor(() => statuses.length >= before + 3, 'level messages must continue in a hidden window');
  source.disconnect();
  assert(statuses.at(-1).available === false, 'disconnect must clear the level display');
  source.connect(silence);
  assert(statuses.at(-1).available === true, 'reconnect must reuse the gate');
  track.stop();
  assert(track.readyState === 'ended' && !stream.active, 'leaving voice must stop the real capture');
  assert(track.onended === onended && statuses.at(-1).available === false, 'cleanup must preserve the client track-loss handler');
  await context.close();
  return { preload: true, sandbox: true, csp: true, quietSuppressed: true, speechPassed: true, bypass: true, hiddenWindow: true, captureReleased: true };
}

let window;
const timeout = setTimeout(() => { console.error('Microphone gate Electron smoke test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const testSession = session.fromPartition(`microphone-gate-test-${Date.now()}`);
  testSession.protocol.handle(MICROPHONE_GATE_SCHEME, handleMicrophoneGateRequest);
  testSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '../dist/microphoneGatePreload.js') });
  window = new BrowserWindow({
    show: false, width: 640, height: 700,
    webPreferences: { session: testSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('console-message', (_event, _level, message) => console.log(`[renderer] ${message}`));
  await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const result = await window.webContents.executeJavaScript(`(${checkInRenderer.toString()})()`);
  const screenshot = await window.webContents.capturePage();
  const screenshotPath = path.join(outputDirectory, 'preview.png');
  fs.writeFileSync(screenshotPath, screenshot.toPNG());
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify({ passed: true, ...result }, null, 2));
  console.log(`Microphone gate Electron smoke test passed: ${JSON.stringify(result)}`);
  console.log(`Preview: ${screenshotPath}`);
  clearTimeout(timeout);
  window.destroy();
  server.close();
  app.exit(0);
}).catch(error => {
  console.error(error);
  fs.writeFileSync(path.join(outputDirectory, 'result.json'), JSON.stringify({ passed: false, error: String(error) }, null, 2));
  clearTimeout(timeout);
  window?.destroy();
  server.close();
  app.exit(1);
});
