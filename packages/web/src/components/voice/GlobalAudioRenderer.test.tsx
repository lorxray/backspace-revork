import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalAudioRenderer } from './GlobalAudioRenderer';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

const audio = vi.hoisted(() => ({
  graphs: new Map<string, { target: number; disconnect: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('../../audio/AudioManager', () => ({
  AudioManager: { getInstance: () => ({
    ensureContext: () => ({
      currentTime: 0,
      createMediaStreamSource: (stream: MediaStream) => ({
        connect: (gain: { graph: { target: number; disconnect: ReturnType<typeof vi.fn> } }) => {
          audio.graphs.set(stream.getTracks()[0]!.id, gain.graph);
        },
        disconnect: vi.fn(),
      }),
      createGain: () => {
        const graph = { target: 0, disconnect: vi.fn() };
        return { graph, gain: {
          setValueAtTime: (value: number) => { graph.target = value; },
          setTargetAtTime: (value: number) => { graph.target = value; },
        }, connect: vi.fn(), disconnect: graph.disconnect };
      },
    }),
    getMasterOutput: () => ({}),
  }) },
}));

vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (state: { channelToSpaceMap: Map<string, string> }) => unknown) => selector({ channelToSpaceMap: new Map([['channel', 'space']]) }),
  getChannelOrigin: () => 'https://host.example',
  getMyUserIdForOrigin: () => 'local-on-host',
}));

function track(id: string): MediaStreamTrack {
  return { id, readyState: 'live', stop: vi.fn() } as unknown as MediaStreamTrack;
}

beforeEach(() => {
  audio.graphs.clear();
  vi.stubGlobal('MediaStream', class {
    constructor(private readonly tracks: MediaStreamTrack[]) {}
    getTracks() { return this.tracks; }
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  useVoiceStore.setState({
    ...useVoiceStore.getInitialState(),
    currentVoiceChannelId: 'channel',
    outputVolume: 80,
    watchingStreams: new Set(['sharer']),
    participantVolumes: new Map([['sharer', 50]]),
    streamVolumes: new Map([['sharer', 150]]),
    participants: [{
      identity: 'sharer:Alice', userId: 'sharer', isLocal: false,
      audioTrack: track('mic'), screenAudioTrack: track('stream'),
    } as ParticipantInfo],
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const gain = (id: string) => audio.graphs.get(id)!.target;

describe('independent voice and stream audio output', () => {
  it('keeps a watched stream audible when the headphones button mutes all voices, and restores voice volume', () => {
    const { container } = render(<GlobalAudioRenderer />);
    expect(gain('mic')).toBeCloseTo(0.4);
    expect(gain('stream')).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().toggleDeafen());
    expect(useVoiceStore.getState().isMuted).toBe(true);
    expect(gain('mic')).toBe(0);
    expect(gain('stream')).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().toggleDeafen());
    expect(gain('mic')).toBeCloseTo(0.4);
    expect(gain('stream')).toBeCloseTo(1.2);
    for (const element of container.querySelectorAll('audio')) {
      expect(element.muted).toBe(true);
      expect(element.volume).toBe(0);
    }
  });

  it('keeps stream mute and volume controls working while voices are muted', () => {
    useVoiceStore.setState({ isMuted: true, isDeafened: true });
    render(<GlobalAudioRenderer />);
    expect(gain('stream')).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().setStreamMute('sharer', true));
    expect(gain('stream')).toBe(0);
    act(() => useVoiceStore.getState().setStreamVolume('sharer', 25));
    expect(gain('stream')).toBe(0);
    act(() => useVoiceStore.getState().setStreamMute('sharer', false));
    expect(gain('stream')).toBeCloseTo(0.2);
    expect(gain('mic')).toBe(0);
  });

  it('keeps an individually muted participant separate from their stream', () => {
    render(<GlobalAudioRenderer />);
    act(() => useVoiceStore.getState().setParticipantMute('sharer', true));
    expect(gain('mic')).toBe(0);
    expect(gain('stream')).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().setParticipantVolume('sharer', 0));
    expect(gain('stream')).toBeCloseTo(1.2);
  });

  it.each(['deafen', 'participant-mute', 'zero-voice-volume'])('does not duck streams for inaudible voices after %s', action => {
    useVoiceStore.setState({
      streamAttenuationEnabled: true, streamAttenuationStrength: 100,
      speakingParticipantIds: new Set(['sharer:Alice']),
    });
    render(<GlobalAudioRenderer />);
    expect(gain('stream')).toBe(0);
    act(() => {
      const state = useVoiceStore.getState();
      if (action === 'deafen') state.toggleDeafen();
      if (action === 'participant-mute') state.setParticipantMute('sharer', true);
      if (action === 'zero-voice-volume') state.setParticipantVolume('sharer', 0);
    });
    expect(gain('mic')).toBe(0);
    expect(gain('stream')).toBeCloseTo(1.2);
  });

  it('honours space deafen from a moderator for voice and stream audio', () => {
    render(<GlobalAudioRenderer />);
    act(() => useVoiceStore.setState({ spaceDeafenedUserIds: new Set(['space:local-on-host']) }));
    expect(gain('mic')).toBe(0);
    expect(gain('stream')).toBe(0);
    act(() => useVoiceStore.setState({ spaceDeafenedUserIds: new Set() }));
    expect(gain('mic')).toBeCloseTo(0.4);
    expect(gain('stream')).toBeCloseTo(1.2);
  });

  it('does not play unwatched streams and stops their pipeline when watching ends', () => {
    useVoiceStore.setState({ watchingStreams: new Set() });
    render(<GlobalAudioRenderer />);
    expect(audio.graphs.has('stream')).toBe(false);
    act(() => useVoiceStore.getState().watchStream('sharer'));
    const graph = audio.graphs.get('stream')!;
    expect(graph.target).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().unwatchStream('sharer'));
    expect(graph.disconnect).toHaveBeenCalledOnce();
  });

  it('respects zero output volume and leaves unrelated space restrictions out of a DM call', () => {
    useVoiceStore.setState({ isDeafened: true, currentVoiceChannelId: null, spaceDeafenedUserIds: new Set(['space:local-on-host']) });
    render(<GlobalAudioRenderer />);
    expect(gain('mic')).toBe(0);
    expect(gain('stream')).toBeCloseTo(1.2);
    act(() => useVoiceStore.getState().setOutputVolume(0));
    expect(gain('stream')).toBe(0);
  });
});
