import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { registerMicrophoneGateProcessor } from './microphoneGateProcessor';

interface LevelMessage {
  type: 'level';
  db: number;
  open: boolean;
}

interface Gate {
  port: { onmessage: ((event: { data: unknown }) => void) | null };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function createGate(rate = 48000, processorOptions?: { enabled?: boolean; thresholdDb?: number }) {
  const messages: LevelMessage[] = [];
  let Processor: (new(options?: { processorOptions?: { enabled?: boolean; thresholdDb?: number } }) => Gate) | undefined;
  let registeredName: string | undefined;
  class MockAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: LevelMessage) => messages.push(message),
    };
  }
  // Every test runs the serialized function in a fresh worklet-like realm. This
  // catches imports or compiler helpers accidentally captured by toString().
  runInNewContext(`(${registerMicrophoneGateProcessor.toString()})();`, {
    sampleRate: rate,
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor: (name: string, implementation: typeof Processor) => {
      registeredName = name;
      Processor = implementation;
    },
  });
  if (!Processor) throw new Error('The microphone worklet was not registered');
  const gate = new Processor({ processorOptions });

  return {
    gate,
    messages,
    registeredName,
    settings: (enabled: boolean, thresholdDb = -50) => {
      gate.port.onmessage?.({ data: { type: 'settings', enabled, thresholdDb } });
    },
    render: (channels: Float32Array[], quantum = 128) => {
      const length = channels[0]?.length ?? 0;
      const result = channels.map(() => new Float32Array(length));
      for (let start = 0; start < length; start += quantum) {
        const end = Math.min(length, start + quantum);
        const input = channels.map((channel) => channel.subarray(start, end));
        const output = channels.map(() => new Float32Array(end - start));
        expect(gate.process([input], [output])).toBe(true);
        output.forEach((channel, index) => result[index]!.set(channel, start));
      }
      return result;
    },
    tone: (milliseconds: number, db: number) => {
      const peak = Math.SQRT2 * 10 ** (db / 20);
      return Float32Array.from(
        { length: Math.round(rate * milliseconds / 1000) },
        (_, index) => peak * Math.sin(2 * Math.PI * 1000 * index / rate),
      );
    },
    silence: (milliseconds: number) => new Float32Array(Math.round(rate * milliseconds / 1000)),
  };
}

function maxAmplitude(samples: Float32Array): number {
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, Math.abs(sample));
  return maximum;
}

function maxDifference(actual: Float32Array, expected: Float32Array): number {
  expect(actual.length).toBe(expected.length);
  let maximum = 0;
  for (let index = 0; index < actual.length; index++) {
    maximum = Math.max(maximum, Math.abs(actual[index]! - expected[index]!));
  }
  return maximum;
}

describe('desktop microphone gate worklet', () => {
  it('serializes without dependencies and defaults to a sample-exact bypass', () => {
    const worklet = createGate();
    expect(worklet.registeredName).toBe('backspace-microphone-gate');
    const channels = [worklet.tone(150, -12), worklet.tone(150, -26)];
    const result = worklet.render(channels);
    result.forEach((channel, index) => expect(maxDifference(channel, channels[index]!)).toBe(0));
    expect(worklet.messages).toHaveLength(1);
    expect(worklet.messages[0]!.open).toBe(true);
  });

  it('blocks microphone noise below the chosen threshold', () => {
    const worklet = createGate();
    worklet.settings(true, -50);
    const [output] = worklet.render([worklet.tone(400, -65)]);
    expect(maxAmplitude(output!)).toBe(0);
    expect(worklet.messages.at(-1)).toMatchObject({ type: 'level', open: false });
    expect(worklet.messages.at(-1)!.db).toBeCloseTo(-65, 3);
  });

  it('honors constructor settings before the first quantum is rendered', () => {
    const worklet = createGate(48000, { enabled: true, thresholdDb: -30 });
    const [output] = worklet.render([worklet.tone(100, -45)]);
    expect(maxAmplitude(output!)).toBe(0);
    expect(worklet.messages.at(-1)!.open).toBe(false);
  });

  it('preserves speech onset with a ten-millisecond lookahead', () => {
    const worklet = createGate();
    worklet.settings(true);
    const speech = worklet.tone(200, -20);
    const [output] = worklet.render([speech]);
    const delay = 480;
    expect(maxAmplitude(output!.subarray(0, delay))).toBe(0);
    expect(maxDifference(output!.subarray(delay), speech.subarray(0, speech.length - delay))).toBeLessThan(1e-7);
    expect(worklet.messages.at(-1)!.open).toBe(true);
  });

  it('uses hysteresis to retain speech slightly below the opening threshold', () => {
    const worklet = createGate();
    worklet.settings(true, -40);
    worklet.render([worklet.tone(100, -35)]);
    const [output] = worklet.render([worklet.tone(400, -42)]);
    expect(maxAmplitude(output!.subarray(output!.length - 4800))).toBeGreaterThan(0.01);
    expect(worklet.messages.at(-1)!.open).toBe(true);
  });

  it('holds short speech gaps, then fades out noise over the release interval', () => {
    const worklet = createGate();
    worklet.settings(true, -40);
    worklet.render([worklet.tone(100, -30)]);
    const [quiet] = worklet.render([worklet.tone(400, -55)]);
    // The first 10 ms still contains delayed speech; compare the same noise tone
    // during hold, during release, and after both intervals have elapsed.
    expect(maxAmplitude(quiet!.subarray(4800, 7200))).toBeGreaterThan(0.002);
    const midRelease = maxAmplitude(quiet!.subarray(12000, 12480));
    expect(midRelease).toBeGreaterThan(0);
    expect(midRelease).toBeLessThan(maxAmplitude(quiet!.subarray(4800, 5280)));
    expect(maxAmplitude(quiet!.subarray(14880))).toBe(0);
    expect(worklet.messages.at(-1)!.open).toBe(false);
  });

  it('closes on silence and reports a finite floor instead of minus infinity', () => {
    const worklet = createGate();
    worklet.settings(true);
    worklet.render([worklet.tone(100, -20)]);
    const [silence] = worklet.render([worklet.silence(400)]);
    expect(maxAmplitude(silence!.subarray(480))).toBe(0);
    expect(worklet.messages.at(-1)).toMatchObject({ db: -100, open: false });
  });

  it('gates all channels together without cancelling antiphase stereo', () => {
    const worklet = createGate();
    worklet.settings(true, -40);
    const left = worklet.tone(200, -30);
    const right = Float32Array.from(left, (sample) => -sample);
    const [outLeft, outRight] = worklet.render([left, right]);
    expect(maxAmplitude(outLeft!)).toBeGreaterThan(0.04);
    expect(maxDifference(outRight!, Float32Array.from(outLeft!, (sample) => -sample))).toBe(0);
    expect(worklet.messages.at(-1)!.db).toBeCloseTo(-30, 3);
  });

  it('detects the loudest channel and preserves quieter channels with the same gain', () => {
    const worklet = createGate();
    worklet.settings(true, -40);
    const channels = [-70, -65, -60, -20].map((db) => worklet.tone(200, db));
    const output = worklet.render(channels);
    output.forEach((channel, index) => {
      expect(maxDifference(channel.subarray(480), channels[index]!.subarray(0, channels[index]!.length - 480))).toBeLessThan(1e-7);
    });
  });

  it('bypasses immediately when disabled and never replays a previous capture', () => {
    const worklet = createGate();
    worklet.settings(true);
    worklet.render([worklet.tone(100, -20)]);
    worklet.settings(false);
    const speech = worklet.tone(30, -10);
    const [bypass] = worklet.render([speech]);
    expect(maxDifference(bypass!, speech)).toBe(0);
    worklet.settings(true);
    const [output] = worklet.render([worklet.silence(30)]);
    expect(maxAmplitude(output!)).toBe(0);
  });

  it('applies threshold changes to an already active microphone', () => {
    const worklet = createGate();
    worklet.settings(true, -50);
    worklet.render([worklet.tone(100, -45)]);
    expect(worklet.messages.at(-1)!.open).toBe(true);
    worklet.settings(true, -30);
    const [output] = worklet.render([worklet.tone(400, -45)]);
    expect(maxAmplitude(output!.subarray(14880))).toBe(0);
    expect(worklet.messages.at(-1)!.open).toBe(false);
  });

  it('validates settings and clamps thresholds to the supported range', () => {
    const worklet = createGate();
    worklet.settings(true, -120);
    worklet.render([worklet.tone(100, -85)]);
    expect(worklet.messages.at(-1)!.open).toBe(false);
    worklet.render([worklet.tone(100, -75)]);
    expect(worklet.messages.at(-1)!.open).toBe(true);
    worklet.settings(true, 20);
    const [output] = worklet.render([worklet.tone(400, -5)]);
    expect(maxAmplitude(output!.subarray(14880))).toBe(0);
    worklet.settings(false, -50);
    worklet.settings(true, Number.NaN);
    worklet.gate.port.onmessage?.({ data: { type: 'settings', thresholdDb: Number.POSITIVE_INFINITY } });
    worklet.gate.port.onmessage?.({ data: { type: 'unexpected', enabled: false } });
    worklet.gate.port.onmessage?.({ data: null });
    worklet.render([worklet.tone(100, -40)]);
    expect(worklet.messages.at(-1)!.open).toBe(true);
  });

  it.each([32000, 44100, 48000, 96000])('keeps PCM and timing independent of quantum size at %i Hz', (rate) => {
    const reference = createGate(rate);
    const alternate = createGate(rate);
    reference.settings(true, -40);
    alternate.settings(true, -40);
    const speech = reference.tone(120, -25);
    const noise = reference.tone(360, -65);
    const samples = new Float32Array(speech.length + noise.length);
    samples.set(speech);
    samples.set(noise, speech.length);
    const [expected] = reference.render([samples], 128);
    const [actual] = alternate.render([samples], 333);
    expect(maxDifference(actual!, expected!)).toBe(0);
    expect(alternate.messages).toEqual(reference.messages);
  });

  it('limits level updates to ten per second even with tiny processing blocks', () => {
    const worklet = createGate();
    worklet.settings(true);
    worklet.render([worklet.tone(1000, -20)], 32);
    expect(worklet.messages).toHaveLength(10);
    expect(worklet.messages.every((message) => message.type === 'level' && Number.isFinite(message.db))).toBe(true);
  });

  it('outputs silence when the input disappears instead of replaying delayed audio', () => {
    const worklet = createGate();
    worklet.settings(true);
    worklet.render([worklet.tone(100, -20)]);
    const output = new Float32Array(4800);
    expect(worklet.gate.process([[]], [[output]])).toBe(true);
    expect(maxAmplitude(output)).toBe(0);
    expect(worklet.messages.at(-1)).toMatchObject({ db: -100, open: false });
  });
});
