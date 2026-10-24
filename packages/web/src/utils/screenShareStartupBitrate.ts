import { ParticipantEvent, Track, type LocalVideoTrack, type Room } from 'livekit-client';
import { getPublisherPC } from './livekitInternals';

type ScreenSender = { sender: RTCRtpSender; codec: string; mid: string | null };
const installedParticipants = new WeakSet<Room['localParticipant']>();
const installedConnections = new WeakMap<RTCPeerConnection, Map<RTCRtpSender, string>>();

/**
 * LiveKit 2.22.3 adds x-google-start-bitrate to only the first codec payload.
 * H.264 profiles have distinct payloads: an SFU answering High instead of Main
 * loses that hint and Chromium starts near 300 kbps even on a fast connection.
 * A server may also omit the hint from its answer. Chromium reads the sending
 * bitrate from that answer, so seed the negotiated screen codec there, once
 * per new sender. Keep codec profiles and the server's other parameters intact.
 */
export function withScreenShareStartupBitrate(
  answer: RTCSessionDescriptionInit,
  screens: ScreenSender[],
): RTCSessionDescriptionInit {
  if (answer.type !== 'answer' || !answer.sdp || !screens.length) return answer;
  const newline = answer.sdp.includes('\r\n') ? '\r\n' : '\n';
  const sections = answer.sdp.split(/(?=^m=)/m).map(section => section.split(/\r?\n/));
  const targets = new Map<number, Map<string, number>>();
  for (const { sender, codec, mid } of screens) {
    if (!sender.track || sender.track.readyState === 'ended' || mid === null) continue;
    const index = sections.findIndex(lines => /^m=video (?!0(?: |$))/.test(lines[0] ?? '')
      && !lines.includes('a=inactive') && !lines.includes('a=sendonly')
      && lines.includes(`a=mid:${mid}`));
    if (index < 0) continue;
    const encodings = sender.getParameters().encodings;
    // Simulcast copies share one bandwidth estimate, so hint their total,
    // including paused copies that dynacast may resume for a new subscriber.
    const total = encodings.reduce((sum, encoding) => sum + (
      Number.isFinite(encoding.maxBitrate) && encoding.maxBitrate! > 0 ? encoding.maxBitrate! : 0
    ), 0);
    const kbps = Math.round(total * 0.9 / 1000);
    if (kbps <= 0) continue;
    const payloads = targets.get(index) ?? new Map<string, number>();
    for (const line of sections[index]!) {
      const match = /^a=rtpmap:(\d+) ([^/]+)\//i.exec(line);
      if (match?.[2]!.toLowerCase() === codec.toLowerCase()) payloads.set(match[1]!, kbps);
    }
    targets.set(index, payloads);
  }
  if (!targets.size) return answer;

  // A payload shared by BUNDLE sections must have matching fmtp. This also
  // covers camera/recvonly slots and prevents SDK fallback to unmodified SDP.
  const bundles = sections[0]!.flatMap(line => {
    const match = /^a=group:BUNDLE (.+)$/.exec(line);
    return match ? [new Set(match[1]!.trim().split(/\s+/))] : [];
  });
  const mid = (lines: string[]) => lines.find(line => line.startsWith('a=mid:'))?.slice(6);
  for (const bundle of bundles) {
    const indices = sections.flatMap((lines, index) => bundle.has(mid(lines) ?? '') ? [index] : []);
    const shared = new Map<string, number>();
    for (const index of indices) {
      for (const [payload, kbps] of targets.get(index) ?? []) {
        shared.set(payload, Math.max(shared.get(payload) ?? 0, kbps));
      }
    }
    for (const index of indices) {
      const lines = sections[index]!;
      if (!/^m=video /.test(lines[0] ?? '')) continue;
      for (const [payload, kbps] of shared) {
        if (!lines.some(line => line.startsWith(`a=rtpmap:${payload} `))) continue;
        const payloads = targets.get(index) ?? new Map<string, number>();
        payloads.set(payload, kbps);
        targets.set(index, payloads);
      }
    }
  }
  for (const [index, payloads] of targets) {
    const lines = sections[index]!;
    for (const [payload, kbps] of payloads) {
      const prefix = `a=fmtp:${payload} `;
      const fmtpIndex = lines.findIndex(line => line.startsWith(prefix));
      const parameters = fmtpIndex >= 0 ? lines[fmtpIndex]!.slice(prefix.length).split(';')
        .map(parameter => parameter.trim()).filter(parameter => parameter && !/^x-google-start-bitrate\s*=/i.test(parameter)) : [];
      parameters.push(`x-google-start-bitrate=${kbps}`);
      const line = prefix + parameters.join(';');
      if (fmtpIndex >= 0) lines[fmtpIndex] = line;
      else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
    }
  }
  return { ...answer, sdp: sections.map(lines => lines.join(newline)).join('') };
}

/** Follow SDK sender creation, including its automatic full-reconnect republish. */
export function installScreenShareStartupBitrate(room: Room): void {
  const participant = room.localParticipant;
  if (installedParticipants.has(participant) || typeof participant.on !== 'function') return;
  participant.on(ParticipantEvent.LocalSenderCreated, (sender, track) => {
    if (track.source !== Track.Source.ScreenShare || track.kind !== Track.Kind.Video) return;
    const pc = getPublisherPC(room);
    if (!pc || typeof pc.setRemoteDescription !== 'function' || typeof pc.getTransceivers !== 'function') return;
    let screens = installedConnections.get(pc);
    if (!screens) {
      screens = new Map();
      const registered = screens;
      const original = pc.setRemoteDescription;
      pc.setRemoteDescription = async function (this: RTCPeerConnection, ...args: unknown[]) {
        const description = args[0] as RTCSessionDescriptionInit;
        let patched = description;
        const matched: RTCRtpSender[] = [];
        try {
          if (this === pc && description.type === 'answer') {
            const screens: ScreenSender[] = [];
            for (const [sender, codec] of registered) {
              if (!sender.track || sender.track.readyState === 'ended') { registered.delete(sender); continue; }
              const mid = pc.getTransceivers().find(transceiver => transceiver.sender === sender)?.mid ?? null;
              screens.push({ sender, codec, mid });
              if (mid !== null) matched.push(sender);
            }
            patched = withScreenShareStartupBitrate(description, screens);
          }
        } catch {
          // Optional startup hints must not interrupt normal SDK negotiation.
        }
        try {
          await Reflect.apply(original, this, [patched, ...args.slice(1)]);
        } catch (error) {
          if (patched === description) throw error;
          // Retain the SDK's original path if a browser rejects this hint.
          await Reflect.apply(original, this, args);
        }
        for (const sender of matched) registered.delete(sender);
      } as typeof pc.setRemoteDescription;
      installedConnections.set(pc, screens);
    }
    const codec = (track as LocalVideoTrack).codec;
    if (codec) screens.set(sender, codec);
  });
  installedParticipants.add(participant);
}
