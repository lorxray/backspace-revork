import { net, type ClientRequest, type Session } from 'electron';

/** Resolve the HTTP -> HTTPS redirect that a locally served document bypasses. */
export async function resolveInstanceRedirect(raw: string, session: Session): Promise<string> {
  let navigation: URL;
  try {
    navigation = new URL(raw);
  } catch {
    throw new Error('Instance URL must be HTTP(S) without embedded credentials');
  }
  if (!['http:', 'https:'].includes(navigation.protocol) || navigation.username || navigation.password) {
    throw new Error('Instance URL must be HTTP(S) without embedded credentials');
  }
  if (navigation.protocol !== 'http:') return raw;
  return new Promise((resolve) => {
    let done = false;
    let origin = navigation.origin;
    let redirects = 0;
    let request: ClientRequest | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function finish(result: string): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    }
    function abort(): void {
      try { request?.abort(); } catch { /* Already closed or failed to start. */ }
    }
    try {
      const current = net.request({
        url: new URL('/api/instance/info', navigation).href,
        method: 'GET', session, redirect: 'manual', credentials: 'omit',
      });
      request = current;
      timer = setTimeout(() => { finish(raw); abort(); }, 5000);
      current.on('error', () => { finish(raw); });
      current.on('redirect', (_status, _method, target) => {
        if (done) return;
        try {
          const next = new URL(target);
          if (++redirects > 5 || !['http:', 'https:'].includes(next.protocol) || next.username || next.password ||
              (origin.startsWith('https:') && next.protocol !== 'https:')) {
            finish(raw);
            abort();
            return;
          }
          origin = next.origin;
          current.followRedirect();
        } catch {
          finish(raw);
          abort();
        }
      });
      current.on('response', () => {
        if (done) return;
        finish(origin + navigation.pathname + navigation.search + navigation.hash);
        abort(); // Only the final origin is needed, not the response body.
      });
      current.end();
    } catch {
      finish(raw);
      abort();
    }
  });
}
