interface ImageDecoderInstance {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null };
  decode(options: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}
interface ImageDecoderConstructor {
  new(options: { data: ArrayBuffer; type: string }): ImageDecoderInstance;
}
export interface ImageAnimation {
  /** 0 means play until explicitly paused. */
  play(loops: number): void;
  pause(): void;
  dispose(): void;
}
export interface ImageAnimationCallbacks {
  onPaint(): void;
  onFinish(): void;
  onError(): void;
}

function decoderConstructor(): ImageDecoderConstructor | undefined {
  return (globalThis as unknown as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
}
export function supportsImageAnimation(): boolean { return !!decoderConstructor(); }

/** Decode the original image URL in the renderer; no upload, rewriting or disk media cache. */
export async function openImageAnimation(
  src: string, canvas: HTMLCanvasElement, callbacks: ImageAnimationCallbacks, signal: AbortSignal,
): Promise<ImageAnimation> {
  const Decoder = decoderConstructor();
  if (!Decoder) throw new Error('ImageDecoder unavailable');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  const download = new AbortController();
  const abort = () => download.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(abort, 15_000);
  let response: Response;
  let data: ArrayBuffer;
  try {
    response = await fetch(src, { signal: download.signal, credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('Image unavailable');
    data = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (data.byteLength > 32 * 1024 * 1024) throw new Error('Image too large for controlled decoding');
  const bytes = new Uint8Array(data);
  const type = bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 ? 'image/gif'
    : bytes[0] === 82 && bytes[8] === 87 && bytes[9] === 69 ? 'image/webp'
      : response.headers.get('content-type')?.split(';')[0] ?? 'image/png';
  let generation = 0;
  let decoder: ImageDecoderInstance | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const pause = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    try { decoder?.close(); } catch { /* A failed decoder may already be closed. */ }
    decoder = null;
  };
  const play = (loops: number) => {
    pause();
    if (disposed || signal.aborted) return;
    const current = generation;
    let frameIndex = 0;
    let completedLoops = 0;
    let painted = false;
    const active = () => !disposed && !signal.aborted && generation === current;
    const run = async () => {
      try {
        const owned = new Decoder({ data, type });
        decoder = owned;
        await owned.tracks.ready;
        if (!active()) return;
        const count = owned.tracks.selectedTrack?.frameCount ?? 1;
        if (!count) throw new Error('Image has no frames');
        const step = async (): Promise<void> => {
          const { image } = await owned.decode({ frameIndex });
          if (!active()) { image.close(); return; }
          let duration = 100;
          try {
            const scale = Math.min(1, 1024 / Math.max(image.displayWidth, image.displayHeight));
            const width = Math.max(1, Math.round(image.displayWidth * scale));
            const height = Math.max(1, Math.round(image.displayHeight * scale));
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
            context.clearRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);
            duration = Math.max(20, (image.duration ?? 100_000) / 1_000);
          } finally { image.close(); }
          if (!painted) { callbacks.onPaint(); painted = true; }
          frameIndex += 1;
          if (frameIndex >= count) { frameIndex = 0; completedLoops += 1; }
          timer = setTimeout(() => {
            if (!active()) return;
            if (count === 1 || (loops > 0 && completedLoops >= loops)) {
              pause();
              callbacks.onFinish();
            } else { void step().catch(failed); }
          }, duration);
        };
        await step();
      } catch { failed(); }
    };
    const failed = () => {
      if (!active()) return;
      pause();
      callbacks.onError();
    };
    void run();
  };
  return { play, pause, dispose: () => { disposed = true; pause(); } };
}
