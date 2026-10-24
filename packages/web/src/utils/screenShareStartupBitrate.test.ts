import { describe, expect, it, vi } from 'vitest';
import { ParticipantEvent, Track, type Room } from 'livekit-client';
import { installScreenShareStartupBitrate, withScreenShareStartupBitrate } from './screenShareStartupBitrate';

function sender(bitrates = [3_500_000, 7_000_000, 14_000_000]) {
  return {
    track: { id: 'screen', readyState: 'live' },
    getParameters: vi.fn(() => ({ encodings: bitrates.map(maxBitrate => ({ maxBitrate })) })),
  } as unknown as RTCRtpSender;
}

function section(mid: string, payloads = [117, 119], direction = 'recvonly') {
  return [
    `m=video 9 UDP/TLS/RTP/SAVPF ${payloads.join(' ')}`, `a=mid:${mid}`, `a=${direction}`,
    ...payloads.flatMap(payload => [
      `a=rtpmap:${payload} H264/90000`,
      `a=fmtp:${payload} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${payload === 117 ? '4d001f' : '640020'}`,
    ]),
  ].join('\r\n') + '\r\n';
}

const answer = (sdp = section('screen', [119])): RTCSessionDescriptionInit => ({
  type: 'answer', sdp: 'v=0\r\na=group:BUNDLE camera screen placeholder\r\n' + sdp,
});
const screen = (trackSender = sender()) => ({ sender: trackSender, mid: 'screen', codec: 'h264' });

describe('screen-share startup bitrate', () => {
  it('seeds the negotiated High profile when the offered Main profile was not selected', () => {
    const original = answer();
    const patched = withScreenShareStartupBitrate(original, [screen()]);
    expect(patched.sdp).toContain('profile-level-id=640020;x-google-start-bitrate=22050');
    expect(patched.sdp).not.toContain('profile-level-id=4d');
    expect(original.sdp).not.toContain('x-google');
    expect(patched.type).toBe('answer');
  });

  it('keeps fmtp consistent across shared BUNDLE payloads without changing profiles, limits or other codecs', () => {
    const sdp = section('camera', [117, 119]) + section('screen') + section('placeholder', [119], 'inactive')
      + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:audio\r\na=rtpmap:111 opus/48000/2\r\n'
      + 'a=fmtp:111 minptime=10;useinbandfec=1\r\n';
    const patched = withScreenShareStartupBitrate(answer(sdp), [screen()]);
    expect(patched.sdp?.match(/x-google-start-bitrate=22050/g)).toHaveLength(5);
    expect(patched.sdp?.match(/profile-level-id=640020/g)).toHaveLength(3);
    expect(patched.sdp).toContain('a=fmtp:111 minptime=10;useinbandfec=1\r\n');
    expect(patched.sdp).not.toMatch(/x-google-(?:min|max)-bitrate/);
  });

  it('does not change a camera outside the screen BUNDLE group or an unrelated video payload', () => {
    const original = answer(section('camera', [117, 119]) + section('screen', [119])) ;
    original.sdp = original.sdp!.replace('BUNDLE camera screen placeholder', 'BUNDLE screen');
    const patched = withScreenShareStartupBitrate(original, [screen()]);
    expect(patched.sdp?.match(/x-google-start-bitrate/g)).toHaveLength(1);
    expect(patched.sdp).toContain(section('camera', [117, 119]));
  });

  it('replaces stale hints once and derives single-layer VP9 from its own cap', () => {
    const original = answer(section('screen', [119]).replace('640020', '640020;x-google-start-bitrate=900'));
    const patched = withScreenShareStartupBitrate(original, [screen()]);
    expect(patched.sdp?.match(/x-google-start-bitrate/g)).toHaveLength(1);
    expect(patched.sdp).toContain('x-google-start-bitrate=22050');
    const vp9 = answer('m=video 9 UDP/TLS/RTP/SAVPF 98\r\na=mid:screen\r\na=recvonly\r\na=rtpmap:98 VP9/90000\r\n');
    expect(withScreenShareStartupBitrate(vp9, [{ ...screen(sender([8_000_000])), codec: 'vp9' }]).sdp)
      .toContain('a=fmtp:98 x-google-start-bitrate=7200\r\n');
  });

  it('ignores offers, rejected or inactive sections, ended senders, missing mids and unbounded encodings', () => {
    const ended = sender();
    Object.assign(ended, { track: null });
    const cases: Array<[RTCSessionDescriptionInit, ReturnType<typeof screen>]> = [
      [{ ...answer(), type: 'offer' }, screen()],
      [answer(section('screen').replace('video 9', 'video 0')), screen()],
      [answer(section('screen', [119], 'inactive')), screen()],
      [answer(section('screen', [119], 'sendonly')), screen()],
      [answer(), screen(ended)],
      [answer(), { ...screen(), mid: 'different' }],
      [answer(), screen(sender([NaN, 0, -100, Infinity]))],
    ];
    for (const [description, current] of cases) expect(withScreenShareStartupBitrate(description, [current])).toBe(description);
  });
});

function fixture() {
  type SenderListener = (sender: RTCRtpSender, track: { source: Track.Source; kind: Track.Kind; codec: string }) => void;
  const listeners = new Map<string, SenderListener>();
  const primary = sender();
  const pc = () => ({
    getTransceivers: vi.fn(() => [{ sender: primary, mid: 'screen' }]),
    setRemoteDescription: vi.fn<RTCPeerConnection['setRemoteDescription']>().mockResolvedValue(undefined),
  });
  const first = pc();
  const publisher = { pc: first };
  const participant = { on: vi.fn((event, callback) => { listeners.set(event, callback); }) };
  const room = { localParticipant: participant, engine: { pcManager: { publisher } } } as unknown as Room;
  const created = (source = Track.Source.ScreenShare, codec = 'h264') => listeners.get(ParticipantEvent.LocalSenderCreated)!(
    primary, { source, kind: Track.Kind.Video, codec },
  );
  return { room, first, primary, publisher, participant, created, pc };
}

describe('startup hint lifecycle', () => {
  it('applies before the first answer, follows a full reconnect, and does not reseed ordinary renegotiations', async () => {
    const f = fixture();
    const original = f.first.setRemoteDescription;
    installScreenShareStartupBitrate(f.room);
    installScreenShareStartupBitrate(f.room);
    expect(f.participant.on).toHaveBeenCalledOnce();
    f.created(Track.Source.Camera);
    expect(f.first.setRemoteDescription).toBe(original);
    f.created();
    const hook = f.first.setRemoteDescription;
    f.created();
    expect(f.first.setRemoteDescription).toBe(hook);
    await f.first.setRemoteDescription(answer());
    expect(original.mock.calls[0]![0].sdp).toContain('x-google-start-bitrate=22050');
    const ordinary = answer();
    await f.first.setRemoteDescription(ordinary);
    expect(original.mock.calls[1]![0]).toBe(ordinary);

    f.publisher.pc = f.pc();
    const reconnectOriginal = f.publisher.pc.setRemoteDescription;
    f.created();
    await f.publisher.pc.setRemoteDescription(answer());
    expect(reconnectOriginal.mock.calls[0]![0].sdp).toContain('x-google-start-bitrate=22050');
  });

  it('preserves negotiation on rejected hints and preserves original failures', async () => {
    const f = fixture();
    const original = f.first.setRemoteDescription;
    original.mockRejectedValueOnce(new DOMException('hint rejected', 'OperationError'));
    installScreenShareStartupBitrate(f.room);
    f.created();
    const description = answer();
    await f.first.setRemoteDescription(description);
    expect(original.mock.calls[1]![0]).toBe(description);
    const failure = new Error('original failure');
    original.mockRejectedValueOnce(failure);
    await expect(f.first.setRemoteDescription(description)).rejects.toBe(failure);
  });

  it('waits for a matching MID and reads the current caps rather than capturing stale settings', async () => {
    const f = fixture();
    const original = f.first.setRemoteDescription;
    f.first.getTransceivers.mockReturnValueOnce([]);
    installScreenShareStartupBitrate(f.room);
    f.created();
    await f.first.setRemoteDescription(answer());
    expect(original.mock.calls[0]![0].sdp).not.toContain('x-google-start-bitrate');
    vi.mocked(f.primary.getParameters).mockReturnValue({ encodings: [{ maxBitrate: 4_000_000 }] } as RTCRtpSendParameters);
    await f.first.setRemoteDescription(answer());
    expect(original.mock.calls[1]![0].sdp).toContain('x-google-start-bitrate=3600');
  });
});
