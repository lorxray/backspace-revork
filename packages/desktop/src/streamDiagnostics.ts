import fs from 'fs';
import path from 'path';

export const STREAM_DIAGNOSTIC_PREFIX = '[ScreenShare:Diagnostic] ';
export const STREAM_DIAGNOSTIC_FILENAME = 'screen-share.log';
export const MAX_STREAM_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_MESSAGE_BYTES = 8 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : null;
}

function number(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

/** Keep negotiation errors useful without persisting network credentials or SDP. */
function safeErrorText(value: string, maximum: number): string {
  return value
    .replace(/(?:^|[\r\n])\s*(?:v=0|m=(?:audio|video|application)\b|a=(?:ice-|fingerprint:|candidate:|rtpmap:))[\s\S]*/i, ' [SDP omitted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, '[URL omitted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [token omitted]')
    .replace(/\b(?:authorization|access[_-]?token|refresh[_-]?token|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[credential omitted]')
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token omitted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, maximum);
}

function parseCapture(value: unknown): JsonObject | null {
  const capture = object(value);
  if (!capture) return null;
  const result: JsonObject = {};
  for (const field of ['width', 'height', 'frameRate'] as const) {
    if (capture[field] === undefined) continue;
    if (!number(capture[field], field === 'frameRate' ? 1000 : 32768)) return null;
    result[field] = capture[field];
  }
  if (capture.displaySurface !== undefined) {
    const surface = oneOf(capture.displaySurface, ['monitor', 'window', 'browser', 'application', 'unknown']);
    if (!surface) return null;
    result.displaySurface = surface;
  }
  return result;
}

function parseProfile(value: unknown): JsonObject | null {
  const input = object(value);
  if (!input) return null;
  const result: JsonObject = {};
  if (input.profile !== undefined) {
    if (typeof input.profile !== 'string' || !/^[a-f0-9]{6}$/i.test(input.profile)) return null;
    result.profile = input.profile.toLowerCase();
  }
  if (input.packetizationMode !== undefined) {
    if (input.packetizationMode !== '0' && input.packetizationMode !== '1') return null;
    result.packetizationMode = input.packetizationMode;
  }
  return result;
}

function parseEncoder(input: JsonObject): JsonObject | null {
  const codec = oneOf(input.codec, ['h264', 'vp9']);
  const capture = parseCapture(input.capture);
  if (!codec || !capture || !Array.isArray(input.encoders) || input.encoders.length > 3
    || !Array.isArray(input.capabilities) || input.capabilities.length > 16) return null;
  const encoders: JsonObject[] = [];
  for (const value of input.encoders) {
    const entry = object(value);
    const profile = parseProfile(entry);
    const selectedCodec = oneOf(entry?.codec, ['h264', 'vp9', 'vp8']);
    if (!entry || !profile || !selectedCodec
      || !number(entry.bytesSent, Number.MAX_SAFE_INTEGER)
      || !number(entry.framesEncoded, Number.MAX_SAFE_INTEGER)
      || (entry.implementation !== null && typeof entry.implementation !== 'string')
      || (entry.powerEfficient !== null && typeof entry.powerEfficient !== 'boolean')) return null;
    const safe: JsonObject = {
      codec: selectedCodec, ...profile,
      implementation: typeof entry.implementation === 'string' ? safeErrorText(entry.implementation, 512) : null,
      powerEfficient: entry.powerEfficient,
      bytesSent: entry.bytesSent, framesEncoded: entry.framesEncoded,
    };
    if (entry.rid !== undefined) {
      if (typeof entry.rid !== 'string' || !/^[a-z0-9_-]{1,16}$/i.test(entry.rid)) return null;
      safe.rid = entry.rid;
    }
    for (const field of ['width', 'height', 'fps'] as const) {
      if (entry[field] === undefined) continue;
      if (!number(entry[field], field === 'fps' ? 1000 : 32768)) return null;
      safe[field] = entry[field];
    }
    if (entry.qualityLimitation !== undefined) {
      const reason = oneOf(entry.qualityLimitation, ['none', 'cpu', 'bandwidth', 'other']);
      if (!reason) return null;
      safe.qualityLimitation = reason;
    }
    encoders.push(safe);
  }
  const capabilities: JsonObject[] = [];
  for (const value of input.capabilities) {
    const profile = parseProfile(value);
    if (!profile || !profile.profile) return null;
    capabilities.push(profile);
  }
  return { phase: 'encoder', codec, capture, encoders, capabilities };
}

/** Runtime fields come from the main process, independently of renderer input. */
function parseRuntime(value: unknown): JsonObject | null {
  const input = object(value);
  if (!input) return null;
  const result: JsonObject = {};
  if (typeof input.videoEncode === 'string') result.videoEncode = safeErrorText(input.videoEncode, 64);
  const info = object(input.gpuInfo);
  if (Array.isArray(info?.gpuDevice)) {
    result.devices = info.gpuDevice.slice(0, 4).flatMap(value => {
      const device = object(value);
      if (!device || !number(device.vendorId, 65535) || !number(device.deviceId, 65535)
        || typeof device.active !== 'boolean') return [];
      const safe: JsonObject = { vendorId: device.vendorId, deviceId: device.deviceId, active: device.active };
      for (const field of ['vendorString', 'deviceString', 'driverVendor', 'driverVersion'] as const) {
        if (typeof device[field] === 'string') safe[field] = safeErrorText(device[field], 160);
      }
      return [safe];
    });
  }
  const attributes = object(info?.auxAttributes);
  if (typeof attributes?.glRenderer === 'string') result.renderer = safeErrorText(attributes.glRenderer, 256);
  return Object.keys(result).length > 0 ? result : null;
}

function parseDiagnostic(message: unknown): JsonObject | null {
  if (typeof message !== 'string' || !message.startsWith(STREAM_DIAGNOSTIC_PREFIX)
    || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return null;
  let input: JsonObject | null;
  try {
    input = object(JSON.parse(message.slice(STREAM_DIAGNOSTIC_PREFIX.length)));
  } catch {
    return null;
  }
  if (!input) return null;
  if (input.phase === 'encoder') return parseEncoder(input);
  const phase = oneOf(input.phase, ['capture', 'video-publish', 'audio-publish']);
  const codec = oneOf(input.codec, ['h264', 'vp9']);
  const sourceKind = oneOf(input.sourceKind, ['monitor', 'window', 'unknown']);
  const requested = object(input.requested);
  const capture = parseCapture(input.capture);
  const audio = object(input.audio);
  const error = object(input.error);
  if (!phase || !codec || !sourceKind || !requested || !capture || !audio || !error
    || !number(requested.width, 32768) || !number(requested.height, 32768)
    || !number(requested.frameRate, 1000) || !number(requested.maxBitrate, 1_000_000_000)
    || typeof requested.shareAudio !== 'boolean'
    || typeof audio.present !== 'boolean' || typeof audio.live !== 'boolean' || typeof audio.enabled !== 'boolean'
    || typeof error.name !== 'string' || typeof error.message !== 'string') return null;
  // Construct every saved field explicitly. Extra renderer fields (including
  // URLs, SDP, source titles, paths and tokens) never reach the log.
  return {
    phase, codec, sourceKind,
    requested: {
      width: requested.width, height: requested.height, frameRate: requested.frameRate,
      maxBitrate: requested.maxBitrate, shareAudio: requested.shareAudio,
    },
    capture,
    audio: { present: audio.present, live: audio.live, enabled: audio.enabled },
    error: { name: safeErrorText(error.name, 96), message: safeErrorText(error.message, 1024) },
  };
}

/** The main process supplies the log directory; renderer messages cannot choose a path. */
export function createStreamDiagnosticLogger(
  logsDirectory: string,
  appVersion: string,
  readRuntime?: () => unknown,
): (message: unknown) => boolean {
  const logFile = path.join(logsDirectory, STREAM_DIAGNOSTIC_FILENAME);
  return (message) => {
    try {
      const diagnostic = parseDiagnostic(message);
      if (!diagnostic) return false;
      let runtime: JsonObject | null = null;
      if (diagnostic.phase === 'encoder') {
        try { runtime = parseRuntime(readRuntime?.()); } catch { /* GPU information is optional. */ }
      }
      const line = JSON.stringify({
        time: new Date().toISOString(), appVersion: safeErrorText(appVersion, 64), ...diagnostic,
        ...(runtime ? { runtime } : {}),
      }) + '\n';
      fs.mkdirSync(logsDirectory, { recursive: true });
      const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
      // Start a fresh segment when full instead of leaving unbounded backups.
      if (size + Buffer.byteLength(line, 'utf8') > MAX_STREAM_DIAGNOSTIC_BYTES) {
        fs.writeFileSync(logFile, line, 'utf8');
      } else {
        fs.appendFileSync(logFile, line, 'utf8');
      }
      return true;
    } catch {
      // Diagnostics must never fail a stream or crash the desktop app, even
      // when its log directory is unavailable or has become read-only.
      return false;
    }
  };
}
