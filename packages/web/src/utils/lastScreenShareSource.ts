/**
 * Desktop source handles are kept only for this renderer session. In
 * particular, a persisted window handle may have been reused after a restart.
 * Names/icons provide an additional check against a changed desktop source.
 * Thumbnails are deliberately excluded: their pixels change continuously.
 */
export type LastScreenShareSource = Pick<ElectronScreenSource, 'id' | 'name' | 'isScreen' | 'appIconDataUrl'>;

let lastSource: LastScreenShareSource | null = null;

export function rememberScreenShareSource(source: LastScreenShareSource | null): void {
  lastSource = source ? {
    id: source.id,
    name: source.name,
    isScreen: source.isScreen,
    appIconDataUrl: source.appIconDataUrl,
  } : null;
}

export function getLastScreenShareSource(): LastScreenShareSource | null {
  return lastSource;
}

export function matchesLastScreenShareSource(source: ElectronScreenSource, saved: LastScreenShareSource): boolean {
  return source.id === saved.id && source.name === saved.name
    && source.isScreen === saved.isScreen && source.appIconDataUrl === saved.appIconDataUrl;
}
