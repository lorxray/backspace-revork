import { describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_RELEASE_API_URL, ManualDesktopUpdater, desktopReleaseVersion, isNewerDesktopVersion,
} from './desktopUpdates';

function release(version = '1.11.10') {
  return {
    draft: false, prerelease: false, tag_name: `desktop-v${version}-revork.1`,
    assets: [{ name: `Backspace-${version}-portable-x64.exe` }],
  };
}

describe('desktop release discovery', () => {
  it('reads the custom desktop release tag and requires a matching application asset', () => {
    expect(desktopReleaseVersion(release())).toBe('1.11.10');
    expect(() => desktopReleaseVersion({ ...release(), assets: [{ name: 'Backspace-1.11.9-portable-x64.exe' }] }))
      .toThrow('no desktop application build');
  });

  it.each(['v1.11.10', '1.11.10'])('also accepts an ordinary stable tag %s', tag_name => {
    expect(desktopReleaseVersion({ ...release(), tag_name })).toBe('1.11.10');
  });

  it.each([
    null,
    { ...release(), draft: true },
    { ...release(), prerelease: true },
    { ...release(), tag_name: 'v1.11.10-beta.1' },
    { ...release(), tag_name: 'desktop-v1.11.10-revork.1-extra' },
    { ...release(), assets: [{ name: 'server-image.tar' }] },
  ])('rejects unpublished, malformed or non-desktop release %#', value => {
    expect(() => desktopReleaseVersion(value)).toThrow();
  });

  it.each([
    ['1.11.10', '1.11.9', true],
    ['1.12.0', '1.11.9', true],
    ['2.0.0', '1.11.9', true],
    ['1.11.9', '1.11.9', false],
    ['1.11.7', '1.11.9', false],
  ] as const)('compares %s with %s numerically', (next, current, expected) => {
    expect(isNewerDesktopVersion(next, current)).toBe(expected);
  });
});

describe('manual desktop updates', () => {
  function fixture(request: typeof fetch) {
    const updater = new ManualDesktopUpdater('1.11.9', request);
    const events: Array<[string, unknown?]> = [];
    for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'error']) {
      updater.on(name, info => events.push([name, info]));
    }
    return { updater, events };
  }

  it('checks only the fork API and reports the new portable without downloading it', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release()));
    const { updater, events } = fixture(request);
    await updater.checkForUpdates();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe('https://api.github.com/repos/lorxray/backspace-revork/releases/latest');
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    expect(events).toEqual([['checking-for-update', undefined], ['update-available', { version: '1.11.10' }]]);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it.each(['1.11.7', '1.11.9'])('does not offer an older or equal published version %s', async version => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release(version)));
    const { updater, events } = fixture(request);
    await updater.checkForUpdates();
    expect(events.at(-1)).toEqual(['update-not-available', { version }]);
  });

  it('coalesces overlapping checks, then allows a later check', async () => {
    let resolve!: (value: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(complete => { resolve = complete; }));
    const { updater } = fixture(request);
    const first = updater.checkForUpdates();
    expect(updater.checkForUpdates()).toBe(first);
    resolve(Response.json(release()));
    await first;
    const second = updater.checkForUpdates();
    expect(request).toHaveBeenCalledTimes(2);
    resolve(Response.json(release()));
    await second;
  });

  it('reports a rate limit as failure and can retry without claiming an up-to-date result', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(Response.json(release()));
    const { updater, events } = fixture(request);
    await expect(updater.checkForUpdates()).rejects.toThrow('HTTP 403');
    expect(events.map(([name]) => name)).toEqual(['checking-for-update', 'error']);
    await updater.checkForUpdates();
    expect(events.at(-1)).toEqual(['update-available', { version: '1.11.10' }]);
  });

  it('reports a transport or timeout failure through the existing updater error event', async () => {
    const failure = new Error('Connection timed out');
    const request = vi.fn<typeof fetch>().mockRejectedValue(failure);
    const { updater, events } = fixture(request);
    await expect(updater.checkForUpdates()).rejects.toBe(failure);
    expect(events.at(-1)).toEqual(['error', failure]);
    expect(request).toHaveBeenCalledWith(DESKTOP_RELEASE_API_URL, expect.anything());
  });
});
