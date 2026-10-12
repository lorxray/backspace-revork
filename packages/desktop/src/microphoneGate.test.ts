// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMicrophoneGate } from './microphoneGate';

const MODULE_URL = 'backspace-microphone-gate://processor.js';
const STORAGE_KEY = 'backspace-desktop-microphone-gate';
type Status = { available: boolean; db: number; open: boolean; error: boolean };

class MockTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  onended: ((event: Event) => void) | null = null;
  stopCalls = 0;
  constructor(readonly kind = 'audio', readonly label = '', readonly deviceId?: string) { super(); }
  getSettings(): MediaTrackSettings { return { deviceId: this.deviceId }; }
  stop(): void { this.stopCalls++; this.readyState = 'ended'; }
  end(): void {
    this.readyState = 'ended';
    const event = new Event('ended');
    this.onended?.(event);
    this.dispatchEvent(event);
  }
}

class MockStream {
  constructor(readonly tracks = [new MockTrack()]) {}
  getAudioTracks(): MockTrack[] { return this.tracks.filter(track => track.kind === 'audio'); }
  getTracks(): MockTrack[] { return this.tracks; }
  asMediaStream(): MediaStream { return this as unknown as MediaStream; }
}

class MockAudioParam {}

class MockNode extends EventTarget {
  readonly connectCalls: unknown[][] = [];
  readonly disconnectCalls: unknown[][] = [];
  connections: unknown[][] = [];
  connect(...args: unknown[]): unknown {
    this.connectCalls.push(args);
    this.connections.push(args);
    return args[0] instanceof MockAudioParam ? undefined : args[0];
  }
  disconnect(...args: unknown[]): void {
    this.disconnectCalls.push(args);
    this.connections = this.connections.filter(connection => {
      if (!args.length) return false;
      if (typeof args[0] === 'number') return (connection[1] ?? 0) !== args[0];
      return connection[0] !== args[0]
        || (args.length > 1 && (connection[1] ?? 0) !== args[1])
        || (args.length > 2 && (connection[2] ?? 0) !== args[2]);
    });
  }
}

class MockGain extends MockNode { gain = { value: 1 }; }

class MockSource extends MockNode {
  constructor(readonly mediaStream: MediaStream) { super(); }
}

class MockContext extends EventTarget {
  state: 'running' | 'closed' = 'running';
  readonly gains: MockGain[] = [];
  readonly sources: MockSource[] = [];
  audioWorklet = { addModule: vi.fn(async (url: string, options?: WorkletOptions) => { void url; void options; }) };
  createGain(): MockGain {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }
  createMediaStreamSource(stream: MediaStream): MockSource {
    const source = new MockSource(stream);
    this.sources.push(source);
    return source;
  }
  close(): void { this.state = 'closed'; this.dispatchEvent(new Event('statechange')); }
}

class MockWorklet extends MockNode {
  static instances: MockWorklet[] = [];
  port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  constructor(readonly context: MockContext, readonly name: string, readonly options: AudioWorkletNodeOptions) {
    super();
    MockWorklet.instances.push(this);
  }
  level(db: number, open: boolean): void { this.port.onmessage?.({ data: { type: 'level', db, open } }); }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  // The wrapper adopts addModule's promise before inserting the worklet node.
  for (let turn = 0; turn < 8; turn++) await Promise.resolve();
}

let capture: MockStream;
let nativeGetUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>;
let nativeGetDisplayMedia: ReturnType<typeof vi.fn<() => Promise<MediaStream>>>;
let mediaDevicesDescriptor: PropertyDescriptor | undefined;
let cleanup: (() => void) | undefined;
let statuses: Status[];
const captureStatus = (event: Event) => statuses.push((event as CustomEvent<Status>).detail);

function settings(enabled: boolean, thresholdDb = -50): void {
  document.dispatchEvent(new CustomEvent('backspace-microphone-gate-settings', { detail: { enabled, thresholdDb } }));
}

async function microphone(context = new MockContext()) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = context.createMediaStreamSource(stream);
  const destination = new MockNode();
  return { stream, context, source, destination, outlet: context.gains[0]! };
}

beforeEach(() => {
  cleanup = undefined;
  statuses = [];
  capture = new MockStream();
  MockWorklet.instances = [];
  localStorage.clear();
  vi.stubGlobal('AudioContext', MockContext);
  vi.stubGlobal('AudioWorkletNode', MockWorklet);
  nativeGetUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => { void constraints; return capture.asMediaStream(); });
  nativeGetDisplayMedia = vi.fn(async () => new MockStream().asMediaStream());
  mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: nativeGetUserMedia, getDisplayMedia: nativeGetDisplayMedia },
  });
  document.addEventListener('backspace-microphone-gate-status', captureStatus);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup?.();
  (window as Window & { backspaceMicrophoneGateCleanup?: () => void }).backspaceMicrophoneGateCleanup?.();
  document.removeEventListener('backspace-microphone-gate-status', captureStatus);
  if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
  else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('desktop microphone gate adapter', () => {
  it('serializes without imports and installs only once', async () => {
    const install = new Function('url', `return (${installMicrophoneGate.toString()})(url);`) as (url: string) => () => void;
    cleanup = install(MODULE_URL);
    const wrappedCapture = navigator.mediaDevices.getUserMedia;
    const wrappedSource = MockContext.prototype.createMediaStreamSource;
    expect(install('another-module')).toBe(cleanup);
    expect(navigator.mediaDevices.getUserMedia).toBe(wrappedCapture);
    expect(MockContext.prototype.createMediaStreamSource).toBe(wrappedSource);
    const { context, source, destination } = await microphone();
    source.connect(destination);
    await flush();
    expect(nativeGetUserMedia).toHaveBeenCalledTimes(1);
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(MockWorklet.instances).toHaveLength(1);
  });

  it('preserves the original capture stream and audio/video track identities', async () => {
    capture = new MockStream([new MockTrack(), new MockTrack('video')]);
    cleanup = installMicrophoneGate(MODULE_URL);
    const constraints = { audio: { deviceId: { exact: 'mic-1' }, echoCancellation: true }, video: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    expect(stream).toBe(capture);
    expect(stream.getTracks()).toEqual(capture.tracks);
    expect(stream.getAudioTracks()[0]).toBe(capture.tracks[0]);
    expect(nativeGetUserMedia).toHaveBeenCalledWith(constraints);
    expect(nativeGetUserMedia.mock.contexts[0]).toBe(navigator.mediaDevices);
    expect(capture.tracks.every(track => track.stopCalls === 0)).toBe(true);
  });

  it('preserves microphone permission errors', async () => {
    const denied = new DOMException('Microphone permission denied', 'NotAllowedError');
    nativeGetUserMedia.mockRejectedValueOnce(denied);
    cleanup = installMicrophoneGate(MODULE_URL);
    await expect(navigator.mediaDevices.getUserMedia({ audio: true })).rejects.toBe(denied);
    expect(denied.name).toBe('NotAllowedError');
    expect(MockWorklet.instances).toHaveLength(0);
  });

  it.each([
    { video: true },
    { video: true, audio: false },
    { audio: { chromeMediaSource: 'desktop' } },
    { audio: { mandatory: { chromeMediaSource: 'desktop' } } },
  ])('leaves camera and legacy desktop captures unchanged: %j', async (constraints) => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const context = new MockContext();
    const stream = await navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints);
    const source = context.createMediaStreamSource(stream);
    const destination = new MockNode();
    expect(source.connect(destination)).toBe(destination);
    expect(source.connect).toBe(MockNode.prototype.connect);
    expect(context.gains).toHaveLength(0);
    await flush();
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
  });

  it.each([
    { audio: { deviceId: { exact: 'system-audio' } }, label: 'vencord-screen-share', deviceId: 'system-audio' },
    { audio: { deviceId: { exact: 'system-audio' } }, label: 'System audio', deviceId: 'system-audio' },
    { audio: true, label: 'Default - vencord-screen-share', deviceId: 'system-audio' },
    { audio: { deviceId: 'default' }, label: 'Default input', deviceId: 'default' },
  ])('gates a microphone but leaves the Linux system-audio capture untouched: %j', async ({ audio, label, deviceId }) => {
    const systemTrack = new MockTrack('audio', label, deviceId);
    const systemCapture = new MockStream([systemTrack]);
    const microphoneTrack = new MockTrack('audio', 'USB microphone', 'mic-1');
    capture = new MockStream([microphoneTrack]);
    nativeGetUserMedia.mockResolvedValueOnce(systemCapture.asMediaStream());
    Object.assign(navigator.mediaDevices, {
      enumerateDevices: vi.fn(async () => [
        { kind: 'audioinput', deviceId: 'system-audio', label: 'vencord-screen-share' },
        { kind: 'audioinput', deviceId: 'default', label: 'Default - vencord-screen-share' },
        { kind: 'audioinput', deviceId: 'mic-1', label: 'USB microphone' },
      ]),
    });
    cleanup = installMicrophoneGate(MODULE_URL);
    settings(true, -40);
    const context = new MockContext();
    const systemStream = await navigator.mediaDevices.getUserMedia({ audio });
    expect(systemStream).toBe(systemCapture);
    const systemSource = context.createMediaStreamSource(systemStream);
    const systemDestination = new MockNode();
    expect(systemSource.connect(systemDestination)).toBe(systemDestination);
    expect(systemSource.connect).toBe(MockNode.prototype.connect);
    expect(systemSource.connections).toEqual([[systemDestination]]);
    expect(context.gains).toHaveLength(0);

    const microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: 'mic-1' } } });
    const microphoneSource = context.createMediaStreamSource(microphoneStream);
    microphoneSource.connect(new MockNode());
    expect(microphoneStream).toBe(capture);
    expect(microphoneSource.connect).not.toBe(MockNode.prototype.connect);
    await flush();
    expect(context.gains).toHaveLength(1);
    expect(MockWorklet.instances).toHaveLength(1);
    expect(MockWorklet.instances[0]!.options.processorOptions).toEqual({ enabled: true, thresholdDb: -40 });
    expect(systemTrack.stopCalls).toBe(0);
    expect(systemTrack.stop).toBe(MockTrack.prototype.stop);
  });

  it('does not gate a mixed stream containing microphone and system-audio tracks', async () => {
    capture = new MockStream([
      new MockTrack('audio', 'USB microphone'),
      new MockTrack('audio', 'vencord-screen-share'),
    ]);
    cleanup = installMicrophoneGate(MODULE_URL);
    settings(true);
    const { context, source, destination } = await microphone();
    source.connect(destination);
    await flush();
    expect(source.connect).toBe(MockNode.prototype.connect);
    expect(source.connections).toEqual([[destination]]);
    expect(context.gains).toHaveLength(0);
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
  });

  it('preserves successful microphone capture when device inspection fails', async () => {
    capture = new MockStream([new MockTrack('audio', 'USB microphone', 'mic-1')]);
    Object.assign(navigator.mediaDevices, {
      enumerateDevices: vi.fn(async () => { throw new DOMException('Device inspection denied', 'NotAllowedError'); }),
    });
    cleanup = installMicrophoneGate(MODULE_URL);
    const { stream, source, destination } = await microphone();
    source.connect(destination);
    await flush();
    expect(stream).toBe(capture);
    expect(MockWorklet.instances).toHaveLength(1);
  });

  it('does not instrument remote streams or getDisplayMedia audio', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const context = new MockContext();
    expect(navigator.mediaDevices.getDisplayMedia).toBe(nativeGetDisplayMedia);
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    for (const stream of [display, new MockStream().asMediaStream()]) {
      const source = context.createMediaStreamSource(stream);
      const destination = new MockNode();
      expect(source.connect(destination)).toBe(destination);
      expect(source.connect).toBe(MockNode.prototype.connect);
    }
    await flush();
    expect(context.gains).toHaveLength(0);
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
  });

  it('returns the original source synchronously and routes native connect return values through an outlet', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const { context, source, destination, outlet } = await microphone();
    expect(source).toBe(context.sources[0]);
    expect(source.mediaStream).toBe(capture);
    expect(source.connect(destination)).toBe(destination);
    const parameter = new MockAudioParam();
    expect(source.connect(parameter, 0)).toBeUndefined();
    expect(source.connectCalls).toEqual([[outlet]]);
    expect(outlet.connectCalls).toEqual([[destination], [parameter, 0]]);
    await flush();
    const node = MockWorklet.instances[0]!;
    expect(source.connections).toEqual([[node]]);
    expect(node.connections).toEqual([[outlet]]);
    expect(outlet.connections).toEqual([[destination], [parameter, 0]]);
    expect(node.name).toBe('backspace-microphone-gate');
    expect(node.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max' });
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith(MODULE_URL, { credentials: 'omit' });
  });

  it('loads the processor module once per context while giving each microphone source its own node', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const first = await microphone();
    const second = await microphone(first.context);
    const third = await microphone();
    await flush();
    expect(first.context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(third.context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(MockWorklet.instances).toHaveLength(3);
    expect(first.source).not.toBe(second.source);
  });

  it('blocks enabled audio while loading and passes current settings into the first processor quantum', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: true, thresholdDb: -42 }));
    const loading = deferred();
    const context = new MockContext();
    context.audioWorklet.addModule.mockImplementation(() => loading.promise);
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination, outlet } = await microphone(context);
    source.connect(destination);
    expect(outlet.gain.value).toBe(0);
    await flush();
    expect(MockWorklet.instances).toHaveLength(0);
    settings(true, -35);
    expect(outlet.gain.value).toBe(0);
    loading.resolve();
    await flush();
    expect(MockWorklet.instances[0]!.options.processorOptions).toEqual({ enabled: true, thresholdDb: -35 });
    expect(MockWorklet.instances[0]!.port.postMessage).toHaveBeenLastCalledWith({ type: 'settings', enabled: true, thresholdDb: -35 });
    expect(outlet.gain.value).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ available: true, error: false });
  });

  it('allows exact bypass while disabled and responds to settings during pending initialization', async () => {
    const loading = deferred();
    const context = new MockContext();
    context.audioWorklet.addModule.mockImplementation(() => loading.promise);
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination, outlet } = await microphone(context);
    source.connect(destination);
    expect(outlet.gain.value).toBe(1);
    settings(true, -45);
    expect(outlet.gain.value).toBe(0);
    settings(false, -45);
    expect(outlet.gain.value).toBe(1);
    loading.resolve();
    await flush();
    expect(MockWorklet.instances[0]!.options.processorOptions).toEqual({ enabled: false, thresholdDb: -45 });
  });

  it('falls back to the original microphone on module failure and exposes the error', async () => {
    const context = new MockContext();
    const error = new Error('Worklet module was blocked');
    context.audioWorklet.addModule.mockRejectedValueOnce(error);
    cleanup = installMicrophoneGate(MODULE_URL);
    settings(true);
    const { source, destination, outlet } = await microphone(context);
    source.connect(destination);
    await flush();
    expect(MockWorklet.instances).toHaveLength(0);
    expect(source.connections).toEqual([[outlet]]);
    expect(outlet.connections).toEqual([[destination]]);
    expect(outlet.gain.value).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ available: false, error: true });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('original microphone audio'), error);
    settings(true, -20);
    expect(outlet.gain.value).toBe(1);
  });

  it('falls back and disposes the broken node on processorerror', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    settings(true);
    const { source, destination, outlet } = await microphone();
    source.connect(destination);
    await flush();
    const node = MockWorklet.instances[0]!;
    node.dispatchEvent(new Event('processorerror'));
    expect(node.port.onmessage).toBeNull();
    expect(node.port.close).toHaveBeenCalledOnce();
    expect(node.connections).toHaveLength(0);
    expect(source.connections).toEqual([[outlet]]);
    expect(outlet.gain.value).toBe(1);
    expect(statuses.at(-1)).toMatchObject({ available: false, error: true });
  });

  it('retains the processor when the web client disconnects and reconnects its source', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination, outlet } = await microphone();
    source.connect(destination);
    await flush();
    const node = MockWorklet.instances[0]!;
    source.disconnect();
    expect(outlet.connections).toHaveLength(0);
    expect(source.connections).toEqual([[node]]);
    expect(node.port.close).not.toHaveBeenCalled();
    expect(statuses.at(-1)!.available).toBe(false);
    const newDestination = new MockNode();
    expect(source.connect(newDestination)).toBe(newDestination);
    expect(outlet.connections).toEqual([[newDestination]]);
    expect(statuses.at(-1)!.available).toBe(true);
    expect(MockWorklet.instances).toHaveLength(1);
  });

  it('preserves destination and output-index disconnect overloads', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination, outlet } = await microphone();
    const second = new MockNode();
    source.connect(destination, 0, 0);
    source.connect(destination, 0, 1);
    source.connect(second, 0, 0);
    source.disconnect(destination, 0, 1);
    expect(outlet.disconnectCalls.at(-1)).toEqual([destination, 0, 1]);
    expect(outlet.connections).toEqual([[destination, 0, 0], [second, 0, 0]]);
    source.disconnect(destination);
    expect(outlet.disconnectCalls.at(-1)).toEqual([destination]);
    expect(outlet.connections).toEqual([[second, 0, 0]]);
    source.disconnect(0);
    expect(outlet.disconnectCalls.at(-1)).toEqual([0]);
    expect(outlet.connections).toHaveLength(0);
    await flush();
    expect(MockWorklet.instances[0]!.port.close).not.toHaveBeenCalled();
  });

  it('propagates normalized settings and accepts only finite level messages', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination } = await microphone();
    source.connect(destination);
    await flush();
    const node = MockWorklet.instances[0]!;
    settings(true, -200);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'settings', enabled: true, thresholdDb: -80 });
    settings(true, 5);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'settings', enabled: true, thresholdDb: -10 });
    settings(true, Number.NaN);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'settings', enabled: true, thresholdDb: -50 });
    node.level(-38, true);
    expect(statuses.at(-1)).toEqual({ available: true, error: false, db: -38, open: true });
    const count = statuses.length;
    node.level(Number.NaN, false);
    node.port.onmessage?.({ data: { type: 'unexpected', db: -20, open: false } });
    expect(statuses).toHaveLength(count);
    document.dispatchEvent(new Event('backspace-microphone-gate-status-request'));
    expect(statuses.at(-1)!.db).toBe(-38);
  });

  it('disposes capture processing on raw stop without replacing or firing onended', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const track = capture.tracks[0]!;
    const onended = vi.fn();
    track.onended = onended;
    const { source, destination, outlet } = await microphone();
    source.connect(destination);
    await flush();
    const node = MockWorklet.instances[0]!;
    expect(track.onended).toBe(onended);
    track.stop();
    expect(track.stopCalls).toBe(1);
    expect(track.onended).toBe(onended);
    expect(onended).not.toHaveBeenCalled();
    expect(track.stop).toBe(MockTrack.prototype.stop);
    expect(source.connect).toBe(MockNode.prototype.connect);
    expect(source.connections).toHaveLength(0);
    expect(outlet.connections).toHaveLength(0);
    expect(node.port.close).toHaveBeenCalledOnce();
    expect(statuses.at(-1)!.available).toBe(false);
  });

  it('disposes processing on upstream ended events while preserving the web client handler', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const onended = vi.fn();
    capture.tracks[0]!.onended = onended;
    const { source, destination } = await microphone();
    source.connect(destination);
    await flush();
    capture.tracks[0]!.end();
    expect(onended).toHaveBeenCalledOnce();
    expect(capture.tracks[0]!.onended).toBe(onended);
    expect(MockWorklet.instances[0]!.port.close).toHaveBeenCalledOnce();
    expect(source.connect).toBe(MockNode.prototype.connect);
  });

  it('disposes all sources watching a shared raw microphone track', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const first = await microphone();
    const second = await microphone(first.context);
    first.source.connect(first.destination);
    second.source.connect(second.destination);
    await flush();
    capture.tracks[0]!.stop();
    expect(MockWorklet.instances).toHaveLength(2);
    for (const node of MockWorklet.instances) expect(node.port.close).toHaveBeenCalledOnce();
    expect(capture.tracks[0]!.stop).toBe(MockTrack.prototype.stop);
    expect(first.source.connections).toHaveLength(0);
    expect(second.source.connections).toHaveLength(0);
  });

  it('disposes the graph when its audio context closes', async () => {
    cleanup = installMicrophoneGate(MODULE_URL);
    const { context, source, destination } = await microphone();
    source.connect(destination);
    await flush();
    context.close();
    expect(MockWorklet.instances[0]!.port.close).toHaveBeenCalledOnce();
    expect(source.connections).toHaveLength(0);
    expect(capture.tracks[0]!.stopCalls).toBe(0);
  });

  it('does not create a node when a pending module resolves after capture stops', async () => {
    const loading = deferred();
    const context = new MockContext();
    context.audioWorklet.addModule.mockImplementation(() => loading.promise);
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination, outlet } = await microphone(context);
    source.connect(destination);
    await flush();
    capture.tracks[0]!.stop();
    loading.resolve();
    await flush();
    expect(MockWorklet.instances).toHaveLength(0);
    expect(source.connections).toHaveLength(0);
    expect(outlet.connections).toHaveLength(0);
  });

  it('restores patched APIs and cleans up without stopping the original tracks', async () => {
    const originalSourceFactory = MockContext.prototype.createMediaStreamSource;
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination } = await microphone();
    source.connect(destination);
    await flush();
    cleanup();
    expect(navigator.mediaDevices.getUserMedia).toBe(nativeGetUserMedia);
    expect(MockContext.prototype.createMediaStreamSource).toBe(originalSourceFactory);
    expect(source.connect).toBe(MockNode.prototype.connect);
    expect(source.disconnect).toBe(MockNode.prototype.disconnect);
    expect(capture.tracks[0]!.stop).toBe(MockTrack.prototype.stop);
    expect(capture.tracks[0]!.stopCalls).toBe(0);
    expect(MockWorklet.instances[0]!.port.close).toHaveBeenCalledOnce();
    const count = statuses.length;
    settings(true);
    document.dispatchEvent(new Event('backspace-microphone-gate-status-request'));
    expect(statuses).toHaveLength(count);
    cleanup();
    expect(MockWorklet.instances[0]!.port.close).toHaveBeenCalledOnce();
    cleanup = installMicrophoneGate(MODULE_URL);
    expect(navigator.mediaDevices.getUserMedia).not.toBe(nativeGetUserMedia);
  });

  it('cleans up on page navigation and ignores late module results', async () => {
    const loading = deferred();
    const context = new MockContext();
    context.audioWorklet.addModule.mockImplementation(() => loading.promise);
    cleanup = installMicrophoneGate(MODULE_URL);
    const { source, destination } = await microphone(context);
    source.connect(destination);
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    loading.resolve();
    await flush();
    expect(MockWorklet.instances).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).toBe(nativeGetUserMedia);
    expect(source.connections).toHaveLength(0);
  });

  it('preserves a late capture result after cleanup without instrumenting or stopping it', async () => {
    let resolveCapture!: (stream: MediaStream) => void;
    nativeGetUserMedia.mockImplementationOnce(() => new Promise(resolve => { resolveCapture = resolve; }));
    cleanup = installMicrophoneGate(MODULE_URL);
    const pendingCapture = navigator.mediaDevices.getUserMedia({ audio: true });
    cleanup();
    resolveCapture(capture.asMediaStream());
    const stream = await pendingCapture;
    expect(stream).toBe(capture);
    expect(capture.tracks[0]!.stopCalls).toBe(0);
    const context = new MockContext();
    const source = context.createMediaStreamSource(stream);
    expect(source.connect).toBe(MockNode.prototype.connect);
    expect(context.gains).toHaveLength(0);
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
  });
});
