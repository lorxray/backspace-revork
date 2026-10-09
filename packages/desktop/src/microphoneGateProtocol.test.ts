import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { handleMicrophoneGateRequest, MICROPHONE_GATE_MODULE_URL } from './microphoneGateProtocol';

describe('microphone gate module protocol', () => {
  it('serves a standalone worklet module with no renderer or Node dependencies', async () => {
    const response = handleMicrophoneGateRequest(new Request(MICROPHONE_GATE_MODULE_URL));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const registerProcessor = vi.fn();
    runInNewContext(await response.text(), {
      AudioWorkletProcessor: class {},
      registerProcessor,
      sampleRate: 48_000,
    });
    expect(registerProcessor).toHaveBeenCalledExactlyOnceWith('backspace-microphone-gate', expect.any(Function));
  });

  it('answers HEAD without a body', async () => {
    const response = handleMicrophoneGateRequest(new Request(MICROPHONE_GATE_MODULE_URL, { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/javascript');
    expect(await response.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('rejects %s on the module endpoint', (method) => {
    const response = handleMicrophoneGateRequest(new Request(MICROPHONE_GATE_MODULE_URL, { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it.each([
    'backspace-microphone-gate://audio/other.js',
    'backspace-microphone-gate://other/processor.js',
    'backspace-microphone-gate://audio:123/processor.js',
    'backspace-microphone-gate://user:password@audio/processor.js',
    `${MICROPHONE_GATE_MODULE_URL}?source=anything`,
    `${MICROPHONE_GATE_MODULE_URL}?`,
    `${MICROPHONE_GATE_MODULE_URL}#anything`,
    `${MICROPHONE_GATE_MODULE_URL}#`,
    'backspace-microphone-gate://audio/%70rocessor.js',
    'backspace-microphone-gate://audio/../../secret',
    'https://audio/processor.js',
    'file:///processor.js',
    'not a URL',
  ])('never serves another resource: %s', (url) => {
    // Raw request-like values cover credentials and malformed URLs that the
    // standard Request constructor rejects before a protocol handler sees them.
    expect(handleMicrophoneGateRequest({ url, method: 'GET' } as Request).status).toBe(404);
  });
});
