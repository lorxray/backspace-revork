import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRecoveryAction, setInstanceLoader } from './recovery';

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('./instanceUrl', () => ({ loadInstanceUrl: () => 'https://home.example', getPickerPath: () => '/picker.html' }));

describe('recovery navigation with a bundled interface', () => {
  afterEach(() => { setInstanceLoader(null); });

  it('reloads through the desktop origin/cache setup', () => {
    const navigate = vi.fn();
    setInstanceLoader(navigate);
    handleRecoveryAction('reload');
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://home.example');
  });

  it('opens the picker through the desktop navigation cancellation path', () => {
    const navigate = vi.fn();
    setInstanceLoader(navigate);
    handleRecoveryAction('change-instance');
    expect(navigate).toHaveBeenCalledExactlyOnceWith(null);
  });
});
