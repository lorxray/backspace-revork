import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activate, deactivate, isActive } from './hwOverdrive';

type Codec = RTCRtpCapabilities['codecs'][number];

const main: Codec = Object.freeze({ mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'packetization-mode=1;profile-level-id=4d001f' });
const high: Codec = Object.freeze({ mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'profile-level-id=640c1f;packetization-mode=1' });
const baseline: Codec = Object.freeze({ mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' });
const mainModeZero: Codec = Object.freeze({ mimeType: 'video/H264', clockRate: 90_000, sdpFmtpLine: 'packetization-mode=0;profile-level-id=4d001f' });
const vp9: Codec = Object.freeze({ mimeType: 'video/VP9', clockRate: 90_000, sdpFmtpLine: 'profile-id=0' });
const rtx: Codec = Object.freeze({ mimeType: 'video/rtx', clockRate: 90_000 });
const offer = Object.freeze({ type: 'offer' as const, sdp: 'a=fmtp:102 packetization-mode=1;profile-level-id=42e01f\r\na=fmtp:104 profile-level-id=42c01f\r\n' });
const originalCreateOffer = vi.fn(function (this: RTCPeerConnection, ..._args: unknown[]) {
  void _args;
  return Promise.resolve(offer);
});
const getCapabilities = vi.fn<() => RTCRtpCapabilities | null>();

class FakePeerConnection {
  constructor(readonly transceivers: RTCRtpTransceiver[] = []) {}
  getTransceivers = vi.fn(() => this.transceivers);
  createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    void _options;
    return Promise.resolve(offer);
  }
}

function makeTransceiver(id = 'screen', encodings: RTCRtpEncodingParameters[] = [{ rid: 'f', maxBitrate: 18_000_000 }]) {
  const parameters: RTCRtpSendParameters = {
    transactionId: 'transaction', codecs: [], headerExtensions: [], rtcp: {}, encodings,
  };
  const sender = {
    track: { id, kind: 'video' } as MediaStreamTrack,
    getParameters: vi.fn(() => parameters),
    setParameters: vi.fn<RTCRtpSender['setParameters']>().mockResolvedValue(undefined),
  };
  const setCodecPreferences = vi.fn<RTCRtpTransceiver['setCodecPreferences']>();
  const transceiver = { sender, setCodecPreferences } as unknown as RTCRtpTransceiver;
  return { transceiver, sender, setCodecPreferences, parameters };
}

function makePeer(...transceivers: RTCRtpTransceiver[]): RTCPeerConnection {
  return new FakePeerConnection(transceivers) as unknown as RTCPeerConnection;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakePeerConnection.prototype.createOffer = originalCreateOffer;
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('RTCRtpSender', { getCapabilities });
  getCapabilities.mockReturnValue({ codecs: [vp9, baseline, rtx, high, mainModeZero, main], headerExtensions: [] });
});

afterEach(() => {
  deactivate();
  vi.unstubAllGlobals();
});

describe('H264 screen sender preparation', () => {
  it('prefers real Main then High capabilities and keeps every codec and SDP unchanged', async () => {
    const screen = makeTransceiver();
    const camera = makeTransceiver('camera');
    const originalCodecs = getCapabilities()!.codecs;
    const peer = makePeer(camera.transceiver, screen.transceiver);
    activate('screen');

    const result = await peer.createOffer({ iceRestart: true });

    expect(screen.setCodecPreferences).toHaveBeenCalledWith([main, high, baseline, mainModeZero, vp9, rtx]);
    const selectedCodecs = screen.setCodecPreferences.mock.calls[0]![0];
    for (const codec of selectedCodecs) expect(originalCodecs).toContain(codec);
    expect(getCapabilities()!.codecs).toBe(originalCodecs);
    expect(originalCodecs).toEqual([vp9, baseline, rtx, high, mainModeZero, main]);
    expect(camera.setCodecPreferences).not.toHaveBeenCalled();
    expect(camera.sender.getParameters).not.toHaveBeenCalled();
    expect(result).toBe(offer);
    expect(result.sdp).toContain('profile-level-id=42e01f');
    expect(result.sdp).toContain('profile-level-id=42c01f');
    expect(result.sdp).not.toContain('4d0032');
    expect(originalCreateOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(originalCreateOffer.mock.contexts[0]).toBe(peer);
  });

  it('does not manufacture a Main or High profile when only Baseline is supported', async () => {
    getCapabilities.mockReturnValue({ codecs: [baseline, rtx], headerExtensions: [] });
    const screen = makeTransceiver();
    activate('screen');
    await makePeer(screen.transceiver).createOffer();
    expect(screen.setCodecPreferences).toHaveBeenCalledWith([baseline, rtx]);
  });

  it('forwards legacy offer callbacks and options on unrelated peer connections', async () => {
    const peer = makePeer();
    const success = vi.fn();
    const failure = vi.fn();
    const options = { iceRestart: true };
    activate('screen');
    await peer.createOffer(success, failure, options);
    expect(originalCreateOffer).toHaveBeenCalledWith(success, failure, options);
    expect(getCapabilities).not.toHaveBeenCalled();
  });

  it('awaits one temporal layer on all copies before offering without changing their caps or paused state', async () => {
    const encodings = [
      { rid: 'q', active: false, maxBitrate: 4_500_000, maxFramerate: 60, scaleResolutionDownBy: 1, scalabilityMode: 'L1T3' },
      { rid: 'h', active: true, maxBitrate: 9_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
      { rid: 'f', active: true, maxBitrate: 18_000_000, maxFramerate: 60, scaleResolutionDownBy: 1 },
    ];
    const screen = makeTransceiver('screen', encodings);
    let finishWrite!: () => void;
    screen.sender.setParameters.mockImplementation(() => new Promise<void>((resolve) => { finishWrite = resolve; }));
    activate('screen');
    const pendingOffer = makePeer(screen.transceiver).createOffer();

    expect(screen.sender.setParameters).toHaveBeenCalledWith({
      ...screen.parameters, encodings: encodings.map((encoding) => ({ ...encoding, scalabilityMode: 'L1T1' })),
    });
    expect(originalCreateOffer).not.toHaveBeenCalled();
    finishWrite();
    expect(await pendingOffer).toBe(offer);
    expect(originalCreateOffer).toHaveBeenCalledOnce();
  });

  it('does not touch other peer connections, camera tracks or a VP9-only target', async () => {
    const camera = makeTransceiver('camera');
    activate('screen');
    await makePeer(camera.transceiver).createOffer();
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(camera.sender.getParameters).not.toHaveBeenCalled();
    getCapabilities.mockReturnValue({ codecs: [vp9, rtx], headerExtensions: [] });
    const vp9Screen = makeTransceiver();
    await makePeer(vp9Screen.transceiver).createOffer();
    expect(vp9Screen.setCodecPreferences).not.toHaveBeenCalled();
    expect(vp9Screen.sender.getParameters).not.toHaveBeenCalled();
    expect(originalCreateOffer).toHaveBeenCalledTimes(2);
  });

  it('keeps normal negotiation when codec preferences are rejected', async () => {
    const screen = makeTransceiver();
    screen.setCodecPreferences.mockImplementation(() => { throw new DOMException('unsupported codec', 'InvalidModificationError'); });
    activate('screen');
    expect(await makePeer(screen.transceiver).createOffer()).toBe(offer);
    expect(screen.sender.setParameters).toHaveBeenCalledOnce();
  });

  it('keeps normal negotiation when temporal layer parameters are rejected', async () => {
    const screen = makeTransceiver();
    screen.sender.setParameters.mockRejectedValue(new DOMException('not supported yet', 'InvalidStateError'));
    activate('screen');
    expect(await makePeer(screen.transceiver).createOffer()).toBe(offer);
    expect(originalCreateOffer).toHaveBeenCalledOnce();
  });

  it('handles browsers without capability, preference or sender parameter APIs', async () => {
    vi.stubGlobal('RTCRtpSender', {});
    const screen = makeTransceiver();
    const legacyTransceiver = { sender: { track: screen.sender.track } } as unknown as RTCRtpTransceiver;
    activate('screen');
    expect(await makePeer(legacyTransceiver).createOffer()).toBe(offer);
    expect(await makePeer().createOffer()).toBe(offer);
    expect(await FakePeerConnection.prototype.createOffer.call({})).toBe(offer);
  });

  it('does not invent encodings while the sender is uninitialized', async () => {
    const screen = makeTransceiver('screen', []);
    activate('screen');
    expect(await makePeer(screen.transceiver).createOffer()).toBe(offer);
    expect(screen.sender.setParameters).not.toHaveBeenCalled();
  });

  it('is idempotent, updates the target and restores the original prototype', async () => {
    activate('old-screen');
    const installedHook = FakePeerConnection.prototype.createOffer;
    activate('screen');
    expect(FakePeerConnection.prototype.createOffer).toBe(installedHook);
    expect(isActive()).toBe(true);
    const screen = makeTransceiver();
    await makePeer(screen.transceiver).createOffer();
    expect(screen.setCodecPreferences).toHaveBeenCalledOnce();
    deactivate();
    deactivate();
    expect(FakePeerConnection.prototype.createOffer).toBe(originalCreateOffer);
    expect(isActive()).toBe(false);
    screen.setCodecPreferences.mockClear();
    await makePeer(screen.transceiver).createOffer();
    expect(screen.setCodecPreferences).not.toHaveBeenCalled();
  });

  it('preserves a newer external hook and leaves its retained wrapper usable after deactivation', async () => {
    activate('screen');
    const installedHook = FakePeerConnection.prototype.createOffer;
    const externalHook = vi.fn(function (this: RTCPeerConnection, options?: RTCOfferOptions) {
      return installedHook.call(this, options);
    });
    FakePeerConnection.prototype.createOffer = externalHook;
    deactivate();
    expect(FakePeerConnection.prototype.createOffer).toBe(externalHook);
    const screen = makeTransceiver();
    expect(await makePeer(screen.transceiver).createOffer()).toBe(offer);
    expect(screen.sender.getParameters).not.toHaveBeenCalled();
  });

  it('preserves original offer failures and does nothing without WebRTC', async () => {
    activate('screen');
    const error = new DOMException('peer closed', 'InvalidStateError');
    originalCreateOffer.mockRejectedValueOnce(error);
    await expect(makePeer().createOffer()).rejects.toBe(error);
    deactivate();
    vi.stubGlobal('RTCPeerConnection', undefined);
    expect(() => activate('screen')).not.toThrow();
    expect(isActive()).toBe(false);
  });
});
