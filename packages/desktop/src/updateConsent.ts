import type { UpdateSnapshot } from './updateStatus';

export function canDownloadUpdate(snapshot: UpdateSnapshot, version: unknown): version is string {
  return snapshot.capability === 'auto' && snapshot.status.phase === 'available' && snapshot.status.version === version;
}

export async function installWithConsent(
  snapshot: () => UpdateSnapshot,
  version: string,
  warnAboutCall: boolean,
  confirm: () => Promise<boolean>,
  install: (version: string) => void,
): Promise<void> {
  const matches = () => {
    const current = snapshot();
    return current.capability === 'auto' && current.status.phase === 'ready' && current.status.version === version;
  };
  if (!matches()) return;
  if (warnAboutCall && !await confirm()) return;
  if (matches()) install(version);
}
