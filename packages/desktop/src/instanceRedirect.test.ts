import { EventEmitter } from 'node:events';
import type { Session } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveInstanceRedirect } from './instanceRedirect';

const electron = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('electron', () => ({ net: { request: electron.request } }));

class FakeRequest extends EventEmitter {
  end = vi.fn();
  followRedirect = vi.fn();
  abort = vi.fn();
}

const session = {} as Session;
const original = 'http://instance.test:3005/join/room?redirect=%2Fchannels%2Fme#invite';
let request: FakeRequest;

beforeEach(() => {
  vi.useFakeTimers();
  request = new FakeRequest();
  electron.request.mockReset().mockReturnValue(request);
});

afterEach(() => {
  vi.useRealTimers();
});

function redirect(target: string): void {
  request.emit('redirect', 301, 'GET', target, {});
}

describe('resolveInstanceRedirect', () => {
  it('does not probe an HTTPS instance', async () => {
    const secure = original.replace('http:', 'https:');
    await expect(resolveInstanceRedirect(secure, session)).resolves.toBe(secure);
    expect(electron.request).not.toHaveBeenCalled();
  });

  it('probes only instance info with cookies and authentication omitted', async () => {
    const result = resolveInstanceRedirect(original, session);
    expect(electron.request).toHaveBeenCalledWith({
      url: 'http://instance.test:3005/api/instance/info',
      method: 'GET',
      session,
      redirect: 'manual',
      credentials: 'omit',
    });
    expect(request.end).toHaveBeenCalledOnce();
    request.emit('response', { statusCode: 200 });
    await expect(result).resolves.toBe(original);
    expect(request.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces only the origin after HTTP to HTTPS and preserves the original route, query and hash', async () => {
    const result = resolveInstanceRedirect(original, session);
    redirect('https://canonical.test:8443/api/instance/info?from=proxy');
    expect(request.followRedirect).toHaveBeenCalledOnce();
    request.emit('response', { statusCode: 200 });

    await expect(result).resolves.toBe('https://canonical.test:8443/join/room?redirect=%2Fchannels%2Fme#invite');
  });

  it('allows five redirects, including HTTP hops before the HTTPS upgrade', async () => {
    const result = resolveInstanceRedirect(original, session);
    for (const target of [
      'http://alias.test/api/instance/info',
      'http://canonical.test/api/instance/info',
      'https://canonical.test/api/instance/info',
      'https://canonical.test/canonical-info',
      'https://final.test/api/instance/info',
    ]) redirect(target);
    request.emit('response', { statusCode: 200 });

    expect(request.followRedirect).toHaveBeenCalledTimes(5);
    await expect(result).resolves.toBe('https://final.test/join/room?redirect=%2Fchannels%2Fme#invite');
  });

  it('aborts on the sixth redirect and returns the original URL', async () => {
    const result = resolveInstanceRedirect(original, session);
    for (let index = 0; index < 6; index++) redirect(`https://hop-${index}.test/api/instance/info`);

    await expect(result).resolves.toBe(original);
    expect(request.followRedirect).toHaveBeenCalledTimes(5);
    expect(request.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never follows an HTTPS to HTTP downgrade', async () => {
    const result = resolveInstanceRedirect(original, session);
    redirect('https://canonical.test/api/instance/info');
    redirect('http://canonical.test/api/instance/info');

    await expect(result).resolves.toBe(original);
    expect(request.followRedirect).toHaveBeenCalledOnce();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it.each([
    'file:///private/token',
    'javascript:alert(1)',
    'ftp://canonical.test/info',
    'https://user:secret@canonical.test/api/instance/info',
    'https://user@canonical.test/api/instance/info',
    'not a URL',
  ])('rejects an unsafe redirect target %s without following it', async (target) => {
    const result = resolveInstanceRedirect(original, session);
    redirect(target);

    await expect(result).resolves.toBe(original);
    expect(request.followRedirect).not.toHaveBeenCalled();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it('aborts a stalled probe after five seconds and returns the original URL', async () => {
    const result = resolveInstanceRedirect(original, session);
    await vi.advanceTimersByTimeAsync(4999);
    expect(request.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBe(original);
    expect(request.abort).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to the original URL after a network error', async () => {
    const result = resolveInstanceRedirect(original, session);
    redirect('https://canonical.test/api/instance/info');
    request.emit('error', new Error('connection reset'));

    await expect(result).resolves.toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    'http://user:secret@instance.test/join/room',
    'https://user:secret@instance.test/join/room',
    'ftp://instance.test/join/room',
    'file:///private/token',
    'not a URL',
  ])('rejects invalid instance URLs before probing %s', async (raw) => {
    await expect(resolveInstanceRedirect(raw, session)).rejects.toThrow('Instance URL must be HTTP(S) without embedded credentials');
    expect(electron.request).not.toHaveBeenCalled();
  });

  it('cleans up a malformed redirect even if abort synchronously emits an error', async () => {
    request.abort.mockImplementation(() => { request.emit('error', new Error('request aborted')); });
    const result = resolveInstanceRedirect(original, session);
    redirect('malformed URL');

    await expect(result).resolves.toBe(original);
    expect(request.abort).toHaveBeenCalledOnce();
    expect(request.followRedirect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores late events after a timed out probe', async () => {
    const result = resolveInstanceRedirect(original, session);
    await vi.advanceTimersByTimeAsync(5000);
    redirect('https://too-late.test/api/instance/info');
    request.emit('response', { statusCode: 200 });

    await expect(result).resolves.toBe(original);
    expect(request.followRedirect).not.toHaveBeenCalled();
    expect(request.abort).toHaveBeenCalledOnce();
  });

  it('falls back to the original URL if net.request cannot be constructed', async () => {
    electron.request.mockImplementation(() => { throw new Error('session is unavailable'); });

    await expect(resolveInstanceRedirect(original, session)).resolves.toBe(original);
  });

  it('falls back to the original URL if the probe cannot be started', async () => {
    request.end.mockImplementation(() => { throw new Error('request failed'); });

    await expect(resolveInstanceRedirect(original, session)).resolves.toBe(original);
    expect(vi.getTimerCount()).toBe(0);
  });
});
