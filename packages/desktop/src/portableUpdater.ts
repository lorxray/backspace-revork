import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { DESKTOP_UPDATE_FEED, ManualDesktopUpdater } from './desktopUpdates';
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
  override autoDownload = true;
  override autoInstallOnAppQuit = true;
  private ready: { file: string; version: string; sha256: string } | null = null;
  installing = false;

  constructor(private readonly options: PortableUpdaterOptions) { super(options.currentVersion, options.request); }

  get hasReadyUpdate(): boolean { return this.ready !== null; }

  override checkForUpdates(): Promise<void> {
    return this.installing ? Promise.resolve() : super.checkForUpdates();
  }

  protected override async handleNewRelease(value: unknown, version: string): Promise<void> {
    const { release, asset } = portableReleaseAsset(value, version);
    const previous = this.ready;
    const savedHash = previous ? await fileSha256(previous.file).catch(() => null) : null;
    if (previous?.version === version && savedHash === previous.sha256) {
      this.emit('update-downloaded', { version });
      return;
    }
    this.ready = null;
    if (previous) await fs.promises.rm(previous.file, { force: true }).catch(() => {});
    this.emit('update-available', { version });
    if (!this.autoDownload) return;
    let expectedHash: string;
    if (asset.digest != null) {
      const match = /^sha256:([a-f0-9]{64})$/.exec(asset.digest);
      if (!match) throw new Error('Invalid portable update digest');
      expectedHash = match[1]!;
    } else {
      const sums = release.assets.find(item => item.name === 'SHA256SUMS.txt');
      if (!sums || !Number.isSafeInteger(sums.size) || sums.size < 1 || sums.size > 65536) throw new Error('Portable update has no SHA-256 checksum');
      const response = await this.request(assetUrl(release, sums), { signal: AbortSignal.timeout(15000) });
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
    try {
      const response = await this.request(assetUrl(release, asset), { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`Portable download failed (HTTP ${response.status})`);
      const file = await fs.promises.open(part, 'wx', 0o600);
      const reader = response.body.getReader();
      const hash = createHash('sha256');
      let bytes = 0;
      const started = Date.now();
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
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
        await file.close();
        await reader.cancel().catch(() => {});
      }
      if (await fileSha256(part) !== expectedHash) throw new Error('Saved portable checksum mismatch');
      await verifyWindowsExecutable(part);
      await fs.promises.rename(part, destination);
      this.ready = { file: destination, version, sha256: expectedHash };
      this.emit('update-downloaded', { version });
    } catch (error) {
      await fs.promises.rm(part, { force: true }).catch(() => {});
      throw error;
    }
  }

  override quitAndInstall(relaunch = true): void {
    if (this.installing) return;
    if (!this.ready) throw new Error('No verified portable update is ready');
    this.installing = true;
    const ready = this.ready;
    const install = this.options.install ?? launchPortableReplacement;
    void install({ target: this.options.target, updateFile: ready.file, sha256: ready.sha256, cacheDirectory: this.options.cacheDirectory, relaunch })
      .then(async () => {
        this.ready = null;
        await fs.promises.rm(ready.file, { force: true }).catch(() => {});
        this.options.quit();
      })
      .catch(error => {
        this.installing = false;
        this.emit('error', error);
        if (!relaunch) {
          this.autoInstallOnAppQuit = false;
          this.options.quit();
        }
      });
  }
}
