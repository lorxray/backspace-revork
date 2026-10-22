import { describe, expect, it, vi } from 'vitest';
import { canDownloadUpdate, installWithConsent } from './updateConsent';
import type { UpdateSnapshot } from './updateStatus';

const snapshot = (phase: 'available' | 'ready', version = '1.11.11'): UpdateSnapshot => ({
  capability: 'auto', dismissedVersion: null, status: { phase, version },
});

describe('separate consent for download and installation', () => {
  it('binds download consent to an offered version on an installable build', () => {
    expect(canDownloadUpdate(snapshot('available'), '1.11.11')).toBe(true);
    expect(canDownloadUpdate(snapshot('available'), '1.11.12')).toBe(false);
    expect(canDownloadUpdate(snapshot('ready'), '1.11.11')).toBe(false);
    expect(canDownloadUpdate({ ...snapshot('available'), capability: 'manual' }, '1.11.11')).toBe(false);
  });
  it('never installs an available but not downloaded version', async () => {
    const install = vi.fn(); const confirm = vi.fn();
    await installWithConsent(() => snapshot('available'), '1.11.11', false, confirm, install);
    expect(confirm).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('installs the ready version on an explicit click outside a call', async () => {
    const install = vi.fn(); const confirm = vi.fn();
    await installWithConsent(() => snapshot('ready'), '1.11.11', false, confirm, install);
    expect(confirm).not.toHaveBeenCalled(); expect(install).toHaveBeenCalledWith('1.11.11');
  });
  it.each([true, false])('requires a second confirmation during a call: %s', async approved => {
    const install = vi.fn(); const confirm = vi.fn().mockResolvedValue(approved);
    await installWithConsent(() => snapshot('ready'), '1.11.11', true, confirm, install);
    expect(confirm).toHaveBeenCalledOnce(); expect(install).toHaveBeenCalledTimes(approved ? 1 : 0);
  });
  it('does not reuse a confirmation if the ready version changes while the dialog is open', async () => {
    let current = snapshot('ready'); const install = vi.fn();
    await installWithConsent(() => current, '1.11.11', true, async () => {
      current = snapshot('ready', '1.11.12'); return true;
    }, install);
    expect(install).not.toHaveBeenCalled();
  });
});
