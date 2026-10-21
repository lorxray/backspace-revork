import { describe, expect, it, vi } from 'vitest';
import { Track, type Room } from 'livekit-client';
import { installScreenShareEncoderLifecycle } from './screenShareEncoderLifecycle';

function sender(id: string, kind = 'video') {
  const track = { id, kind, readyState: 'live', stop: vi.fn(() => { track.readyState = 'ended'; }) };
  return { track: track as unknown as MediaStreamTrack | null };
}

function transceiver(trackSender: ReturnType<typeof sender>) {
  const value = {
    sender: trackSender,
    direction: 'sendonly',
    currentDirection: 'sendonly',
    stopped: false,
    stop: vi.fn(() => { value.stopped = true; }),
  };
  return value;
}

function fixture() {
  const primary = sender('screen');
  const backup = sender('backup');
  const primaryTrack = primary.track!;
  const backupTrack = backup.track!;
  const camera = sender('camera');
  const audio = sender('system-audio', 'audio');
  const placeholder = sender('placeholder');
  placeholder.track = null;
  const transceivers = [primary, backup, camera, audio, placeholder].map(transceiver);
  const pc = {
    connectionState: 'connected',
    signalingState: 'stable',
    getTransceivers: vi.fn(() => transceivers),
  };
  const screen = {
    mediaStreamTrack: primary.track!,
    sender: primary as typeof primary | undefined,
    simulcastCodecs: new Map([['vp8', { sender: backup, mediaStreamTrack: backupTrack }]]),
  };
  const publication = { track: screen as typeof screen | undefined };
  const events: string[] = [];
  const detach = (stop = false) => {
    if (stop) {
      primaryTrack.stop();
      backupTrack.stop();
    }
    primary.track = null;
    backup.track = null;
    screen.sender = undefined;
    screen.simulcastCodecs.clear();
    publication.track = undefined;
  };
  const engine = {
    isClosed: false,
    pcManager: { publisher: { pc } },
    negotiate: vi.fn(async () => { events.push('retirement-negotiated'); }),
  };
  const participant = {
    getTrackPublication: vi.fn((source: Track.Source) => source === Track.Source.ScreenShare ? publication : undefined),
    unpublishTrack: vi.fn(async function (track: unknown, stop?: boolean) {
      events.push('sdk-unpublish');
      if (track === screen || track === screen.mediaStreamTrack) detach(stop);
      events.push('sdk-negotiated');
      return publication;
    }),
  };
  const room = { state: 'connected', engine, localParticipant: participant };
  const asRoom = room as unknown as Room;
  return { room, asRoom, participant, engine, pc, screen, primary, backup, primaryTrack, backupTrack, transceivers, publication, detach, events };
}

describe('screen-share encoder retirement', () => {
  it.each([true, false])('retires exact primary and backup senders after SDK unpublish with stop=%s', async (stop) => {
    const f = fixture();
    const original = f.participant.unpublishTrack;
    installScreenShareEncoderLifecycle(f.asRoom);

    const result = await f.participant.unpublishTrack(f.screen, stop);

    expect(result).toBe(f.publication);
    expect(original).toHaveBeenCalledWith(f.screen, stop);
    expect(original.mock.contexts[0]).toBe(f.participant);
    expect(f.transceivers[0]!.stop).toHaveBeenCalledOnce();
    expect(f.transceivers[1]!.stop).toHaveBeenCalledOnce();
    for (const other of f.transceivers.slice(2)) expect(other.stop).not.toHaveBeenCalled();
    expect(f.events).toEqual(['sdk-unpublish', 'sdk-negotiated', 'retirement-negotiated']);
    expect(f.engine.negotiate).toHaveBeenCalledOnce();
  });

  it('matches the primary raw track and installs only once', async () => {
    const f = fixture();
    const raw = f.screen.mediaStreamTrack;
    installScreenShareEncoderLifecycle(f.asRoom);
    const wrapper = f.participant.unpublishTrack;
    installScreenShareEncoderLifecycle(f.asRoom);
    expect(f.participant.unpublishTrack).toBe(wrapper);

    await f.participant.unpublishTrack(raw, true);

    expect(f.transceivers[0]!.stop).toHaveBeenCalledOnce();
    expect(f.engine.negotiate).toHaveBeenCalledOnce();
  });

  it('preserves the primary capture but stops an orphan backup on SDK unpublish(false)', async () => {
    const f = fixture();
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack(f.screen, false);

    expect(f.primaryTrack.stop).not.toHaveBeenCalled();
    expect(f.primaryTrack.readyState).toBe('live');
    expect(f.backupTrack.stop).toHaveBeenCalledOnce();
    expect(f.backupTrack.readyState).toBe('ended');
  });

  it('does not stop a backup twice when SDK unpublish(true) already ended it', async () => {
    const f = fixture();
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack(f.screen, true);

    expect(f.backupTrack.stop).toHaveBeenCalledOnce();
  });

  it.each(['old-map', 'new-map', 'sender'])('preserves a backup still owned by a %s', async (owner) => {
    const f = fixture();
    f.participant.unpublishTrack.mockImplementation(async () => {
      f.detach();
      if (owner === 'old-map') f.screen.simulcastCodecs.set('vp8', { sender: f.backup, mediaStreamTrack: f.backupTrack });
      if (owner === 'new-map') {
        f.publication.track = { ...f.screen, simulcastCodecs: new Map([
          ['vp8', { sender: f.backup, mediaStreamTrack: f.backupTrack }],
        ]) };
      }
      if (owner === 'sender') f.backup.track = f.backupTrack;
      return f.publication;
    });
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack(f.screen, false);

    expect(f.backupTrack.stop).not.toHaveBeenCalled();
    expect(f.primaryTrack.stop).not.toHaveBeenCalled();
    if (owner === 'sender') expect(f.transceivers[1]!.stop).not.toHaveBeenCalled();
  });

  it('waits for SDK teardown before stopping a transceiver or negotiating', async () => {
    const f = fixture();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    f.participant.unpublishTrack.mockImplementation(async () => {
      await gate;
      f.detach();
      return f.publication;
    });
    installScreenShareEncoderLifecycle(f.asRoom);
    const pending = f.participant.unpublishTrack(f.screen, true);
    expect(f.transceivers[0]!.stop).not.toHaveBeenCalled();
    expect(f.engine.negotiate).not.toHaveBeenCalled();

    finish();
    await pending;
    expect(f.transceivers[0]!.stop).toHaveBeenCalledOnce();
  });

  it.each(['camera', 'system-audio', 'unpublished-video'])('leaves %s teardown entirely to the SDK', async (id) => {
    const f = fixture();
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack({ id, kind: id === 'system-audio' ? 'audio' : 'video' }, true);

    for (const value of f.transceivers) expect(value.stop).not.toHaveBeenCalled();
    expect(f.engine.negotiate).not.toHaveBeenCalled();
  });

  it.each(['disconnected', 'reconnecting', 'closed-pc', 'closed-engine', 'replaced-pc', 'replaced-engine'])
  ('does not touch the old publisher after %s', async (change) => {
    const f = fixture();
    f.participant.unpublishTrack.mockImplementation(async () => {
      f.detach();
      if (change === 'disconnected' || change === 'reconnecting') f.room.state = change;
      if (change === 'closed-pc') f.pc.signalingState = 'closed';
      if (change === 'closed-engine') f.engine.isClosed = true;
      if (change === 'replaced-pc') f.engine.pcManager.publisher.pc = { ...f.pc };
      if (change === 'replaced-engine') f.room.engine = { ...f.engine };
      return f.publication;
    });
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack(f.screen, true);

    for (const value of f.transceivers) expect(value.stop).not.toHaveBeenCalled();
    expect(f.engine.negotiate).not.toHaveBeenCalled();
  });

  it('skips rebound, removed, and already stopped transceivers', async () => {
    const f = fixture();
    f.participant.unpublishTrack.mockImplementation(async () => {
      f.detach();
      f.primary.track = { id: 'replacement' } as MediaStreamTrack;
      f.transceivers[1]!.stopped = true;
      return f.publication;
    });
    installScreenShareEncoderLifecycle(f.asRoom);

    await f.participant.unpublishTrack(f.screen, true);

    expect(f.transceivers[0]!.stop).not.toHaveBeenCalled();
    expect(f.transceivers[1]!.stop).not.toHaveBeenCalled();
    expect(f.engine.negotiate).not.toHaveBeenCalled();
  });

  it('skips a transceiver that vanished from the same publisher', async () => {
    const f = fixture();
    f.participant.unpublishTrack.mockImplementation(async () => {
      f.detach();
      f.pc.getTransceivers.mockReturnValue([]);
      return f.publication;
    });
    installScreenShareEncoderLifecycle(f.asRoom);
    await f.participant.unpublishTrack(f.screen, true);
    expect(f.transceivers[0]!.stop).not.toHaveBeenCalled();
    expect(f.engine.negotiate).not.toHaveBeenCalled();
  });

  it('preserves an SDK rejection while retiring senders it already detached', async () => {
    const f = fixture();
    const failure = new Error('SDK negotiation failed');
    f.participant.unpublishTrack.mockImplementation(async () => { f.detach(); throw failure; });
    installScreenShareEncoderLifecycle(f.asRoom);

    await expect(f.participant.unpublishTrack(f.screen, true)).rejects.toBe(failure);

    expect(f.transceivers[0]!.stop).toHaveBeenCalledOnce();
    expect(f.engine.negotiate).toHaveBeenCalledOnce();
  });

  it('preserves an SDK success if the retirement negotiation fails', async () => {
    const f = fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.engine.negotiate.mockRejectedValueOnce(new Error('connection closing'));
    installScreenShareEncoderLifecycle(f.asRoom);
    try {
      await expect(f.participant.unpublishTrack(f.screen, true)).resolves.toBe(f.publication);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps native unpublish when SDK internals are unsupported and can install later', () => {
    const f = fixture();
    const original = f.participant.unpublishTrack;
    const negotiate = f.engine.negotiate;
    Object.assign(f.engine, { negotiate: undefined });
    installScreenShareEncoderLifecycle(f.asRoom);
    expect(f.participant.unpublishTrack).toBe(original);

    f.engine.negotiate = negotiate;
    installScreenShareEncoderLifecycle(f.asRoom);
    expect(f.participant.unpublishTrack).not.toBe(original);
  });
});
