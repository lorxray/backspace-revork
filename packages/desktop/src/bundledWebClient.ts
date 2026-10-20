import fs from 'fs';
import path from 'path';

// The renderer keeps the real instance origin. Only immutable application
// files are local; authenticated API calls, media, federation and WebSockets
// keep using that instance's normal network stack.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

// Equivalent to the upstream web policy, without a server-owned reporting
// endpoint. Peers and LiveKit are discovered at runtime, including LAN hosts.
export const BUNDLED_WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws: blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://open.spotify.com',
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const LOCAL_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': BUNDLED_WEB_CSP,
};

function isRemotePath(pathname: string): boolean {
  return /^\/(?:api|uploads|ws|\.well-known)(?:\/|$)/.test(pathname);
}

function isAppRoute(pathname: string): boolean {
  return pathname === '/' || pathname === '/index.html' ||
    /^\/(?:login|register|explore|backspace)\/?$/.test(pathname) ||
    /^\/(?:channels|join)(?:\/|$)/.test(pathname);
}

function isWorkerPath(pathname: string): boolean {
  return pathname === '/sw.js' || pathname === '/sw-rollover.js' ||
    pathname === '/registerSW.js' || /^\/workbox-[^/]+\.js$/.test(pathname);
}

export interface BundledWebClient {
  setInstanceUrl(url: string | null): void;
  /** null leaves the request in Chromium's ordinary network/CORS stack. */
  handle(request: Request, isDocument?: boolean): Promise<Response | null>;
}

export function createBundledWebClient(options: {
  root: string;
}): BundledWebClient {
  const files = new Map<string, string>();
  // Build an allowlist from the packaged directory, never resolve a URL into
  // an arbitrary filesystem path. Symlinks and unsupported file types stay out.
  function collect(directory: string, segments: string[]): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const next = [...segments, entry.name];
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute, next);
      else if (entry.isFile() && CONTENT_TYPES[path.extname(entry.name)]) {
        files.set('/' + next.map(encodeURIComponent).join('/'), absolute);
      }
    }
  }
  collect(options.root, []);
  if (!files.has('/index.html') || ![...files.keys()].some((file) => file.startsWith('/assets/') && file.endsWith('.js'))) {
    throw new Error('The bundled web client is missing its index or compiled assets');
  }
  let instanceOrigin: string | null = null;

  return {
    setInstanceUrl(raw) {
      if (raw === null) {
        instanceOrigin = null;
        return;
      }
      const url = new URL(raw);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Instance URL must be HTTP(S) without embedded credentials');
      }
      instanceOrigin = url.origin;
    },
    async handle(request, isDocument = false) {
      const url = new URL(request.url);
      if (url.origin !== instanceOrigin || isRemotePath(url.pathname) ||
          !['GET', 'HEAD'].includes(request.method)) {
        return null;
      }
      // A worker from the instance must never install over the packaged UI.
      if (isWorkerPath(url.pathname)) {
        return new Response(null, { status: 404, headers: LOCAL_HEADERS });
      }
      const filename = files.get(isAppRoute(url.pathname) || (isDocument && !path.extname(url.pathname)) ? '/index.html' : url.pathname);
      if (!filename) {
        // A stale/missing application chunk must fail rather than execute a
        // script from the instance's different build. Other server routes keep
        // their native response (downloads, federation discovery, etc.).
        if (/^\/(?:assets|icons)(?:\/|$)/.test(url.pathname)) {
          return new Response(null, { status: 404, headers: LOCAL_HEADERS });
        }
        return null;
      }
      try {
        const content = new Uint8Array(await fs.promises.readFile(filename));
        return new Response(request.method === 'HEAD' ? null : content, {
          headers: {
            ...LOCAL_HEADERS,
            'Content-Type': CONTENT_TYPES[path.extname(filename)]!,
            'Content-Length': String(content.byteLength),
          },
        });
      } catch {
        return new Response(null, { status: 404, headers: LOCAL_HEADERS });
      }
    },
  };
}
