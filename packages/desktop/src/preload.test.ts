import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({ exposeInMainWorld: vi.fn() }));
const ipc = vi.hoisted(() => ({ on: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ contextBridge: bridge, ipcRenderer: ipc }));

const originalArgv = process.argv;

beforeEach(() => {
  vi.resetModules();
  bridge.exposeInMainWorld.mockReset();
  ipc.on.mockReset();
  ipc.send.mockReset();
});

afterEach(() => {
  process.argv = originalArgv;
});

describe('bundled web client bridge', () => {
  it('signals bundled mode before the renderer starts only for the main-process flag', async () => {
    process.argv = [...originalArgv, '--backspace-bundled-web-client'];
    await import('./preload');

    expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('backspace', expect.objectContaining({
      bundledWebClient: true,
    }));
  });

  it('preserves remote interface mode when the flag is absent', async () => {
    process.argv = originalArgv.filter((arg) => arg !== '--backspace-bundled-web-client');
    await import('./preload');

    expect(bridge.exposeInMainWorld).toHaveBeenCalledWith('backspace', expect.objectContaining({
      bundledWebClient: false,
    }));
  });

  it('announces deep-link readiness only after subscribing to the event', async () => {
    await import('./preload');
    const api = bridge.exposeInMainWorld.mock.calls[0]![1] as { onDeepLink(callback: (url: string) => void): void };
    expect(ipc.send).not.toHaveBeenCalled();
    const callback = vi.fn();
    api.onDeepLink(callback);
    expect(ipc.on).toHaveBeenCalledWith('deep-link', expect.any(Function));
    expect(ipc.send).toHaveBeenCalledWith('deep-link-listener-ready');
    expect(ipc.on.mock.invocationCallOrder[0]).toBeLessThan(ipc.send.mock.invocationCallOrder[0]!);
  });
});
