import type { DesktopCapturerSource, SourcesOptions } from 'electron';
import { screenEnumerationDecision } from './screenSharePolicy';

export interface SerializedScreenSource {
  id: string;
  name: string;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  isScreen: boolean;
}

export function serializeScreenSources(sources: DesktopCapturerSource[]): SerializedScreenSource[] {
  return sources.map(source => ({
    id: source.id,
    name: source.name,
    thumbnailDataUrl: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIconDataUrl: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
    isScreen: source.id.startsWith('screen:'),
  }));
}

/** Separate metadata from previews: a slow window capture must not block selection. */
export function createScreenSourceCatalog(
  getSources: (options: SourcesOptions) => Promise<DesktopCapturerSource[]>,
  now: () => number = Date.now,
  onEnumerated?: (previews: boolean, count: number, elapsedMs: number) => void,
) {
  const createEntry = () => ({
    at: null as number | null,
    serialized: [] as SerializedScreenSource[],
    pending: null as Promise<DesktopCapturerSource[]> | null,
  });
  let entries = { list: createEntry(), previews: createEntry() };
  let sources: DesktopCapturerSource[] = [];

  const enumerate = (previews = true): Promise<DesktopCapturerSource[]> => {
    const entry = previews ? entries.previews : entries.list;
    if (entry.pending) return entry.pending;
    const started = now();
    const pending = getSources({
      types: ['screen', 'window'],
      thumbnailSize: previews ? { width: 320, height: 180 } : { width: 0, height: 0 },
      fetchWindowIcons: previews,
    }).then(result => {
      // clear() also invalidates work still running when a capture is answered.
      if (entry === (previews ? entries.previews : entries.list)) {
        sources = result;
        entry.serialized = serializeScreenSources(result);
        entry.at = now();
      }
      onEnumerated?.(previews, result.length, now() - started);
      return result;
    }).finally(() => { entry.pending = null; });
    entry.pending = pending;
    return pending;
  };

  return {
    enumerate,
    find: (id: string) => sources.find(source => source.id === id),
    async read(access: { fromMainWindow: boolean; windowFocused: boolean }, previews = true) {
      const entry = previews ? entries.previews : entries.list;
      const decision = screenEnumerationDecision({ ...access, lastEnumeratedAt: entry.at, now: now() });
      if (decision === 'deny') return [];
      if (decision === 'serve-cache') return entry.serialized;
      return serializeScreenSources(await enumerate(previews));
    },
    clear() {
      entries = { list: createEntry(), previews: createEntry() };
      sources = [];
    },
  };
}
