// Configure the H.264 screen sender before its first offer. Codec capabilities
// are browser-owned: changing a Baseline payload's SDP profile does not create
// a supported Main encoder and can leave subsequent negotiations inconsistent.

let _active = false;
let _screenTrackId: string | null = null;
let _originalCreateOffer: typeof RTCPeerConnection.prototype.createOffer | null = null;
let _patchedCreateOffer: typeof RTCPeerConnection.prototype.createOffer | null = null;

type Codec = RTCRtpCapabilities['codecs'][number];

function codecPreference(codec: Codec): number {
  if (codec.mimeType.toLowerCase() !== 'video/h264') return 3;
  const parameters = new Map((codec.sdpFmtpLine ?? '').split(';').map((entry) => {
    const [name, value] = entry.trim().split('=');
    return [name?.trim().toLowerCase(), value?.trim().toLowerCase()];
  }));
  if (parameters.get('packetization-mode') === '1') {
    const profile = parameters.get('profile-level-id');
    if (profile?.startsWith('4d')) return 0;
    if (profile?.startsWith('64')) return 1;
  }
  return 2;
}

async function prepareScreenSender(pc: RTCPeerConnection, trackId: string): Promise<void> {
  let transceiver: RTCRtpTransceiver | undefined;
  try {
    transceiver = pc.getTransceivers?.().find(({ sender }) =>
      sender.track?.id === trackId && sender.track.kind === 'video');
  } catch {
    return;
  }
  if (!transceiver) return;

  try {
    const capabilities = typeof RTCRtpSender !== 'undefined'
      ? RTCRtpSender.getCapabilities?.('video') : null;
    if (capabilities) {
      if (!capabilities.codecs.some((codec) => codec.mimeType.toLowerCase() === 'video/h264')) return;
      // Stable sorting preserves the browser's order within every fallback
      // group and keeps its original codec/RTX objects and fmtp parameters.
      const codecs = [...capabilities.codecs].sort((a, b) => codecPreference(a) - codecPreference(b));
      transceiver.setCodecPreferences?.(codecs);
    }
  } catch {
    // Older browsers may expose capabilities that setCodecPreferences rejects.
    // Their normal codec negotiation remains a usable fallback.
  }

  try {
    const { sender } = transceiver;
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) return;
    parameters.encodings = parameters.encodings.map((encoding) => ({ ...encoding, scalabilityMode: 'L1T1' }));
    // Independent bitrate copies do not need temporal layering. Wait for the
    // write before createOffer so the initial encoder uses these parameters.
    await sender.setParameters(parameters);
  } catch {
    // Unsupported sender parameters must not prevent the stream's offer.
  }
}

/** Apply advertised H.264 profile preferences only to this screen track. */
export function activate(expectedScreenTrackId: string): void {
  if (!expectedScreenTrackId || typeof RTCPeerConnection === 'undefined') return;
  _screenTrackId = expectedScreenTrackId;
  if (_active) return;

  const original = RTCPeerConnection.prototype.createOffer;
  _originalCreateOffer = original;
  // Forward both the Promise and legacy callback overloads unchanged. The
  // captured original also survives deactivation if another library retained
  // this wrapper in its own hook.
  const patched = async function (this: RTCPeerConnection, ...args: unknown[]): Promise<RTCSessionDescriptionInit | void> {
    if (_active && _screenTrackId) await prepareScreenSender(this, _screenTrackId);
    return Reflect.apply(original, this, args) as Promise<RTCSessionDescriptionInit | void>;
  } as unknown as typeof RTCPeerConnection.prototype.createOffer;
  _patchedCreateOffer = patched;
  RTCPeerConnection.prototype.createOffer = patched;
  _active = true;
}

/** Restore the prototype without replacing another library's newer hook. */
export function deactivate(): void {
  if (!_active) return;
  if (_originalCreateOffer && RTCPeerConnection.prototype.createOffer === _patchedCreateOffer) {
    RTCPeerConnection.prototype.createOffer = _originalCreateOffer;
  }
  _originalCreateOffer = null;
  _patchedCreateOffer = null;
  _screenTrackId = null;
  _active = false;
}

export function isActive(): boolean {
  return _active;
}
