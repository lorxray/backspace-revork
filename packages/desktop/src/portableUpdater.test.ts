import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { PortableDesktopUpdater } from './portableUpdater';
import { fileSha256, launchPortableReplacement } from './portableUpdateInstaller';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('backspace-portable-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-portable-test-'));
  roots.push(root);
  const target = path.join(root, 'Мой клиент [test] & $test.exe');
  fs.writeFileSync(target, 'original portable');
  const cacheDirectory = path.join(root, 'cache');
  const binary = Buffer.alloc(1024);
  binary.write('MZ'); binary.writeUInt32LE(128, 60);
  binary.writeUInt32LE(0x4550, 128); binary.writeUInt16LE(0x8664, 132);
  const sha256 = createHash('sha256').update(binary).digest('hex');
  const asset = { name: 'Backspace-1.11.11-portable-x64.exe', size: binary.length,
    browser_download_url: 'https://github.com/lorxray/backspace-revork/releases/download/desktop-v1.11.11-revork.1/Backspace-1.11.11-portable-x64.exe', digest: `sha256:${sha256}` as string | null };
  const release = { draft: false, prerelease: false, tag_name: 'desktop-v1.11.11-revork.1', assets: [asset] };
  const request = vi.fn<typeof fetch>().mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(release) : new Response(binary));
  const quit = vi.fn();
  const install = vi.fn().mockResolvedValue(undefined);
  const updater = new PortableDesktopUpdater({ currentVersion: '1.11.10', target, cacheDirectory, quit, install, request });
  const events: Array<{ name: string; value: unknown }> = [];
  for (const name of ['update-available', 'download-progress', 'update-downloaded', 'error']) updater.on(name, value => events.push({ name, value }));
  return { root, target, cacheDirectory, binary, sha256, asset, release, request, quit, install, updater, events };
}

describe('portable update download and install handoff', () => {
  it('downloads and verifies the portable, then quits only after the installer helper acknowledges', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    expect(f.events.map(event => event.name)).toEqual(['update-available', 'download-progress', 'update-downloaded']);
    expect(f.updater.hasReadyUpdate).toBe(true);
    expect(f.quit).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.target, 'utf8')).toBe('original portable');
    let acknowledge!: () => void;
    f.install.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    f.updater.quitAndInstall();
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.install).toHaveBeenCalledWith(expect.objectContaining({ target: f.target, sha256: f.sha256, relaunch: true }));
    acknowledge();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.updater.hasReadyUpdate).toBe(false);
    expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
  });

  it('reuses an already verified download on repeated checks', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    await f.updater.checkForUpdates();
    expect(f.request).toHaveBeenCalledTimes(3); // API twice, executable once.
    expect(f.events.filter(event => event.name === 'update-downloaded')).toHaveLength(2);
    expect(f.updater.hasReadyUpdate).toBe(true);
  });

  it('accepts the 32-bit NSIS launcher used by an x64 portable', async () => {
    const f = fixture();
    f.binary.writeUInt16LE(0x14c, 132);
    f.asset.digest = `sha256:${createHash('sha256').update(f.binary).digest('hex')}`;
    await f.updater.checkForUpdates();
    expect(f.updater.hasReadyUpdate).toBe(true);
  });

  it('redownloads if a verified cache file was removed, without offering the missing file', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    fs.unlinkSync(path.join(f.cacheDirectory, fs.readdirSync(f.cacheDirectory)[0]!));
    await f.updater.checkForUpdates();
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(f.updater.hasReadyUpdate).toBe(true);
  });

  it('uses SHA256SUMS.txt if GitHub does not provide the asset digest', async () => {
    const f = fixture();
    f.asset.digest = null;
    const sums = `${f.sha256}  ${f.asset.name}\n`;
    f.release.assets.push({ name: 'SHA256SUMS.txt', size: Buffer.byteLength(sums), digest: null,
      browser_download_url: 'https://github.com/lorxray/backspace-revork/releases/download/desktop-v1.11.11-revork.1/SHA256SUMS.txt' });
    f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release)
      : String(input).endsWith('SHA256SUMS.txt') ? new Response(sums) : new Response(f.binary));
    await f.updater.checkForUpdates();
    expect(f.updater.hasReadyUpdate).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(3);
  });

  it.each(['checksum', 'size', 'executable', 'interrupted'])('preserves the original and discards a failed %s download', async failure => {
    const f = fixture();
    if (failure === 'checksum') f.asset.digest = `sha256:${'0'.repeat(64)}`;
    if (failure === 'size') f.asset.size += 10;
    if (failure === 'executable') {
      f.binary.fill(0);
      f.asset.digest = `sha256:${createHash('sha256').update(f.binary).digest('hex')}`;
    }
    if (failure === 'interrupted') f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release)
      : new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } })));
    await expect(f.updater.checkForUpdates()).rejects.toThrow();
    expect(f.updater.hasReadyUpdate).toBe(false);
    expect(fs.readFileSync(f.target, 'utf8')).toBe('original portable');
    expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
    expect(f.events.some(event => event.name === 'update-downloaded')).toBe(false);
    expect(f.quit).not.toHaveBeenCalled();
  });

  it.each(['foreign-url', 'no-checksum', 'duplicate', 'oversized'])('refuses %s release metadata before downloading an executable', async failure => {
    const f = fixture();
    if (failure === 'foreign-url') f.asset.browser_download_url = 'https://github.com/another/project/releases/download/v1/fake.exe';
    if (failure === 'no-checksum') f.asset.digest = null;
    if (failure === 'duplicate') f.release.assets.push({ ...f.asset });
    if (failure === 'oversized') f.asset.size = 600 * 1024 * 1024;
    await expect(f.updater.checkForUpdates()).rejects.toThrow();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.updater.hasReadyUpdate).toBe(false);
    expect(f.quit).not.toHaveBeenCalled();
  });

  it('keeps the app open when preparing an explicit restart fails', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    f.install.mockRejectedValue(new Error('Folder is read-only'));
    f.updater.quitAndInstall();
    await vi.waitFor(() => expect(f.events.at(-1)?.name).toBe('error'));
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.updater.installing).toBe(false);
    expect(fs.readFileSync(f.target, 'utf8')).toBe('original portable');
  });

  it('honours a regular Exit if update preparation fails, without a repeated quit loop', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    f.install.mockRejectedValue(new Error('Permission denied'));
    f.updater.quitAndInstall(false);
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
  });

  it('coalesces repeated install clicks and passes through the regular Exit mode', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    f.updater.quitAndInstall(false);
    f.updater.quitAndInstall(false);
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install).toHaveBeenCalledWith(expect.objectContaining({ relaunch: false }));
  });

  it('refuses an install with no verified download', () => {
    const f = fixture();
    expect(() => f.updater.quitAndInstall()).toThrow('No verified portable');
    expect(f.quit).not.toHaveBeenCalled();
  });

  it('detects changed downloaded bytes before starting a helper or changing the original', async () => {
    const f = fixture();
    await f.updater.checkForUpdates();
    const updateFile = path.join(f.cacheDirectory, fs.readdirSync(f.cacheDirectory)[0]!);
    expect(await fileSha256(updateFile)).toBe(f.sha256);
    fs.writeFileSync(updateFile, 'tampered');
    await expect(launchPortableReplacement({ target: f.target, updateFile, sha256: f.sha256, cacheDirectory: f.cacheDirectory, relaunch: true }))
      .rejects.toThrow('checksum changed');
    expect(fs.readFileSync(f.target, 'utf8')).toBe('original portable');
    expect(fs.readdirSync(f.root).filter(name => name.startsWith('.backspace'))).toEqual([]);
  });
});
