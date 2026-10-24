import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { PortableDesktopUpdater } from './portableUpdater';
import { fileSha256, launchPortableReplacement, portableInstallDestination, repairLegacyPortableName } from './portableUpdateInstaller';

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
  for (const name of ['update-available', 'download-progress', 'update-downloaded', 'download-cancelled', 'error']) updater.on(name, value => events.push({ name, value }));
  const reopen = () => new PortableDesktopUpdater({ currentVersion: '1.11.10', target, cacheDirectory, quit, install, request });
  return { reopen, root, target, cacheDirectory, binary, sha256, asset, release, request, quit, install, updater, events };
}


async function download(f: ReturnType<typeof fixture>) {
  await f.updater.checkForUpdates();
  await f.updater.downloadUpdate('1.11.11');
}
function executable(f: ReturnType<typeof fixture>): string {
  return path.join(f.cacheDirectory, fs.readdirSync(f.cacheDirectory).find(name => name.endsWith('.exe'))!);
}
describe('portable update consent and verified installation', () => {
  it('only reads metadata until explicit consent for the offered version', async () => {
    const f = fixture();
    expect(f.updater.autoDownload).toBe(false);
    expect(f.updater.autoInstallOnAppQuit).toBe(false);
    await f.updater.checkForUpdates();
    await f.updater.checkForUpdates();
    expect(f.request.mock.calls.every(([url]) => String(url).includes('api.github.com'))).toBe(true);
    expect(f.updater.hasReadyUpdate).toBe(false);
    expect(fs.existsSync(f.cacheDirectory)).toBe(false);
    await expect(f.updater.downloadUpdate('1.11.12')).rejects.toThrow('consent');
    expect(f.install).not.toHaveBeenCalled();
    await f.updater.downloadUpdate('1.11.11');
    expect(f.updater.hasReadyUpdate).toBe(true);
    expect(f.install).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled();
  });
  it('installs only the explicitly selected version and quits after helper acknowledgement', async () => {
    const f = fixture(); await download(f);
    expect(() => f.updater.quitAndInstall()).toThrow('consent');
    expect(() => f.updater.quitAndInstall('1.11.12')).toThrow('consent');
    let acknowledge!: () => void;
    f.install.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    f.updater.quitAndInstall('1.11.11'); f.updater.quitAndInstall('1.11.11');
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.install).toHaveBeenCalledOnce();
    expect(f.install).toHaveBeenCalledWith(expect.objectContaining({ target: f.target, version: '1.11.11', sha256: f.sha256, relaunch: true }));
    acknowledge(); await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.updater.hasReadyUpdate).toBe(false);
    expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
  });
  it('restores a downloaded update on the next launch without network requests or installation', async () => {
    const f = fixture(); await download(f); f.request.mockClear();
    const next = f.reopen(); const ready = vi.fn(); next.on('update-downloaded', ready);
    await next.checkForUpdates(); await next.checkForUpdates();
    expect(next.hasReadyUpdate).toBe(true); expect(ready).toHaveBeenCalledTimes(2);
    expect(f.request).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
    expect(f.quit).not.toHaveBeenCalled(); expect(fs.readFileSync(f.target, 'utf8')).toBe('original portable');
  });
  it.each(['missing', 'tampered', 'traversal', 'old-version'])('rejects a %s saved update without redownloading it', async failure => {
    const f = fixture(); await download(f);
    if(failure === 'missing') fs.unlinkSync(executable(f));
    if(failure === 'tampered') fs.writeFileSync(executable(f), 'tampered');
    const manifest = path.join(f.cacheDirectory,'ready-update.json');
    const saved=JSON.parse(fs.readFileSync(manifest,'utf8'));
    if(failure === 'traversal') saved.file='../original.exe';
    if(failure === 'old-version') { saved.version='1.11.9'; saved.file=saved.file.replace('1.11.11','1.11.9'); }
    fs.writeFileSync(manifest, JSON.stringify(saved)); f.request.mockClear();
    const next=f.reopen(); await next.checkForUpdates();
    expect(next.hasReadyUpdate).toBe(false); expect(f.request).toHaveBeenCalledOnce();
    expect(f.install).not.toHaveBeenCalled();
  });
  it('cancels an in-flight download, removes partial bytes and requires another click to retry', async () => {
    const f = fixture(); await f.updater.checkForUpdates();
    let started!: () => void; const firstChunk = new Promise<void>(resolve => { started=resolve; });
    f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release)
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(f.binary.subarray(0,256)); started(); } })));
    const pending=f.updater.downloadUpdate('1.11.11'); await firstChunk;
    f.updater.cancelDownload(); await pending;
    expect(f.events.at(-1)?.name).toBe('download-cancelled'); expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
    expect(f.updater.hasReadyUpdate).toBe(false); expect(f.install).not.toHaveBeenCalled();
    f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release) : new Response(f.binary));
    await f.updater.checkForUpdates(); expect(f.updater.hasReadyUpdate).toBe(false);
    await f.updater.downloadUpdate('1.11.11'); expect(f.updater.hasReadyUpdate).toBe(true);
  });
  it('cancels while committing the verified cache and does not restore the cancelled update', async () => {
    const f=fixture(); await f.updater.checkForUpdates();
    const rename=fs.promises.rename.bind(fs.promises);
    const spy=vi.spyOn(fs.promises,'rename').mockImplementation(async (source,destination) => {
      await rename(source,destination);
      if(String(destination).endsWith('ready-update.json')) f.updater.cancelDownload();
    });
    try { await f.updater.downloadUpdate('1.11.11'); } finally { spy.mockRestore(); }
    expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
    const next=f.reopen(); await next.checkForUpdates(); expect(next.hasReadyUpdate).toBe(false);
  });
  it('accepts the 32-bit NSIS launcher used by an x64 portable', async () => {
    const f=fixture(); f.binary.writeUInt16LE(0x14c,132);
    f.asset.digest='sha256:'+createHash('sha256').update(f.binary).digest('hex');
    await download(f); expect(f.updater.hasReadyUpdate).toBe(true);
  });
  it('uses SHA256SUMS.txt only after consent if GitHub has no digest', async () => {
    const f=fixture(); f.asset.digest=null; const sums=f.sha256+'  '+f.asset.name+'\n';
    f.release.assets.push({name:'SHA256SUMS.txt',size:Buffer.byteLength(sums),digest:null,
      browser_download_url:'https://github.com/lorxray/backspace-revork/releases/download/desktop-v1.11.11-revork.1/SHA256SUMS.txt'});
    f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release)
      : String(input).endsWith('SHA256SUMS.txt') ? new Response(sums) : new Response(f.binary));
    await f.updater.checkForUpdates(); expect(f.request).toHaveBeenCalledOnce();
    await f.updater.downloadUpdate('1.11.11'); expect(f.request).toHaveBeenCalledTimes(3); expect(f.updater.hasReadyUpdate).toBe(true);
  });
  it.each(['checksum','size','executable','interrupted','no-checksum'])('discards a failed %s download and preserves the original', async failure => {
    const f=fixture();
    if(failure==='checksum') f.asset.digest='sha256:'+'0'.repeat(64);
    if(failure==='size') f.asset.size+=10;
    if(failure==='no-checksum') f.asset.digest=null;
    if(failure==='executable') { f.binary.fill(0); f.asset.digest='sha256:'+createHash('sha256').update(f.binary).digest('hex'); }
    if(failure==='interrupted') f.request.mockImplementation(async input => String(input).includes('api.github.com') ? Response.json(f.release)
      : new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection lost')); } })));
    await f.updater.checkForUpdates(); await expect(f.updater.downloadUpdate('1.11.11')).rejects.toThrow();
    expect(f.updater.hasReadyUpdate).toBe(false); expect(fs.readFileSync(f.target,'utf8')).toBe('original portable');
    if(fs.existsSync(f.cacheDirectory)) expect(fs.readdirSync(f.cacheDirectory)).toEqual([]);
    expect(f.events.some(e=>e.name==='update-downloaded')).toBe(false); expect(f.quit).not.toHaveBeenCalled();
  });
  it.each(['foreign-url','duplicate','oversized'])('refuses %s metadata before offering download', async failure => {
    const f=fixture();
    if(failure==='foreign-url') f.asset.browser_download_url='https://github.com/another/project/fake.exe';
    if(failure==='duplicate') f.release.assets.push({...f.asset});
    if(failure==='oversized') f.asset.size=600*1024*1024;
    await expect(f.updater.checkForUpdates()).rejects.toThrow(); expect(f.request).toHaveBeenCalledOnce();
    expect(f.updater.hasReadyUpdate).toBe(false); expect(f.quit).not.toHaveBeenCalled();
  });
  it('keeps the app open and the verified cache when preparing installation fails', async () => {
    const f=fixture(); await download(f); f.install.mockRejectedValue(new Error('Folder is read-only'));
    f.updater.quitAndInstall('1.11.11'); await vi.waitFor(()=>expect(f.events.at(-1)?.name).toBe('error'));
    expect(f.quit).not.toHaveBeenCalled(); expect(f.updater.installing).toBe(false); expect(f.updater.hasReadyUpdate).toBe(true);
  });
  it('refuses installation with no verified download', () => {
    const f=fixture(); expect(()=>f.updater.quitAndInstall('1.11.11')).toThrow('No verified portable'); expect(f.quit).not.toHaveBeenCalled();
  });
  it('detects altered bytes before starting a helper or changing the original', async () => {
    const f=fixture(); await download(f); const updateFile=executable(f);
    expect(await fileSha256(updateFile)).toBe(f.sha256); fs.writeFileSync(updateFile,'tampered');
    await expect(launchPortableReplacement({target:f.target,version:'1.11.11',updateFile,sha256:f.sha256,cacheDirectory:f.cacheDirectory,relaunch:true})).rejects.toThrow('checksum changed');
    expect(fs.readFileSync(f.target,'utf8')).toBe('original portable'); expect(fs.readdirSync(f.root).filter(name=>name.startsWith('.backspace'))).toEqual([]);
  });
});

describe('portable executable version names', () => {
  it('advances standard versioned names and preserves user-chosen names', () => {
    const f = fixture();
    expect(portableInstallDestination(path.join(f.root, 'Backspace-1.11.15-portable-x64.exe'), '1.11.17'))
      .toBe(path.join(f.root, 'Backspace-1.11.17-portable-x64.exe'));
    expect(portableInstallDestination(f.target, '1.11.17')).toBe(f.target);
    expect(() => portableInstallDestination(f.target, '../client')).toThrow('version');
  });

  it('refuses to overwrite an existing versioned executable before quitting', async () => {
    const f = fixture();
    const target = path.join(f.root, 'Backspace-1.11.10-portable-x64.exe');
    const destination = path.join(f.root, 'Backspace-1.11.11-portable-x64.exe');
    fs.writeFileSync(target, 'original'); fs.writeFileSync(destination, 'unrelated existing file');
    await expect(launchPortableReplacement({ target, version: '1.11.11', updateFile: target,
      sha256: await fileSha256(target), cacheDirectory: f.cacheDirectory, relaunch: true })).rejects.toThrow('already exists');
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(fs.readFileSync(destination, 'utf8')).toBe('unrelated existing file');
  });

  it.each(['success', 'failed', 'tampered', 'new-helper', 'already-attempted', 'pending'])('repairs a legacy %s install at most once', async mode => {
    const f = fixture();
    const target = path.join(f.root, 'Backspace-1.11.15-portable-x64.exe');
    fs.writeFileSync(target, f.binary);
    const directory = path.join(f.cacheDirectory, 'install-12345678-1234-1234-1234-123456789abc');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ Target: target,
      Sha256: mode === 'tampered' ? '0'.repeat(64) : f.sha256,
      ...(mode === 'new-helper' ? { Destination: target } : {}),
    }));
    const saveResult = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ success: mode !== 'failed' }));
    if (mode === 'pending') setTimeout(saveResult, 50); else saveResult();
    if (mode === 'already-attempted') fs.writeFileSync(path.join(directory, 'filename-repair-attempted'), '1.11.17');
    const launch = vi.fn().mockResolvedValue({ configPath: '', pid: 1 });
    const options = { target, version: '1.11.17', cacheDirectory: f.cacheDirectory };
    const shouldRepair = mode === 'success' || mode === 'pending';
    expect(await repairLegacyPortableName(options, launch)).toBe(shouldRepair);
    if (shouldRepair) expect(launch).toHaveBeenCalledWith(expect.objectContaining({ target, version: '1.11.17', updateFile: target, sha256: f.sha256 }));
    else expect(launch).not.toHaveBeenCalled();
    expect(await repairLegacyPortableName(options, launch)).toBe(false);
    expect(launch).toHaveBeenCalledTimes(shouldRepair ? 1 : 0);
  });
});
