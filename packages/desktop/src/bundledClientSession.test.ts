import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { installBundledClientSession } from './bundledClientSession';
import type { BundledWebClient } from './bundledWebClient';

function setup(initialUrl = 'about:blank') {
  const transport = Object.assign(new EventEmitter(), {
    attach: vi.fn(), isAttached: vi.fn(() => true),
    sendCommand: vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async () => ({})),
  });
  const contents = {
    debugger: transport, getURL: vi.fn(() => initialUrl),
    loadURL: vi.fn(async () => {}), isDestroyed: vi.fn(() => false), stop: vi.fn(),
  };
  const client = {
    setInstanceUrl: vi.fn(),
    handle: vi.fn<(request: Request, document?: boolean) => Promise<Response | null>>(async () => null),
  } satisfies BundledWebClient;
  const unavailable = vi.fn();
  const routing = installBundledClientSession(contents as unknown as WebContents, client, unavailable);
  const pause = (method: string, url: string, resourceType = 'Fetch') => transport.emit('message', {}, 'Fetch.requestPaused', {
    requestId: 'request-1', resourceType, request: { url, method, headers: { accept: '*/*' } },
  });
  return { transport, contents, client, routing, unavailable, pause };
}

describe('bundled client session', () => {
  it('fulfills a bundled document with its exact bytes and security headers', async () => {
    const { transport, client, routing, pause } = setup();
    client.handle.mockResolvedValue(new Response('<html>Bundled ✓</html>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'" },
    }));
    await routing.setInstanceUrl('https://instance.test');
    pause('GET', 'https://instance.test/join/example', 'Document');
    await vi.waitFor(() => expect(transport.sendCommand).toHaveBeenCalledWith('Fetch.fulfillRequest', expect.objectContaining({
      requestId: 'request-1', responseCode: 200,
      body: Buffer.from('<html>Bundled ✓</html>').toString('base64'),
      responseHeaders: expect.arrayContaining([{ name: 'content-security-policy', value: "script-src 'self'" }]),
    })));
    expect(client.handle).toHaveBeenCalledWith(expect.any(Request), true);
  });

  it('continues API and streaming POST requests without rebuilding the request', async () => {
    const { transport, client, routing, pause } = setup();
    await routing.setInstanceUrl('https://instance.test');
    pause('GET', 'https://instance.test/api/health');
    await vi.waitFor(() => expect(transport.sendCommand).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'request-1' }));
    expect(client.handle).toHaveBeenCalledTimes(1);
    client.handle.mockClear(); transport.sendCommand.mockClear();
    pause('POST', 'https://instance.test/api/files/chunk');
    await vi.waitFor(() => expect(transport.sendCommand).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'request-1' }));
    expect(client.handle).not.toHaveBeenCalled();
    expect(transport.sendCommand).not.toHaveBeenCalledWith('Fetch.fulfillRequest', expect.anything());
  });

  it('allows a later instance selection after a transient setup failure', async () => {
    const { transport, client, routing } = setup();
    let attempts = 0;
    transport.sendCommand.mockImplementation(async (method) => {
      if (method === 'Fetch.enable' && attempts++ === 0) throw new Error('transient CDP error');
      return {};
    });
    await expect(routing.setInstanceUrl('https://first.test')).rejects.toThrow('transient CDP error');
    await expect(routing.setInstanceUrl('https://second.test')).resolves.toBeUndefined();
    expect(client.setInstanceUrl).toHaveBeenLastCalledWith('https://second.test');
  });

  it('primes an empty target and bypasses service workers before routing', async () => {
    const { transport, contents, routing } = setup('');
    await routing.setInstanceUrl(null);
    expect(contents.loadURL).toHaveBeenCalledWith('about:blank');
    expect(transport.sendCommand).toHaveBeenCalledWith('Network.setBypassServiceWorker', { bypass: true });
  });

  it('stops loading and reports unexpected detachment instead of silently loading remote UI', async () => {
    const { transport, contents, routing, unavailable } = setup();
    await routing.setInstanceUrl('https://instance.test');
    transport.emit('detach', {}, 'replaced_with_devtools');
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('replaced_with_devtools') }));
    await expect(routing.setInstanceUrl('https://another.test')).rejects.toThrow('routing stopped');
  });
});
