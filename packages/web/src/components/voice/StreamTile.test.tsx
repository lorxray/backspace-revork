import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import type { StreamTile as StreamTileType } from '../../hooks/useLiveKit';

vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ playSound: vi.fn() }) } }));
vi.mock('../../hooks/useLiveKit', () => ({ getActiveRoom: () => null, setStreamSubscription: vi.fn() }));
vi.mock('../../hooks/useVoiceParticipantMeta', () => ({
  useVoiceParticipantMeta: () => ({ displayName: 'Ada', avatar: null, user: null }),
}));
vi.mock('../../hooks/useStreamViewerQuality', () => ({
  useStreamViewerQuality: () => ({ quality: 'auto', options: [{ value: 'original' }], setQuality: vi.fn() }),
}));

function tile(isLocal = false): StreamTileType {
  const screenTrack = {
    readyState: 'live',
    getSettings: () => ({ height: 1440, frameRate: 60 }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaStreamTrack;
  return {
    kind: 'stream',
    key: 'ada:stream',
    participant: {
      identity: 'ada', userId: 'ada', username: 'ada', homeUserId: null,
      isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: true,
      isLocal, audioTrack: null, videoTrack: null, screenTrack, screenAudioTrack: null,
      lkVideoTrack: null, lkScreenTrack: null, cachedUser: null,
    },
    screenTrack,
    screenAudioTrack: null,
    lkScreenTrack: null,
  };
}

beforeEach(() => {
  useVoiceStore.setState({ watchingStreams: new Set(), connectionQualities: new Map() });
});

describe('StreamTile viewer quality entry point', () => {
  it('shows quality for a watched remote stream', () => {
    useVoiceStore.setState({ watchingStreams: new Set(['ada']) });
    render(<StreamTile tile={tile()} stats={null} />);
    expect(screen.getByRole('button', { name: 'Quality: Auto' })).toBeVisible();
    expect(screen.getByTestId('stream-tile-caption')).toContainElement(screen.getByRole('button', { name: 'Quality: Auto' }));
  });

  it('keeps the entry point off a remote stream before it is watched', () => {
    render(<StreamTile tile={tile()} stats={null} />);
    expect(screen.queryByRole('button', { name: /Quality:/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch Stream' })).toBeInTheDocument();
  });

  it('keeps publisher quality settings separate from the viewer menu', () => {
    useVoiceStore.setState({ watchingStreams: new Set(['ada']) });
    render(<StreamTile tile={tile(true)} stats={null} />);
    expect(screen.queryByRole('button', { name: /Quality:/ })).not.toBeInTheDocument();
  });
});
