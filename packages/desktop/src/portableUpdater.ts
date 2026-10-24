import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { DESKTOP_UPDATE_FEED, ManualDesktopUpdater, isNewerDesktopVersion } from './desktopUpdates';
import { fileSha256, launchPortableReplacement, type PortableInstall } from './portableUpdateInstaller';

interface ReleaseAsset { name: string; browser_download_url: string; size: number; digest?: string | null }
interface PortableRelease { tag_name: string; assets: ReleaseAsset[] }

function assetUrl(release: PortableRelease, asset: ReleaseAsset): string {
  const expected = `https://github.com/${DESKTOP_UPDATE_FEED.owner}/${DESKTOP_UPDATE_FEED.repo}/releases/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`;
  if (asset.browser_download_url !== expected) throw new Error('Portable update asset is outside the configured release');
  return expected;
}

export function portableReleaseAsset(value: unknown, version: string): { release: PortableRelease; asset: ReleaseAsset } {
  const release = value as PortableRelease;
  const matches = release.assets.filter(asset => asset.name === `Backspace-${version}-portable-x64.exe`);
  if (matches.length !== 1) throw new Error('Release has no unique Windows x64 portable');
  const asset = matches[0]!;
  assetUrl(release, asset);
  if (!Number.isSafeInteger(asset.size) || asset.size < 512 || asset.size > 512 * 1024 * 1024) throw new Error('Invalid portable update size');
  return { release, asset };
}

async function verifyWindowsExecutable(file: string): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    const read = await handle.read(header, 0, header.length, 0);
    if (read.bytesRead !== 64 || header.toString('ascii', 0, 2) !== 'MZ') throw new Error('Update is not a Windows executable');
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset > (await handle.stat()).size - 6) throw new Error('Invalid Windows executable header');
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, pe.length, offset);
    // electron-builder's x64 portable has a 32-bit NSIS launcher around x64 Electron.
    if (pe.readUInt32LE(0) !== 0x4550 || ![0x14c, 0x8664].includes(pe.readUInt16LE(4))) throw new Error('Update has an unsupported Windows executable header');
  } finally { await handle.close(); }
}

export interface PortableUpdaterOptions {
  currentVersion: string;
  target: string;
  cacheDirectory: string;
  quit: () => void;
  request?: typeof fetch;
  install?: (options: PortableInstall) => Promise<unknown>;
}

export class PortableDesktopUpdater extends ManualDesktopUpdater {
  override autoDownload = false;
  override autoInstallOnAppQuit = false;
  private ready: { file: string; version: string; sha256: string } | null = null;
  private available: { release: unknown; version: string } | null = null;
  private download: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private restored: Promise<void> | null = null;
  installing = false;

  constructor(private readonly options: PortableUpdaterOptions) { super(options.currentVersion, options.request); }

  get hasReadyUpdate(): boolean { return this.ready !== null; }

  override async checkForUpdates(): Promise<void> {
    if (this.installing || this.download) return;
    this.restored ??= this.restoreReady();
    await this.restored;
    if (this.ready) {
      this.emit('update-downloaded', { version: this.ready.version });
      return;
    }
    return super.checkForUpdates();
  }

  protected override async handleNewRelease(value: unknown, version: string): Promise<void> {
    portableReleaseAsset(value, version);
    this.available = { release: value, version };
    this.emit('update-available', { version });
  }

  private async restoreReady(): Promise<void> {
    try {
      const saved = JSON.parse(await fs.promises.readFile(path.join(this.options.cacheDirectory, 'ready-update.json'), 'utf8')) as Record<string, unknown>;
      if (typeof saved.file !== 'string' || !/^\d+\.\d+\.\d+-[a-f0-9-]{36}\.exe$/.test(saved.file)
        || typeof saved.version !== 'string' || !saved.file.startsWith(`${saved.version}-`)
        || typeof saved.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(saved.sha256)
        || !isNewerDesktopVersion(saved.version, this.currentVersion)) return;
      const file = path.join(this.options.cacheDirectory, saved.file);
      if (!(await fs.promises.lstat(file)).isFile() || await fileSha256(file) !== saved.sha256) return;
      await verifyWindowsExecutable(file);
      this.ready = { file, version: saved.version, sha256: saved.sha256 };
    } catch { /* Missing/invalid saved files never authorize a download or install. */ }
  }

  downloadUpdate(version: string): Promise<void> {
    if (this.download) return this.download;
    if (this.installing || this.ready || !this.available || this.available.version !== version) return Promise.reject(new Error('Download consent does not match the offered version'));
    const controller = new AbortController();
    this.controller = controller;
    this.download = this.performDownload(this.available.release, version, controller.signal)
      .catch(error => {
        if (controller.signal.aborted) this.emit('download-cancelled', { version });
        else this.emit('error', error);
        if (!controller.signal.aborted) throw error;
      })
      .finally(() => { this.download = null; this.controller = null; });
    return this.download;
  }

  cancelDownload(): void { this.controller?.abort(); }

  private async performDownload(value: unknown, version: string, signal: AbortSignal): Promise<void> {
    const { release, asset } = portableReleaseAsset(value, version);
    this.emit('download-started', { version });
    let expectedHash: string;
    if (asset.digest != null) {
      const match = /^sha256:([a-f0-9]{64})$/.exec(asset.digest);
      if (!match) throw new Error('Invalid portable update digest');
      expectedHash = match[1]!;
    } else {
      const sums = release.assets.find(item => item.name === 'SHA256SUMS.txt');
      if (!sums || !Number.isSafeInteger(sums.size) || sums.size < 1 || sums.size > 65536) throw new Error('Portable update has no SHA-256 checksum');
      const response = await this.request(assetUrl(release, sums), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error(`Update checksum download failed (HTTP ${response.status})`);
      const body = await response.arrayBuffer();
      if (body.byteLength > 65536) throw new Error('Update checksum file is too large');
      const line = Buffer.from(body).toString('utf8').split(/\r?\n/).find(item => item.slice(66) === asset.name);
      if (!line || !/^[a-f0-9]{64}  /.test(line)) throw new Error('Portable checksum is missing');
      expectedHash = line.slice(0, 64);
    }
    await fs.promises.mkdir(this.options.cacheDirectory, { recursive: true });
    for (const entry of await fs.promises.readdir(this.options.cacheDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^\d+\.\d+\.\d+-[a-f0-9-]{36}\.(?:part|exe)$/.test(entry.name)) {
        await fs.promises.rm(path.join(this.options.cacheDirectory, entry.name), { force: true });
      }
    }
    const part = path.join(this.options.cacheDirectory, `${version}-${randomUUID()}.part`);
    const destination = part.slice(0, -5) + '.exe';
    const manifest = path.join(this.options.cacheDirectory, 'ready-update.json');
    let manifestWritten = false;
    try {
      signal.throwIfAborted();
      const response = await this.request(assetUrl(release, asset), { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]) });
      if (!response.ok || !response.body) throw new Error(`Portable download failed (HTTP ${response.status})`);
      const file = await fs.promises.open(part, 'wx', 0o600);
      const reader = response.body.getReader();
      const abortReader = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', abortReader, { once: true });
      const hash = createHash('sha256');
      let bytes = 0;
      const started = Date.now();
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value: chunk } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          bytes += chunk.byteLength;
          if (bytes > asset.size) throw new Error('Portable download exceeds release size');
          hash.update(chunk);
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await file.write(chunk, offset, chunk.byteLength - offset);
            if (!written.bytesWritten) throw new Error('Could not write the portable update');
            offset += written.bytesWritten;
          }
          this.emit('download-progress', { percent: bytes / asset.size * 100, bytesPerSecond: bytes / Math.max((Date.now() - started) / 1000, 0.001) });
        }
        if (bytes !== asset.size || hash.digest('hex') !== expectedHash) throw new Error('Portable download checksum or size mismatch');
        await file.sync();
      } finally {
        signal.removeEventListener('abort', abortReader);
        await file.close();
        await reader.cancel().catch(() => {});
      }
      if (await fileSha256(part) !== expectedHash) throw new Error('Saved portable checksum mismatch');
      await verifyWindowsExecutable(part);
      signal.throwIfAborted();
      await fs.promises.rename(part, destination);
      signal.throwIfAborted();
      const metadata = { file: path.basename(destination), version, sha256: expectedHash };
      await fs.promises.writeFile(`${manifest}.tmp`, JSON.stringify(metadata), 'utf8');
      signal.throwIfAborted();
      await fs.promises.rename(`${manifest}.tmp`, manifest);
      manifestWritten = true;
      signal.throwIfAborted();
      this.ready = { file: destination, version, sha256: expectedHash };
      this.emit('update-downloaded', { version });
    } catch (error) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      await fs.promises.rm(destination, { force: true }).catch(() => {});
      await fs.promises.rm(`${manifest}.tmp`, { force: true }).catch(() => {});
      if (manifestWritten) await fs.promises.rm(manifest, { force: true }).catch(() => {});
      throw error;
    }
  }

  override quitAndInstall(version?: string): void {
    if (this.installing) return;
    if (!this.ready) throw new Error('No verified portable update is ready');
    if (version !== this.ready.version) throw new Error('Install consent does not match the downloaded version');
    this.installing = true;
    const ready = this.ready;
    const install = this.options.install ?? launchPortableReplacement;
    void install({ target: this.options.target, version: ready.version, updateFile: ready.file, sha256: ready.sha256, cacheDirectory: this.options.cacheDirectory, relaunch: true })
      .then(async () => {
        this.ready = null;
        await fs.promises.rm(ready.file, { force: true }).catch(() => {});
        await fs.promises.rm(path.join(this.options.cacheDirectory, 'ready-update.json'), { force: true }).catch(() => {});
        this.options.quit();
      })
      .catch(error => {
        this.installing = false;
        this.emit('error', error);
      });
  }
}
