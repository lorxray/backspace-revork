import { ParticipantEvent, Track, type Room } from '../../../web/node_modules/livekit-client/src';
import PCTransport from '../../../web/node_modules/livekit-client/src/room/PCTransport';
import { activate, deactivate } from '../../../web/src/utils/hwOverdrive';
import { installScreenShareStartupBitrate } from '../../../web/src/utils/screenShareStartupBitrate';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function check(fixed: boolean, codec: 'h264' | 'vp9' = 'h264') {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  document.body.append(canvas);
  const context = canvas.getContext('2d')!;
  let frame = 0;
  const draw = setInterval(() => {
    context.fillStyle = `hsl(${frame++ * 13 % 360} 80% 50%)`;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 33);
  const track = canvas.captureStream(30).getVideoTracks()[0]!;
  const publisher = new PCTransport();
  const receiver = new RTCPeerConnection();
  let onSender: ((sender: RTCRtpSender, track: unknown) => void) | undefined;
  const room = {
    localParticipant: { on: (event: string, callback: typeof onSender) => {
      if (event === ParticipantEvent.LocalSenderCreated) onSender = callback;
    } },
    engine: { pcManager: { publisher } },
  } as unknown as Room;
  if (fixed) installScreenShareStartupBitrate(room);
  publisher.onIceCandidate = candidate => { void receiver.addIceCandidate(candidate).catch(() => {}); };
  receiver.onicecandidate = event => { if (event.candidate) void publisher.addIceCandidate(event.candidate); };
  const encodings = codec === 'h264' ? [
    { rid: 'q', maxBitrate: 3_500_000, scaleResolutionDownBy: 1 },
    { rid: 'h', maxBitrate: 7_000_000, scaleResolutionDownBy: 1 },
    { rid: 'f', maxBitrate: 14_000_000, scaleResolutionDownBy: 1 },
  ] : [{ maxBitrate: 14_000_000 }];
  try {
    const transceiver = publisher.addTransceiver(track, { direction: 'sendonly', sendEncodings: encodings });
    onSender?.(transceiver.sender, { codec, source: Track.Source.ScreenShare, kind: Track.Kind.Video });
    publisher.setTrackCodecBitrate({ cid: track.id, codec, maxbr: encodings.reduce((sum, e) => sum + e.maxBitrate, 0) / 1000, isScreenShare: true });
    if (codec === 'h264') activate(track.id);
    let offer: RTCSessionDescriptionInit | undefined;
    publisher.onOffer = description => { offer = description; };
    await publisher.createAndSendOffer();
    deactivate();
    assert(offer, 'SDK must create a real offer');
    await receiver.setRemoteDescription(offer);
    const capabilities = RTCRtpReceiver.getCapabilities('video')!.codecs;
    const selected = capabilities.filter(entry => codec === 'h264'
      ? /h264/i.test(entry.mimeType) && /profile-level-id=64/i.test(entry.sdpFmtpLine ?? '')
        && /packetization-mode=1/i.test(entry.sdpFmtpLine ?? '')
      : /vp9/i.test(entry.mimeType));
    assert(selected.length, 'The shipped Chromium must expose the requested codec');
    receiver.getTransceivers()[0]!.setCodecPreferences(selected);
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    // Browser answers omit x-google-start-bitrate, just as an SFU is allowed to.
    assert(!answer.sdp?.includes('x-google-start-bitrate'), 'Fixture must exercise an answer without the hint');
    await publisher.setRemoteDescription(answer, 1);
    const selectedCodec = transceiver.sender.getParameters().codecs[0]!;
    assert(codec !== 'h264' || selectedCodec.sdpFmtpLine?.includes('profile-level-id=64'), 'Negotiate actual H.264 High');
    const expected = fixed ? codec === 'h264' ? 22_050_000 : 12_600_000 : 300_000;
    let estimate: number | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      const stats = await transceiver.sender.getStats();
      for (const entry of stats.values()) {
        if (entry.type === 'candidate-pair' && entry.state === 'succeeded') estimate = entry.availableOutgoingBitrate;
      }
      if (estimate !== undefined) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(estimate !== undefined && Math.abs(estimate - expected) < expected * 0.15,
      `Expected startup BWE near ${expected}, got ${estimate}`);
    assert(Boolean(selectedCodec.sdpFmtpLine?.includes('x-google-start-bitrate')) === fixed, 'Hint must reach the negotiated sender');
    return { fixed, codec, startupEstimate: estimate, fmtp: selectedCodec.sdpFmtpLine };
  } finally {
    deactivate();
    clearInterval(draw);
    publisher.close();
    receiver.close();
    track.stop();
    canvas.remove();
  }
}

Object.assign(window, {
  testScreenShareStartup: async () => ({
    baseline: await check(false),
    fixed: await check(true),
    repeatedStart: await check(true),
    vp9: await check(true, 'vp9'),
  }),
});
