declare const sampleRate: number;
declare const AudioWorkletProcessor: {
  new(): {
    readonly port: {
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      postMessage(message: unknown): void;
    };
  };
};
declare function registerProcessor(name: string, processor: unknown): void;

/**
 * Serialized by the desktop preload into an AudioWorklet module. Keep all runtime
 * definitions inside this function: a worklet cannot import the Electron bundle.
 * Settings use dBFS; disabled mode passes the microphone through without latency.
 */
export function registerMicrophoneGateProcessor(): void {
  class MicrophoneGateProcessor extends AudioWorkletProcessor {
    private enabled = false;
    private thresholdDb = -50;
    private readonly windowFrames = Math.max(1, Math.round(sampleRate * 0.01));
    private readonly holdFrames = Math.max(1, Math.round(sampleRate * 0.2));
    private readonly attackStep = 1 / Math.max(1, Math.round(sampleRate * 0.005));
    private readonly releaseStep = 1 / Math.max(1, Math.round(sampleRate * 0.08));
    private readonly meterFrames = Math.max(1, Math.round(sampleRate / 10));
    private energy: Float64Array[] = [];
    private sums: number[] = [];
    private delay: Float32Array[] = [];
    private position = 0;
    private holdRemaining = 0;
    private gain = 0;
    private gateOpen = false;
    private meterRemaining = this.meterFrames;

    constructor(options?: { processorOptions?: { enabled?: boolean; thresholdDb?: number } }) {
      super();
      this.applySettings({ type: 'settings', ...options?.processorOptions });
      this.port.onmessage = ({ data }) => this.applySettings(data);
    }

    private applySettings(data: unknown): void {
      if (!data || typeof data !== 'object') return;
      const settings = data as { type?: unknown; enabled?: unknown; thresholdDb?: unknown };
      if (settings.type !== 'settings') return;
      if (typeof settings.thresholdDb === 'number' && Number.isFinite(settings.thresholdDb)) {
        this.thresholdDb = Math.max(-80, Math.min(0, settings.thresholdDb));
      }
      if (typeof settings.enabled === 'boolean' && settings.enabled !== this.enabled) {
        this.enabled = settings.enabled;
        this.reset();
      }
    }

    private reset(): void {
      this.position = 0;
      this.holdRemaining = 0;
      this.gain = 0;
      this.gateOpen = false;
      for (const channel of this.energy) channel.fill(0);
      for (const channel of this.delay) channel.fill(0);
      this.sums.fill(0);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const input = inputs[0] ?? [];
      const output = outputs[0] ?? [];
      const frameCount = output[0]?.length ?? input[0]?.length ?? 0;
      if (this.energy.length !== input.length || this.delay.length !== output.length) {
        this.energy = input.map(() => new Float64Array(this.windowFrames));
        this.sums = input.map(() => 0);
        this.delay = output.map(() => new Float32Array(this.windowFrames));
        this.reset();
      }

      const openLevel = 10 ** (this.thresholdDb / 20);
      const closeLevel = 10 ** ((this.thresholdDb - 3) / 20);
      for (let frame = 0; frame < frameCount; frame++) {
        let maxEnergy = 0;
        for (let channel = 0; channel < input.length; channel++) {
          const sample = input[channel]?.[frame] ?? 0;
          const square = Number.isFinite(sample) ? sample * sample : 0;
          const history = this.energy[channel]!;
          const sum = Math.max(0, this.sums[channel]! + square - history[this.position]!);
          history[this.position] = square;
          this.sums[channel] = sum;
          maxEnergy = Math.max(maxEnergy, sum);
        }
        // A sliding window makes detector timing independent of render quantum.
        // Max per-channel RMS also keeps antiphase stereo from cancelling speech.
        const rms = Math.sqrt(maxEnergy / this.windowFrames);
        if (this.enabled) {
          if (rms >= (this.gateOpen ? closeLevel : openLevel)) {
            this.gateOpen = true;
            this.holdRemaining = this.holdFrames;
          } else if (this.gateOpen && --this.holdRemaining <= 0) {
            this.gateOpen = false;
          }
          this.gain = this.gateOpen
            ? Math.min(1, this.gain + this.attackStep)
            : Math.max(0, this.gain - this.releaseStep);
        }

        for (let channel = 0; channel < output.length; channel++) {
          const sample = input[channel]?.[frame] ?? 0;
          if (this.enabled) {
            const history = this.delay[channel]!;
            output[channel]![frame] = history[this.position]! * this.gain;
            history[this.position] = Number.isFinite(sample) ? sample : 0;
          } else {
            output[channel]![frame] = sample;
          }
        }
        this.position = (this.position + 1) % this.windowFrames;
        if (--this.meterRemaining <= 0) {
          this.meterRemaining = this.meterFrames;
          this.port.postMessage({
            type: 'level',
            db: Math.max(-100, 20 * Math.log10(Math.max(rms, 0.00001))),
            open: !this.enabled || this.gateOpen,
          });
        }
      }
      return true;
    }
  }

  registerProcessor('backspace-microphone-gate', MicrophoneGateProcessor);
}
