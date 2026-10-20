import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBundledWebClient } from './bundledWebClient';

describe('bundled web client', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-ui-'));
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.writeFileSync(path.join(directory, 'index.html'), '<main>bundled</main>');
    fs.writeFileSync(path.join(directory, 'assets', 'app.js'), 'export const bundled = true;');
    fs.writeFileSync(path.join(directory, 'assets', 'audio.wasm'), new Uint8Array([0, 97, 115, 109]));
    fs.writeFileSync(path.join(directory, 'sw.js'), 'should never install');
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function setup() {
    const client = createBundledWebClient({ root: directory });
    client.setInstanceUrl('https://home.example');
    return { client };
  }

  it.each(['/', '/login', '/register', '/channels/@me', '/channels/space/channel', '/join/abc?origin=peer', '/explore', '/backspace'])('serves the packaged SPA at %s', async (route) => {
    const { client } = setup();
    const response = await client.handle(new Request('https://home.example' + route));
    expect(await response!.text()).toContain('bundled');
    expect(response!.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response!.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response!.headers.get('cache-control')).toBe('no-store');
  });

  it('serves scripts and wasm with their actual MIME type and no HEAD body', async () => {
    const { client } = setup();
    const script = await client.handle(new Request('https://home.example/assets/app.js?v=2'));
    expect(await script!.text()).toBe('export const bundled = true;');
    expect(script!.headers.get('content-type')).toContain('javascript');
    const wasm = await client.handle(new Request('https://home.example/assets/audio.wasm', { method: 'HEAD' }));
    expect(wasm!.headers.get('content-type')).toBe('application/wasm');
    expect(wasm!.headers.get('content-length')).toBe('4');
    expect(await wasm!.text()).toBe('');
  });

  it.each(['/api', '/api/auth/login', '/uploads', '/uploads/file.mp4', '/ws', '/ws/live', '/.well-known/webfinger'])('forwards server route %s unchanged', async (route) => {
    const { client } = setup();
    const request = new Request('https://home.example' + route);
    expect(await client.handle(request, true)).toBeNull();
  });

  it('preserves the original authenticated POST request and body', async () => {
    const { client } = setup();
    const request = new Request('https://home.example/api/auth/login', { method: 'POST', headers: { Authorization: 'Bearer example' }, body: 'payload' });
    expect(await client.handle(request)).toBeNull();
    expect(await request.text()).toBe('payload');
    expect(request.headers.get('authorization')).toBe('Bearer example');
  });

  it.each(['/assets/missing.js', '/icons/missing.png', '/sw.js', '/registerSW.js', '/workbox-test.js'])('does not replace missing application file %s with server code', async (route) => {
    const { client } = setup();
    expect((await client.handle(new Request('https://home.example' + route)))!.status).toBe(404);
  });

  it('scopes local files to the currently selected origin and clears on disconnect', async () => {
    const { client } = setup();
    expect(await client.handle(new Request('https://peer.example/'))).toBeNull();
    client.setInstanceUrl('https://peer.example/channels/@me');
    expect(await client.handle(new Request('https://home.example/'))).toBeNull();
    expect(await (await client.handle(new Request('https://peer.example/')))!.text()).toContain('bundled');
    client.setInstanceUrl(null);
    expect(await client.handle(new Request('https://peer.example/'))).toBeNull();
  });

  it.each(['/assets/%2e%2e%5csecret.js', '/assets/..%2f..%2fsecret.js', '/assets/%00app.js'])('does not turn encoded path %s into a filesystem path', async (route) => {
    const { client } = setup();
    expect((await client.handle(new Request('https://home.example' + route)))!.status).toBe(404);
  });

  it('fails closed when the packaged UI is absent', () => {
    fs.unlinkSync(path.join(directory, 'index.html'));
    expect(() => createBundledWebClient({ root: directory })).toThrow('missing');
  });

  it.each(['file:///tmp/ui', 'https://user:password@home.example/'])('rejects unsupported instance URL %s', (url) => {
    const { client } = setup();
    expect(() => client.setInstanceUrl(url)).toThrow('HTTP(S)');
  });
});
