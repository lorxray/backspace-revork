'use strict';

// Real Chromium negotiation against the installed LiveKit SDK. No account,
// screen capture, SFU, or external network is used; both peers are local.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'tests/.tmp/screen-share-startup-electron');

if (!process.versions.electron) {
  const vite = require.resolve('vite', { paths: [path.join(root, 'packages/web')] });
  const esbuild = require(require.resolve('esbuild', { paths: [path.dirname(vite)] }));
  fs.mkdirSync(output, { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'fixtures/screenShareStartup.ts')],
    outfile: path.join(output, 'renderer.js'), bundle: true, platform: 'browser', format: 'iife',
  });
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><script src="renderer.js"></script>');
  const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
    encoding: 'utf8', windowsHide: true, timeout: 45000,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require('electron');
app.setPath('userData', path.join(output, 'profile'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const timeout = setTimeout(() => { console.error('Screen-share startup test timed out'); app.exit(1); }, 35000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(path.join(output, 'index.html'));
  const result = await window.webContents.executeJavaScript('window.testScreenShareStartup()');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log('Screen-share startup Electron checks passed: ' + JSON.stringify(result));
  clearTimeout(timeout);
  window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
