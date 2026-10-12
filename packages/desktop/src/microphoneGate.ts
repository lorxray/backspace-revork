/** Runs in the page's main world, with no Electron or Node APIs. */
export function installMicrophoneGate(moduleUrl: string): () => void {
  const scope = window as Window & { backspaceMicrophoneGateCleanup?: () => void };
  if (scope.backspaceMicrophoneGateCleanup) return scope.backspaceMicrophoneGateCleanup;

  type Settings = { enabled: boolean; thresholdDb: number };
  const normalize = (value: Partial<Settings> | null): Settings => ({
    enabled: value?.enabled === true,
    thresholdDb: typeof value?.thresholdDb === 'number' && Number.isFinite(value.thresholdDb)
      ? Math.max(-80, Math.min(-10, value.thresholdDb)) : -50,
  });
  let settings = normalize(null);
  try { settings = normalize(JSON.parse(localStorage.getItem('backspace-desktop-microphone-gate') || 'null')); } catch { /* Use defaults. */ }

  const microphones = new WeakSet<MediaStreamTrack>();
  const modules = new WeakMap<AudioContext, Promise<void>>();
  type Entry = {
    source: MediaStreamAudioSourceNode;
    outlet: GainNode;
    node: AudioWorkletNode | null;
    connections: unknown[][];
    db: number;
    open: boolean;
    error: boolean;
    disposed: boolean;
    dispose: () => void;
  };
  const entries = new Set<Entry>();
  type StopSubscription = { callbacks: Set<() => void>; restore: () => void };
  const stops = new WeakMap<MediaStreamTrack, StopSubscription>();
  const restores: Array<() => void> = [];
  let destroyed = false;

  function status(): void {
    const active = [...entries].filter(entry => !entry.disposed && entry.connections.length > 0);
    const latest = active[active.length - 1];
    document.dispatchEvent(new CustomEvent('backspace-microphone-gate-status', {
      detail: {
        available: !!latest?.node && !latest.error,
        db: latest?.db ?? -100,
        open: !settings.enabled || (latest?.open ?? false),
        error: latest?.error ?? false,
      },
    }));
  }

  // stop() does not emit 'ended'. Observe it without replacing any capture
  // tracks or their onended handlers, which remain owned by the web client.
  function watchTrack(track: MediaStreamTrack, callback: () => void): () => void {
    let subscription = stops.get(track);
    if (!subscription) {
      const descriptor = Object.getOwnPropertyDescriptor(track, 'stop');
      const nativeStop = track.stop;
      const callbacks = new Set<() => void>();
      const stop = function (this: MediaStreamTrack): void {
        Reflect.apply(nativeStop, this, []);
        if (this === track) for (const cb of [...callbacks]) cb();
      };
      Object.defineProperty(track, 'stop', { configurable: true, writable: true, value: stop });
      subscription = {
        callbacks,
        restore: () => {
          if (track.stop === stop) {
            if (descriptor) Object.defineProperty(track, 'stop', descriptor);
            else delete (track as unknown as Record<string, unknown>).stop;
          }
          stops.delete(track);
        },
      };
      stops.set(track, subscription);
    }
    const current = subscription;
    current.callbacks.add(callback);
    track.addEventListener('ended', callback);
    return () => {
      track.removeEventListener('ended', callback);
      current.callbacks.delete(callback);
      if (current.callbacks.size === 0) current.restore();
    };
  }

  function instrument(source: MediaStreamAudioSourceNode, context: AudioContext): void {
    const nativeConnect = source.connect;
    const nativeDisconnect = source.disconnect;
    const connectDescriptor = Object.getOwnPropertyDescriptor(source, 'connect');
    const disconnectDescriptor = Object.getOwnPropertyDescriptor(source, 'disconnect');
    const outlet = context.createGain();
    outlet.gain.value = settings.enabled ? 0 : 1;
    Reflect.apply(nativeConnect, source, [outlet]);
    const tracks = source.mediaStream.getAudioTracks();
    const entry: Entry = {
      source, outlet, node: null, connections: [], db: -100, open: false,
      error: false, disposed: false, dispose: () => {},
    };
    entries.add(entry);
    const unwatch: Array<() => void> = [];

    const connect = function (...args: unknown[]): unknown {
      const result = Reflect.apply(outlet.connect, outlet, args);
      if (!entry.connections.some(connection => connection[0] === args[0]
        && (connection[1] ?? 0) === (args[1] ?? 0) && (connection[2] ?? 0) === (args[2] ?? 0))) {
        entry.connections.push(args);
      }
      status();
      return result;
    };
    const disconnect = function (...args: unknown[]): void {
      Reflect.apply(outlet.disconnect, outlet, args);
      entry.connections = entry.connections.filter(connection => {
        if (!args.length) return false;
        if (typeof args[0] === 'number') return (connection[1] ?? 0) !== args[0];
        return connection[0] !== args[0]
          || (args.length > 1 && (connection[1] ?? 0) !== args[1])
          || (args.length > 2 && (connection[2] ?? 0) !== args[2]);
      });
      status();
    };
    Object.defineProperties(source, {
      connect: { configurable: true, writable: true, value: connect },
      disconnect: { configurable: true, writable: true, value: disconnect },
    });

    const restoreMethod = (name: 'connect' | 'disconnect', replacement: unknown, descriptor?: PropertyDescriptor) => {
      if (source[name] !== replacement) return;
      if (descriptor) Object.defineProperty(source, name, descriptor);
      else delete (source as unknown as Record<string, unknown>)[name];
    };
    entry.dispose = () => {
      if (entry.disposed) return;
      entry.disposed = true;
      for (const unsubscribe of unwatch) unsubscribe();
      context.removeEventListener('statechange', onContextState);
      Reflect.apply(nativeDisconnect, source, []);
      outlet.disconnect();
      if (entry.node) {
        entry.node.port.onmessage = null;
        entry.node.port.close();
        entry.node.disconnect();
      }
      restoreMethod('connect', connect, connectDescriptor);
      restoreMethod('disconnect', disconnect, disconnectDescriptor);
      entries.delete(entry);
      status();
    };
    const onTracksEnded = () => {
      if (tracks.every(track => track.readyState === 'ended')) entry.dispose();
    };
    const onContextState = () => { if (context.state === 'closed') entry.dispose(); };
    for (const track of tracks) unwatch.push(watchTrack(track, onTracksEnded));
    context.addEventListener('statechange', onContextState);

    const fail = (error: unknown) => {
      if (entry.disposed) return;
      entry.error = true;
      if (entry.node) {
        entry.node.port.onmessage = null;
        entry.node.port.close();
        entry.node.disconnect();
        entry.node = null;
      }
      Reflect.apply(nativeDisconnect, source, []);
      Reflect.apply(nativeConnect, source, [outlet]);
      outlet.gain.value = 1;
      console.warn('[microphone-gate] Audio processing unavailable; using original microphone audio.', error);
      status();
    };

    let loading = modules.get(context);
    if (!loading) {
      loading = Promise.resolve().then(() => context.audioWorklet.addModule(moduleUrl, { credentials: 'omit' }));
      modules.set(context, loading);
    }
    void loading.then(() => {
      if (entry.disposed || destroyed) return;
      const node = new AudioWorkletNode(context, 'backspace-microphone-gate', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCountMode: 'max',
        processorOptions: settings,
      });
      entry.node = node;
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data?.type !== 'level' || typeof event.data.db !== 'number' || !Number.isFinite(event.data.db)) return;
        entry.db = event.data.db;
        entry.open = event.data.open === true;
        status();
      };
      node.addEventListener('processorerror', fail, { once: true });
      Reflect.apply(nativeDisconnect, source, []);
      Reflect.apply(nativeConnect, source, [node]);
      node.connect(outlet);
      outlet.gain.value = 1;
      node.port.postMessage({ type: 'settings', ...settings });
      status();
    }).catch(fail);
  }

  const mediaDevices = navigator.mediaDevices;
  if (mediaDevices?.getUserMedia) {
    const original = mediaDevices.getUserMedia;
    const descriptor = Object.getOwnPropertyDescriptor(mediaDevices, 'getUserMedia');
    const getUserMedia = async function (this: MediaDevices, constraints: MediaStreamConstraints): Promise<MediaStream> {
      const stream = await Reflect.apply(original, this, [constraints]) as MediaStream;
      const audio = constraints?.audio as boolean | (MediaTrackConstraints & {
        chromeMediaSource?: string; mandatory?: { chromeMediaSource?: string };
      }) | undefined;
      const desktopAudio = typeof audio === 'object' && (audio?.chromeMediaSource || audio?.mandatory?.chromeMediaSource);
      if (!destroyed && audio && !desktopAudio) {
        // Linux system audio is opened via getUserMedia too. Match the actual
        // capture, including a virtual source selected as the default device.
        // Keep this label local: the adapter is serialized without imports.
        const isSystemAudio = (label: string) => label.includes('vencord-screen-share');
        const candidates = stream.getAudioTracks()
          .filter(track => !isSystemAudio(track.label))
          .map(track => ({ track, deviceId: track.getSettings?.().deviceId }));
        const systemAudioIds = new Set<string>();
        if (candidates.some(({ deviceId }) => !!deviceId) && mediaDevices.enumerateDevices) {
          try {
            for (const device of await mediaDevices.enumerateDevices()) {
              if (device.kind === 'audioinput' && isSystemAudio(device.label)) systemAudioIds.add(device.deviceId);
            }
          } catch { /* Device inspection must not turn a successful capture into a failure. */ }
        }
        if (!destroyed) for (const { track, deviceId } of candidates) {
          if (!deviceId || !systemAudioIds.has(deviceId)) microphones.add(track);
        }
      }
      return stream;
    };
    Object.defineProperty(mediaDevices, 'getUserMedia', { configurable: true, writable: true, value: getUserMedia });
    restores.push(() => {
      if (mediaDevices.getUserMedia !== getUserMedia) return;
      if (descriptor) Object.defineProperty(mediaDevices, 'getUserMedia', descriptor);
      else delete (mediaDevices as unknown as Record<string, unknown>).getUserMedia;
    });
  }

  const constructors = [window.AudioContext, (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext];
  const prototypes = new Set(constructors.filter(Boolean).map(ctor => ctor!.prototype));
  for (const prototype of prototypes) {
    const original = prototype.createMediaStreamSource;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'createMediaStreamSource');
    const createMediaStreamSource = function (this: AudioContext, stream: MediaStream): MediaStreamAudioSourceNode {
      const source = Reflect.apply(original, this, [stream]) as MediaStreamAudioSourceNode;
      const tracks = stream.getAudioTracks();
      // A mixed stream must not route system or remote audio through the gate.
      if (!destroyed && tracks.length > 0 && tracks.every(track => microphones.has(track))) instrument(source, this);
      return source;
    };
    Object.defineProperty(prototype, 'createMediaStreamSource', { configurable: true, writable: true, value: createMediaStreamSource });
    restores.push(() => {
      if (prototype.createMediaStreamSource !== createMediaStreamSource) return;
      if (descriptor) Object.defineProperty(prototype, 'createMediaStreamSource', descriptor);
      else delete (prototype as unknown as Record<string, unknown>).createMediaStreamSource;
    });
  }

  const onSettings = (event: Event) => {
    settings = normalize((event as CustomEvent<Settings>).detail);
    for (const entry of entries) {
      entry.node?.port.postMessage({ type: 'settings', ...settings });
      if (!entry.node && !entry.error) entry.outlet.gain.value = settings.enabled ? 0 : 1;
    }
    status();
  };
  document.addEventListener('backspace-microphone-gate-settings', onSettings);
  document.addEventListener('backspace-microphone-gate-status-request', status);
  const cleanup = () => {
    destroyed = true;
    document.removeEventListener('backspace-microphone-gate-settings', onSettings);
    document.removeEventListener('backspace-microphone-gate-status-request', status);
    window.removeEventListener('pagehide', cleanup);
    for (const entry of [...entries]) entry.dispose();
    for (const restore of restores.reverse()) restore();
    if (scope.backspaceMicrophoneGateCleanup === cleanup) delete scope.backspaceMicrophoneGateCleanup;
  };
  scope.backspaceMicrophoneGateCleanup = cleanup;
  window.addEventListener('pagehide', cleanup);
  return cleanup;
}
