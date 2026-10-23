import type { DesktopCapturerSource } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createScreenSourceCatalog } from './screenSourceCatalog';

const focused = { fromMainWindow: true, windowFocused: true };
const source = (preview = false) => ({
  id: 'screen:0:0', name: 'Screen 1', appIcon: null,
  thumbnail: { isEmpty: () => !preview, toDataURL: () => 'data:image/png;base64,preview' },
}) as unknown as DesktopCapturerSource;

describe('screen source catalog', () => {
  it('makes sources selectable without waiting for slow window thumbnails or icons', async () => {
    let finishPreviews!: (sources: DesktopCapturerSource[]) => void;
    const getSources = vi.fn(async options => options.thumbnailSize.width === 0
      ? [source()] : new Promise<DesktopCapturerSource[]>(resolve => { finishPreviews = resolve; }));
    const catalog = createScreenSourceCatalog(getSources);
    const previews = catalog.read(focused);
    expect(await catalog.read(focused, false)).toEqual([expect.objectContaining({ id: 'screen:0:0', thumbnailDataUrl: '' })]);
    expect(getSources).toHaveBeenCalledWith(expect.objectContaining({ thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }));
    expect(catalog.find('screen:0:0')).toBeDefined();
    finishPreviews([source(true)]);
    expect((await previews)[0]!.thumbnailDataUrl).toContain('data:image/png');
  });

  it('deduplicates in-flight scans and throttles metadata and previews separately', async () => {
    const getSources = vi.fn(async () => [source(true)]);
    const catalog = createScreenSourceCatalog(getSources, () => 10_000);
    await Promise.all([catalog.read(focused, false), catalog.read(focused, false)]);
    await catalog.read(focused, false);
    expect(getSources).toHaveBeenCalledTimes(1);
    await catalog.read(focused);
    await catalog.read(focused);
    expect(getSources).toHaveBeenCalledTimes(2);
  });

  it('does not enumerate for another sender or a background app, including during a pending scan', async () => {
    let finish!: (sources: DesktopCapturerSource[]) => void;
    const getSources = vi.fn(() => new Promise<DesktopCapturerSource[]>(resolve => { finish = resolve; }));
    const catalog = createScreenSourceCatalog(getSources);
    const pending = catalog.read(focused, false);
    expect(await catalog.read({ ...focused, fromMainWindow: false }, false)).toEqual([]);
    expect(await catalog.read({ ...focused, windowFocused: false }, false)).toEqual([]);
    expect(getSources).toHaveBeenCalledOnce();
    finish([source()]);
    await pending;
  });

  it('does not repopulate cleared captures when late previews finish', async () => {
    let finish!: (sources: DesktopCapturerSource[]) => void;
    const getSources = vi.fn(() => new Promise<DesktopCapturerSource[]>(resolve => { finish = resolve; }));
    const catalog = createScreenSourceCatalog(getSources);
    const pending = catalog.read(focused);
    catalog.clear();
    finish([source(true)]);
    await pending;
    expect(catalog.find('screen:0:0')).toBeUndefined();
    expect(await catalog.read({ ...focused, windowFocused: false })).toEqual([]);
  });

  it('allows retrying a failed preview without losing selectable metadata', async () => {
    const getSources = vi.fn().mockResolvedValueOnce([source()]).mockRejectedValueOnce(new Error('Window unavailable')).mockResolvedValueOnce([source(true)]);
    const catalog = createScreenSourceCatalog(getSources);
    await catalog.read(focused, false);
    await expect(catalog.read(focused)).rejects.toThrow('Window unavailable');
    expect(catalog.find('screen:0:0')).toBeDefined();
    expect((await catalog.read(focused))[0]!.thumbnailDataUrl).not.toBe('');
  });
});
