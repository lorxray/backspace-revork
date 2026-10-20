import type { WebContents } from 'electron';
import type { BundledWebClient } from './bundledWebClient';

interface PausedRequest {
  requestId: string;
  resourceType: string;
  request: { url: string; method: string; headers: Record<string, string> };
}

export interface BundledClientSession {
  setInstanceUrl(url: string | null): Promise<void>;
}

/**
 * Supply packaged documents/assets before Chromium's ordinary request starts.
 * API calls, uploads, media and third-party requests continue unchanged through
 * Chromium, retaining its full CORS, cookies, redirects and cache semantics.
 * Intercepting the HTTP(S) scheme instead would drop original request metadata
 * in Electron and could silently bypass those browser checks.
 */
export function installBundledClientSession(
  webContents: WebContents,
  client: BundledWebClient,
  onUnavailable?: (error: Error) => void,
): BundledClientSession {
  const transport = webContents.debugger;
  let unavailable: Error | null = null;
  let pending = Promise.resolve();
  const paused = new Set<string>();

  async function answer(event: PausedRequest): Promise<void> {
    paused.add(event.requestId);
    try {
      // A non-GET/HEAD request can never resolve to a bundled file. Continuing
      // it directly also avoids consuming or rebuilding streaming upload data.
      const response = ['GET', 'HEAD'].includes(event.request.method)
        ? await client.handle(new Request(event.request.url, {
          method: event.request.method, headers: event.request.headers,
        }), event.resourceType === 'Document')
        : null;
      if (response === null) {
        await transport.sendCommand('Fetch.continueRequest', { requestId: event.requestId });
      } else {
        await transport.sendCommand('Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: response.status,
          ...(response.statusText ? { responsePhrase: response.statusText } : {}),
          responseHeaders: [...response.headers].map(([name, value]) => ({ name, value })),
          body: Buffer.from(await response.arrayBuffer()).toString('base64'),
        });
      }
    } catch (error) {
      // Navigation can cancel an already-paused request. A genuine local file
      // failure must never fall back to a different frontend from the server.
      if (!webContents.isDestroyed() && transport.isAttached()) {
        try { await transport.sendCommand('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }); } catch { /* already cancelled */ }
      }
      if (!webContents.isDestroyed()) console.warn('[bundled-client] Request could not complete:', error);
    } finally {
      paused.delete(event.requestId);
    }
  }

  transport.on('message', (_event, method, params: PausedRequest) => {
    if (method === 'Fetch.requestPaused') void answer(params);
  });
  transport.on('detach', (_event, reason) => {
    if (webContents.isDestroyed()) return;
    unavailable = new Error(`Bundled client request routing stopped: ${reason}`);
    webContents.stop();
    paused.clear();
    onUnavailable?.(unavailable);
  });

  const ready = (async () => {
    // Electron documents that debugger command promises can remain pending
    // before the target's first navigation. Prime a trusted empty document.
    if (!webContents.getURL()) await webContents.loadURL('about:blank');
    transport.attach('1.3');
    await transport.sendCommand('Network.setBypassServiceWorker', { bypass: true });
  })();

  return {
    setInstanceUrl(url) {
      pending = pending.catch(() => {}).then(async () => {
        await ready;
        if (unavailable) throw unavailable;
        client.setInstanceUrl(url);
        const patterns: { urlPattern: string; resourceType?: string; requestStage: string }[] = [
          { urlPattern: 'http://*', resourceType: 'Document', requestStage: 'Request' },
          { urlPattern: 'https://*', resourceType: 'Document', requestStage: 'Request' },
        ];
        if (url !== null) patterns.push({ urlPattern: new URL(url).origin + '/*', requestStage: 'Request' });
        await transport.sendCommand('Fetch.enable', { patterns });
      });
      return pending;
    },
  };
}
