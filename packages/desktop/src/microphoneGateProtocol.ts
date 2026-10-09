import { registerMicrophoneGateProcessor } from './microphoneGateProcessor';

export const MICROPHONE_GATE_SCHEME = 'backspace-microphone-gate';
export const MICROPHONE_GATE_MODULE_URL = `${MICROPHONE_GATE_SCHEME}://audio/processor.js`;

// The dedicated protocol only exposes this immutable module. In particular, it
// never translates a renderer-supplied URL into a path on the local filesystem.
const moduleSource = `(${registerMicrophoneGateProcessor.toString()})();`;
const moduleHeaders = {
  'Content-Type': 'application/javascript; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function handleMicrophoneGateRequest(request: Request): Response {
  // An exact URL match also rejects credentials, ports, queries, fragments and
  // alternate encodings. The handler has no remote/network fallback.
  if (request.url !== MICROPHONE_GATE_MODULE_URL) {
    return new Response(null, { status: 404 });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  return new Response(request.method === 'HEAD' ? null : moduleSource, { headers: moduleHeaders });
}
