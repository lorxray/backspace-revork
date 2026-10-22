import { EventEmitter } from 'events';

export const DESKTOP_UPDATE_FEED = {
  provider: 'github' as const,
  owner: 'lorxray',
  repo: 'backspace-revork',
};
export const DESKTOP_RELEASES_URL = `https://github.com/${DESKTOP_UPDATE_FEED.owner}/${DESKTOP_UPDATE_FEED.repo}/releases/latest`;
export const DESKTOP_RELEASE_API_URL = `https://api.github.com/repos/${DESKTOP_UPDATE_FEED.owner}/${DESKTOP_UPDATE_FEED.repo}/releases/latest`;

function versionParts(version: string): number[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid desktop release version');
  const parts = version.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('Invalid desktop release version');
  return parts;
}

export function isNewerDesktopVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const previous = versionParts(current);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== previous[index]) return next[index]! > previous[index]!;
  }
  return false;
}

/** Accept the approved desktop tag convention as well as ordinary stable tags. */
export function desktopReleaseVersion(value: unknown): string {
  const release = value as { draft?: unknown; prerelease?: unknown; tag_name?: unknown; assets?: unknown } | null;
  if (!release || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
    throw new Error('No published stable desktop release');
  }
  const match = /^(?:v?(\d+\.\d+\.\d+)|desktop-v(\d+\.\d+\.\d+)-revork\.\d+)$/.exec(release.tag_name);
  const version = match?.[1] ?? match?.[2];
  if (!version) throw new Error('Invalid desktop release tag');
  versionParts(version);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const hasDesktopBuild = assets.some((asset: unknown) => {
    const name = (asset as { name?: unknown } | null)?.name;
    return typeof name === 'string' && name.startsWith(`Backspace-${version}-`)
      && /^(?:portable-x64\.exe|win-(?:x64|arm64)\.(?:exe|zip)|mac-(?:x64|arm64)\.dmg|linux-(?:x86_64|arm64)\.AppImage|linux-(?:amd64|arm64)\.deb)$/.test(name.slice(`Backspace-${version}-`.length));
  });
  if (!hasDesktopBuild) throw new Error('The latest release has no desktop application build');
  return version;
}

/** Portable/manual builds have no installer feed or latest.yml to consume. */
export class ManualDesktopUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  private pending: Promise<void> | null = null;

  constructor(protected readonly currentVersion: string, protected readonly request: typeof fetch = fetch) {
    super();
  }

  checkForUpdates(): Promise<void> {
    if (this.pending) return this.pending;
    this.emit('checking-for-update');
    this.pending = this.check().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async check(): Promise<void> {
    try {
      const response = await this.request(DESKTOP_RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Backspace-Desktop' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`Desktop release check failed (HTTP ${response.status})`);
      const release: unknown = await response.json();
      const version = desktopReleaseVersion(release);
      if (isNewerDesktopVersion(version, this.currentVersion)) await this.handleNewRelease(release, version);
      else this.emit('update-not-available', { version });
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  protected async handleNewRelease(_release: unknown, version: string): Promise<void> {
    this.emit('update-available', { version });
  }

  quitAndInstall(): void {
    throw new Error('This build requires a manual download from the desktop release page');
  }
}
