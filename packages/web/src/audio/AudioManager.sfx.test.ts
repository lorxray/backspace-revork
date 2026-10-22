import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from './AudioManager';
vi.mock('@sapphi-red/web-noise-suppressor', () => ({ RnnoiseWorkletNode: class {}, loadRnnoise: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('sound effect resource lifetime', () => {
  it.each([false, true])('disconnects a completed or explicitly stopped sound (loop=%s)', async loop => {
    const manager = AudioManager.getInstance();
    const source = Object.assign(new EventTarget(), { buffer: null, loop: false, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn() });
    const gain = { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
    const state = manager as unknown as { ctx: unknown; masterBoost: unknown };
    const previousContext = state.ctx, previousMaster = state.masterBoost;
    state.ctx = { currentTime: 5, createBufferSource: () => source, createGain: () => gain };
    state.masterBoost = {};
    vi.spyOn(manager, 'resumeContext').mockResolvedValue(undefined);
    vi.spyOn(manager, 'loadSound').mockResolvedValue({ duration: 1 } as AudioBuffer);
    try {
      expect(await manager.playSound('stream_started', { loop })).toBe(source);
      expect(source.disconnect).not.toHaveBeenCalled();
      source.dispatchEvent(new Event('ended'));
      source.dispatchEvent(new Event('ended'));
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(gain.disconnect).toHaveBeenCalledOnce();
    } finally { state.ctx = previousContext; state.masterBoost = previousMaster; }
  });
});
