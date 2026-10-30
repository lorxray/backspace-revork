import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openImageAnimation } from './imageAnimation';

const draw = vi.fn();
const closeFrame = vi.fn();
const closeDecoder = vi.fn();
const decode = vi.fn(async () => ({ image: { displayWidth: 100, displayHeight: 80, duration: 20_000, close: closeFrame } }));
beforeEach(() => {
  vi.useFakeTimers();
  draw.mockClear(); closeFrame.mockClear(); closeDecoder.mockClear(); decode.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: draw, clearRect: () => {} } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([71, 73, 70]), { headers: { 'content-type': 'image/gif' } })));
  vi.stubGlobal('ImageDecoder', class {
    tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 2 } };
    decode = decode;
    close = closeDecoder;
  });

});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('controlled image playback', () => {
  it('aborts stalled media downloads after fifteen seconds', async () => {
    vi.mocked(fetch).mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = openImageAnimation('https://example.com/stalled.gif', document.createElement('canvas'), { onPaint: vi.fn(), onFinish: vi.fn(), onError: vi.fn() }, new AbortController().signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(draw).not.toHaveBeenCalled();
  });
  it('plays three initial cycles and exactly two replay cycles without another media fetch', async () => {
    const finish = vi.fn();
    const player = await openImageAnimation('https://example.com/cat.gif', document.createElement('canvas'), { onPaint: () => {}, onFinish: finish, onError: vi.fn() }, new AbortController().signal);
    player.play(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(draw).toHaveBeenCalledTimes(6);
    expect(closeFrame).toHaveBeenCalledTimes(6);
    expect(finish).toHaveBeenCalledTimes(1);
    player.play(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(draw).toHaveBeenCalledTimes(10);
    expect(closeFrame).toHaveBeenCalledTimes(10);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    player.pause();
    const count = draw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(draw).toHaveBeenCalledTimes(count);
    player.dispose();
  });

  it('does not paint a pending frame after disposal and still releases that frame', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof decode>>) => void;
    decode.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const player = await openImageAnimation('https://example.com/dispose.gif', document.createElement('canvas'), { onPaint: vi.fn(), onFinish: vi.fn(), onError: vi.fn() }, new AbortController().signal);
    player.play(3);
    await vi.advanceTimersByTimeAsync(0);
    player.dispose();
    resolve({ image: { displayWidth: 100, displayHeight: 80, duration: 20_000, close: closeFrame } });
    await vi.advanceTimersByTimeAsync(0);
    expect(draw).not.toHaveBeenCalled();
    expect(closeFrame).toHaveBeenCalledTimes(1);
  });
});
