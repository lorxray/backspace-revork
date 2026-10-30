import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voiceStore';

vi.mock('../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({}) } }));

afterEach(() => {
  useVoiceStore.setState(useVoiceStore.getInitialState(), true);
  localStorage.removeItem('backspace-voice-settings');
});

describe('stream volume boundaries', () => {
  it('accepts the full 0-400% range and clamps out-of-range input per stream', () => {
    const state = useVoiceStore.getState();
    state.setStreamVolume('other', 250);
    state.setStreamVolume('sharer', 400);
    expect(useVoiceStore.getState().streamVolumes.get('sharer')).toBe(400);
    state.setStreamVolume('sharer', 900);
    expect(useVoiceStore.getState().streamVolumes.get('sharer')).toBe(400);
    state.setStreamVolume('sharer', -10);
    expect(useVoiceStore.getState().streamVolumes.get('sharer')).toBe(0);
    expect(useVoiceStore.getState().streamVolumes.get('other')).toBe(250);
  });

  it.each([NaN, Infinity, -Infinity])('ignores invalid gain %s without replacing the current level', invalid => {
    useVoiceStore.getState().setStreamVolume('sharer', 350);
    useVoiceStore.getState().setStreamVolume('sharer', invalid);
    expect(useVoiceStore.getState().streamVolumes.get('sharer')).toBe(350);
    useVoiceStore.getState().setStreamVolume('unknown', invalid);
    expect(useVoiceStore.getState().streamVolumes.has('unknown')).toBe(false);
  });
});
