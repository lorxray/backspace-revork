import type { ScreenShareConfig } from '../stores/voiceStore';

interface CaptureOptions {
  capture: { width: number; height: number; frameRate: number };
  publish: { videoEncoding: { maxBitrate: number } };
}

/** Small, source-content-free failure record consumed by the desktop logger. */
export function logScreenShareFailure(
  phase: 'capture' | 'video-publish' | 'audio-publish',
  error: unknown,
  config: ScreenShareConfig,
  options: CaptureOptions,
  stream?: MediaStream,
  source?: Pick<ElectronScreenSource, 'isScreen'> | null,
): void {
  // Diagnostics must never interrupt capture cleanup or replace its exception.
  try {
    const video = stream?.getVideoTracks()[0];
    const settings = video?.getSettings?.() ?? {};
    const audio = stream?.getAudioTracks() ?? [];
    const failure = error instanceof Error
      || (typeof DOMException !== 'undefined' && error instanceof DOMException) ? error : null;
    console.error('[ScreenShare:Diagnostic] ' + JSON.stringify({
      phase,
      codec: config.codec,
      sourceKind: source ? (source.isScreen ? 'monitor' : 'window') : 'unknown',
      requested: {
        ...options.capture,
        maxBitrate: options.publish.videoEncoding.maxBitrate,
        shareAudio: config.shareAudio,
      },
      capture: {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        displaySurface: settings.displaySurface,
      },
      audio: {
        present: audio.length > 0,
        live: audio.some(track => track.readyState === 'live'),
        enabled: config.shareAudio,
      },
      error: {
        name: failure?.name ?? 'Error',
        message: (failure?.message ?? (typeof error === 'string' ? error : 'Unknown screen-share failure')).slice(0, 3000),
      },
    }));
  } catch {
    // The original failure is still reported through the normal error path.
  }
}

type EncoderCodec = 'h264' | 'vp9' | 'vp8';
type H264Parameters = { profile?: string; packetizationMode?: '0' | '1' };

function startupBitrate(fmtp: string | undefined): number | undefined {
  const match = /(?:^|;)\s*x-google-start-bitrate\s*=\s*(\d+)\s*(?:;|$)/i.exec(fmtp ?? '');
  return match ? diagnosticNumber(Number(match[1]), 10_000_000) : undefined;
}

interface DiagnosticStatsEntry extends RTCStats {
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  sdpFmtpLine?: string;
  active?: boolean;
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  rid?: string;
  bytesSent?: number;
  framesEncoded?: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  qualityLimitationReason?: string;
  targetBitrate?: number;
  state?: string;
  nominated?: boolean;
  selectedCandidatePairId?: string;
  availableOutgoingBitrate?: number;
  currentRoundTripTime?: number;
}

function diagnosticCodec(value: unknown): EncoderCodec | undefined {
  if (typeof value !== 'string') return;
  const match = /^video\/(h264|vp9|vp8)$/i.exec(value);
  return match?.[1]?.toLowerCase() as EncoderCodec | undefined;
}

/** Extract only the two H264 negotiation parameters useful for encoder diagnosis. */
function h264Parameters(fmtp: unknown): H264Parameters {
  const result: H264Parameters = {};
  if (typeof fmtp !== 'string') return result;
  for (const parameter of fmtp.slice(0, 4096).split(';')) {
    const match = /^\s*(profile-level-id|packetization-mode)\s*=\s*([^\s;]+)\s*$/i.exec(parameter);
    if (!match) continue;
    if (match[1]!.toLowerCase() === 'profile-level-id' && /^[0-9a-f]{6}$/i.test(match[2]!)) {
      result.profile = match[2]!.toLowerCase();
    } else if (match[1]!.toLowerCase() === 'packetization-mode' && /^[01]$/.test(match[2]!)) {
      result.packetizationMode = match[2] as '0' | '1';
    }
  }
  return result;
}

function diagnosticNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value : undefined;
}

function h264Capabilities(): Array<H264Parameters & { profile: string }> {
  const profiles: Array<H264Parameters & { profile: string }> = [];
  try {
    const codecs = typeof RTCRtpSender !== 'undefined' ? RTCRtpSender.getCapabilities?.('video')?.codecs : undefined;
    for (const codec of codecs ?? []) {
      if (diagnosticCodec(codec.mimeType) !== 'h264') continue;
      const parameters = h264Parameters(codec.sdpFmtpLine);
      if (!parameters.profile || profiles.some(existing => existing.profile === parameters.profile
        && existing.packetizationMode === parameters.packetizationMode)) continue;
      profiles.push({ ...parameters, profile: parameters.profile });
      if (profiles.length >= 16) break;
    }
  } catch {
    // Some browser versions do not expose sender capabilities.
  }
  return profiles;
}

/** A bounded technical snapshot: no track IDs, source names, or raw SDP/fmtp. */
export function logScreenShareEncoder(
  codec: 'h264' | 'vp9',
  track: MediaStreamTrack,
  stats: RTCStatsReport,
  requestedMaxBitrate?: number,
): void {
  try {
    let settings: MediaTrackSettings = {};
    try { settings = track.getSettings(); } catch { /* Non-critical browser API. */ }
    const codecs = new Map<string, DiagnosticStatsEntry>();
    const outbound: DiagnosticStatsEntry[] = [];
    const pairs = new Map<string, DiagnosticStatsEntry>();
    let selectedPairId: string | undefined;
    stats.forEach((report) => {
      const entry = report as DiagnosticStatsEntry;
      if (entry.type === 'codec') codecs.set(entry.id, entry);
      else if (entry.type === 'candidate-pair') pairs.set(entry.id, entry);
      else if (entry.type === 'transport' && entry.selectedCandidatePairId) selectedPairId = entry.selectedCandidatePairId;
      else if (entry.type === 'outbound-rtp' && (entry.kind === 'video' || entry.mediaType === 'video')
        && entry.active !== false) outbound.push(entry);
    });
    const encoders = outbound.flatMap((entry) => {
      const selectedCodec = entry.codecId ? codecs.get(entry.codecId) : undefined;
      const encodingCodec = diagnosticCodec(entry.mimeType ?? selectedCodec?.mimeType);
      if (!encodingCodec) return [];
      const implementation = typeof entry.encoderImplementation === 'string'
        && /^[a-z0-9 _().,+-]{1,512}$/i.test(entry.encoderImplementation) ? entry.encoderImplementation : null;
      const qualityLimitation = ['none', 'cpu', 'bandwidth', 'other'].includes(entry.qualityLimitationReason ?? '')
        ? entry.qualityLimitationReason : undefined;
      return [{
        codec: encodingCodec,
        ...(encodingCodec === 'h264' ? h264Parameters(selectedCodec?.sdpFmtpLine) : {}),
        implementation,
        powerEfficient: typeof entry.powerEfficientEncoder === 'boolean' ? entry.powerEfficientEncoder : null,
        rid: typeof entry.rid === 'string' && /^[a-z0-9_-]{1,16}$/i.test(entry.rid) ? entry.rid : undefined,
        bytesSent: diagnosticNumber(entry.bytesSent) ?? 0,
        framesEncoded: diagnosticNumber(entry.framesEncoded) ?? 0,
        width: diagnosticNumber(entry.frameWidth, 32768),
        height: diagnosticNumber(entry.frameHeight, 32768),
        fps: diagnosticNumber(entry.framesPerSecond, 1000),
        qualityLimitation,
        targetBitrate: diagnosticNumber(entry.targetBitrate),
        startBitrateKbps: startupBitrate(selectedCodec?.sdpFmtpLine),
      }];
    }).sort((a, b) => b.bytesSent - a.bytesSent || b.framesEncoded - a.framesEncoded).slice(0, 3);
    const pair = (selectedPairId ? pairs.get(selectedPairId) : undefined)
      ?? [...pairs.values()].find(entry => entry.nominated && entry.state === 'succeeded');
    const availableOutgoingBitrate = diagnosticNumber(pair?.availableOutgoingBitrate);
    const rtt = diagnosticNumber(pair?.currentRoundTripTime, 600);
    console.info('[ScreenShare:Diagnostic] ' + JSON.stringify({
      phase: 'encoder',
      codec,
      capture: {
        width: diagnosticNumber(settings.width, 32768),
        height: diagnosticNumber(settings.height, 32768),
        frameRate: diagnosticNumber(settings.frameRate, 1000),
        displaySurface: ['monitor', 'window', 'browser'].includes(settings.displaySurface ?? '')
          ? settings.displaySurface : undefined,
      },
      encoders,
      capabilities: h264Capabilities(),
      requestedMaxBitrate: diagnosticNumber(requestedMaxBitrate),
      ...(availableOutgoingBitrate !== undefined || rtt !== undefined ? { network: {
        availableOutgoingBitrate,
        roundTripTimeMs: rtt !== undefined ? Math.round(rtt * 1000) : undefined,
      } } : {}),
    }));
  } catch {
    // Diagnostics must not affect publication, encoder detection, or toasts.
  }
}
