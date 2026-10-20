import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DesktopPanel } from './DesktopPanel';

const store = vi.hoisted(() => ({
  initialize: vi.fn(),
  snapshot: {
    capability: 'external' as const,
    dismissedVersion: null,
    status: { phase: 'idle' as const },
  },
  currentVersion: '1.0.5',
  checkNow: vi.fn(),
  install: vi.fn(),
  openDownloadPage: vi.fn(),
}));

vi.mock('../../../stores/updateStore', () => ({
  useUpdateStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

function installHost(sandboxed: boolean, bundledWebClient?: boolean) {
  const isSandboxed = vi.fn().mockResolvedValue(sandboxed);
  const getAutoLaunchSettings = vi.fn().mockResolvedValue({
    openAtLogin: false,
    startMinimized: true,
  });
  Object.defineProperty(window, 'backspace', {
    configurable: true,
    writable: true,
    value: {
      bundledWebClient,
      isSandboxed,
      getAutoLaunchSettings,
      setAutoLaunchSettings: vi.fn(),
      clearInstanceUrl: vi.fn(),
    },
  });
  return { isSandboxed, getAutoLaunchSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DesktopPanel bundled client source', () => {
  it('offers the fork source and desktop version for the bundled interface', async () => {
    installHost(true, true);
    render(<DesktopPanel />);

    const source = screen.getByRole('link', { name: /Source code \(AGPL\)/ });
    expect(source).toHaveAttribute('href', 'https://github.com/lorxray/backspace-revork');
    expect(source).toHaveTextContent('v1.0.5');
    await waitFor(() => expect(store.initialize).toHaveBeenCalled());
  });

  it('keeps the existing instance source offer for remote interface builds', async () => {
    installHost(true);
    render(<DesktopPanel />);

    expect(screen.queryByRole('link', { name: /Source code \(AGPL\)/ })).not.toBeInTheDocument();
    await waitFor(() => expect(store.initialize).toHaveBeenCalled());
  });
});

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'backspace');
});

describe('DesktopPanel auto-launch capability', () => {
  it('hides auto-launch controls inside a package sandbox', async () => {
    const host = installHost(true);
    render(<DesktopPanel />);

    await waitFor(() => expect(host.isSandboxed).toHaveBeenCalledOnce());
    expect(screen.queryByText('Start at boot')).not.toBeInTheDocument();
    expect(host.getAutoLaunchSettings).not.toHaveBeenCalled();
  });

  it('shows auto-launch controls when external updates are not caused by a sandbox', async () => {
    const host = installHost(false);
    render(<DesktopPanel />);

    expect(await screen.findByText('Start at boot')).toBeInTheDocument();
    expect(host.getAutoLaunchSettings).toHaveBeenCalledOnce();
  });
});
