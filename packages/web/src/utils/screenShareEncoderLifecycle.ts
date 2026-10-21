import { Track, type Room } from 'livekit-client';
import { getPublisherPC } from './livekitInternals';

type Participant = Room['localParticipant'];
type Engine = { isClosed?: boolean; negotiate?: () => Promise<void> };
type ScreenTrack = {
  mediaStreamTrack?: MediaStreamTrack;
  sender?: RTCRtpSender;
  simulcastCodecs?: Map<string, { sender?: RTCRtpSender; mediaStreamTrack?: MediaStreamTrack }>;
};
type Retirement = {
  engine: Engine;
  pc: RTCPeerConnection;
  screen: ScreenTrack;
  backupTracks: MediaStreamTrack[];
  transceivers: Array<{ transceiver: RTCRtpTransceiver; sender: RTCRtpSender }>;
};

const installed = new WeakMap<Participant, Room>();

function getEngine(room: Room): Engine | undefined {
  return (room as unknown as { engine?: Engine }).engine;
}

function isCurrentPublisher(room: Room, engine: Engine, pc: RTCPeerConnection): boolean {
  return getEngine(room) === engine && !engine.isClosed
    && room.state !== 'disconnected' && room.state !== 'reconnecting'
    && getPublisherPC(room) === pc
    && pc.connectionState !== 'closed' && pc.signalingState !== 'closed';
}

function captureRetirement(room: Room, track: Parameters<Participant['unpublishTrack']>[0]): Retirement | null {
  const engine = getEngine(room);
  const pc = getPublisherPC(room);
  if (typeof engine?.negotiate !== 'function' || typeof pc?.getTransceivers !== 'function') return null;
  if (!isCurrentPublisher(room, engine, pc)) return null;
  const screen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as ScreenTrack | undefined;
  // Match the publication itself or its primary raw track. A null sender alone
  // cannot identify a retired screen share: LiveKit also creates recvonly slots.
  if (!screen || (screen !== track && screen.mediaStreamTrack !== track)) return null;
  const senders = new Set<RTCRtpSender>();
  const backupTracks = new Set<MediaStreamTrack>();
  if (screen.sender) senders.add(screen.sender);
  for (const backup of screen.simulcastCodecs?.values() ?? []) {
    if (backup.sender) senders.add(backup.sender);
    if (backup.mediaStreamTrack?.kind === 'video' && backup.mediaStreamTrack !== screen.mediaStreamTrack) {
      backupTracks.add(backup.mediaStreamTrack);
    }
  }
  const transceivers = pc.getTransceivers()
    .filter(({ sender }) => senders.has(sender))
    .map((transceiver) => ({ transceiver, sender: transceiver.sender }));
  return transceivers.length || backupTracks.size
    ? { engine, pc, screen, backupTracks: [...backupTracks], transceivers } : null;
}

async function retireEncoders(room: Room, retirement: Retirement | null): Promise<void> {
  if (!retirement) return;
  try {
    const { engine, pc, screen, backupTracks, transceivers } = retirement;
    if (!isCurrentPublisher(room, engine, pc)) return;
    const current = new Set(pc.getTransceivers());
    const nextScreen = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track as ScreenTrack | undefined;
    const ownedBackups = new Set([screen, nextScreen].flatMap((owner) =>
      [...owner?.simulcastCodecs?.values() ?? []].map((backup) => backup.mediaStreamTrack)));
    for (const backup of backupTracks) {
      // SDK unpublish(false) preserves the primary for republish, but clears
      // its backup map. Stop only the clones that lost both SDK/sender owners.
      if (backup.readyState === 'live' && !ownedBackups.has(backup)
        && ![...current].some(({ sender }) => sender.track === backup)) backup.stop();
    }
    let stopped = false;
    for (const { transceiver, sender } of transceivers) {
      // Unpublish can overlap a reconnect or another sender operation. Never
      // stop a replacement, rebound sender, or already stopped transceiver.
      if (!current.has(transceiver) || transceiver.sender !== sender || sender.track
        || (transceiver as RTCRtpTransceiver & { stopped?: boolean }).stopped
        || transceiver.currentDirection === 'stopped' || transceiver.direction === 'stopped'
        || typeof transceiver.stop !== 'function') continue;
      try {
        transceiver.stop();
        stopped = true;
      } catch {
        // A concurrent close or an older WebRTC implementation is harmless.
      }
    }
    if (stopped && isCurrentPublisher(room, engine, pc)) {
      // removeTrack only detaches the source. Rejecting the stopped m-line in
      // an SDK negotiation deletes its media channel and releases the encoder.
      await engine.negotiate!();
    }
  } catch (error) {
    console.warn('[ScreenShare] Could not retire the unpublished video encoders:', error);
  }
}

/**
 * LiveKit 2.22.3 leaves unpublished transceivers inactive and creates fresh ones
 * on the next publish. Chromium can retain their idle hardware encoders. Wrap
 * this participant instance so explicit stops, OS stops, and SDK republishes
 * retire only the exact primary/backup screen senders being unpublished.
 */
export function installScreenShareEncoderLifecycle(room: Room): void {
  const participant = room.localParticipant;
  if (installed.has(participant)) return;
  try {
    const engine = getEngine(room);
    const pc = getPublisherPC(room);
    if (typeof engine?.negotiate !== 'function' || typeof pc?.getTransceivers !== 'function'
      || typeof participant.unpublishTrack !== 'function') return;
    const original = participant.unpublishTrack;
    participant.unpublishTrack = async function (this: Participant, ...args) {
      let retirement: Retirement | null = null;
      try {
        if (this === participant) retirement = captureRetirement(room, args[0]);
      } catch {
        // Missing or changed SDK internals must leave normal unpublish usable.
      }
      try {
        return await original.apply(this, args);
      } finally {
        // SDK teardown first: it writes direction=inactive and clears senders.
        // Stopping before that would make the SDK's direction write throw.
        await retireEncoders(room, retirement);
      }
    };
    installed.set(participant, room);
  } catch {
    // Unsupported/readonly SDK instances keep their native lifecycle.
  }
}
