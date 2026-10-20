import { TrackEvent, type RemoteTrackPublication, type RemoteVideoTrack, type Room, type Track } from 'livekit-client';

/**
 * LiveKit 2.x's adaptive dimension request wins over an explicit quality cap.
 * Equal-resolution encodings therefore need quality requests instead. Remove
 * only that dimension listener; the SDK still pauses invisible/background
 * video through its independent visibility listener. Keep this SDK-specific
 * bridge here with the other guarded compatibility accessors.
 */
export function controlScreenShareDimensions(
  publication: RemoteTrackPublication,
  track: RemoteVideoTrack,
): ((restore: boolean) => void) | null {
  const internals = publication as unknown as {
    handleVideoDimensionsChange?: (dimensions: Track.Dimensions) => void;
    videoDimensionsAdaptiveStream?: Track.Dimensions;
  };
  const handler = internals.handleVideoDimensionsChange;
  if (typeof handler !== 'function' || publication.track !== track) return null;
  let latestDimensions = internals.videoDimensionsAdaptiveStream;
  const remember = (dimensions: Track.Dimensions) => { latestDimensions = dimensions; };
  track.off(TrackEvent.VideoDimensionsChanged, handler);
  track.on(TrackEvent.VideoDimensionsChanged, remember);
  internals.videoDimensionsAdaptiveStream = undefined;
  let disposed = false;
  return (restore) => {
    if (disposed) return;
    disposed = true;
    track.off(TrackEvent.VideoDimensionsChanged, remember);
    // setTrack emits Unsubscribed before replacing publication.track. Its
    // teardown already removed handler: restoring then would leak it.
    if (restore && publication.track === track) {
      track.on(TrackEvent.VideoDimensionsChanged, handler);
      internals.videoDimensionsAdaptiveStream = latestDimensions;
    }
  };
}

/**
 * Discover all unique RTCPeerConnections from the LiveKit Room engine.
 * Different livekit-client versions expose the PC at different internal paths.
 */
export function discoverPeerConnections(room: Room): RTCPeerConnection[] {
  const engine = (room as any)?.engine;
  if (!engine) return [];

  const pcs: RTCPeerConnection[] = [];
  const seen = new WeakSet<object>();

  const tryAdd = (val: any) => {
    if (val && typeof val.getStats === 'function' && !seen.has(val)) {
      seen.add(val);
      pcs.push(val);
    }
  };

  // Current livekit-client (1.x+): engine.pcManager.{publisher,subscriber}.pc
  tryAdd(engine.pcManager?.publisher?.pc);
  tryAdd(engine.pcManager?.subscriber?.pc);
  // Private backing field fallback
  tryAdd(engine.pcManager?.publisher?._pc);
  tryAdd(engine.pcManager?.subscriber?._pc);
  // Older livekit-client paths
  tryAdd(engine.publisher?.pc);
  tryAdd(engine.subscriber?.pc);
  // Unified-plan single PC
  tryAdd(engine.pc);
  tryAdd((room as any).pc);

  return pcs;
}

/**
 * Get the publisher RTCPeerConnection from a LiveKit Room.
 * Used by overdrive to inject RTP sender parameters.
 */
export function getPublisherPC(room: Room): RTCPeerConnection | null {
  const engine = (room as any)?.engine;
  if (!engine) return null;

  return (
    engine.pcManager?.publisher?.pc ??
    engine.pcManager?.publisher?._pc ??
    engine.publisher?.pc ??
    engine.pc ??
    null
  );
}

/**
 * Safely extract the underlying MediaStreamTrack from a LiveKit track object.
 * Handles both public `.mediaStreamTrack` and private `._mediaStreamTrack`.
 */
export function getMediaStreamTrack(track: unknown): MediaStreamTrack | null {
  if (!track) return null;
  const t = track as any;
  return t.mediaStreamTrack ?? t._mediaStreamTrack ?? null;
}
