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

function parseFailure(message: unknown): JsonObject | null {
  if (typeof message !== 'string' || !message.startsWith(STREAM_DIAGNOSTIC_PREFIX)
    || Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) return null;
  let input: JsonObject | null;
  try {
    input = object(JSON.parse(message.slice(STREAM_DIAGNOSTIC_PREFIX.length)));
  } catch {
    return null;
  }
  if (!input) return null;
  const phase = oneOf(input.phase, ['capture', 'video-publish', 'audio-publish']);
  const codec = oneOf(input.codec, ['h264', 'vp9']);
  const sourceKind = oneOf(input.sourceKind, ['monitor', 'window', 'unknown']);
  const requested = object(input.requested);
  const capture = object(input.capture);
  const audio = object(input.audio);
  const error = object(input.error);
  if (!phase || !codec || !sourceKind || !requested || !capture || !audio || !error
    || !number(requested.width, 32768) || !number(requested.height, 32768)
    || !number(requested.frameRate, 1000) || !number(requested.maxBitrate, 1_000_000_000)
    || typeof requested.shareAudio !== 'boolean'
    || typeof audio.present !== 'boolean' || typeof audio.live !== 'boolean' || typeof audio.enabled !== 'boolean'
    || typeof error.name !== 'string' || typeof error.message !== 'string') return null;
  const safeCapture: JsonObject = {};
  for (const field of ['width', 'height', 'frameRate'] as const) {
    if (capture[field] === undefined) continue;
    if (!number(capture[field], field === 'frameRate' ? 1000 : 32768)) return null;
    safeCapture[field] = capture[field];
  }
  if (capture.displaySurface !== undefined) {
    const surface = oneOf(capture.displaySurface, ['monitor', 'window', 'browser', 'application', 'unknown']);
    if (!surface) return null;
    safeCapture.displaySurface = surface;
  }
  // Construct every saved field explicitly. Extra renderer fields (including
  // URLs, SDP, source titles, paths and tokens) never reach the log.
  return {
    phase, codec, sourceKind,
    requested: {
      width: requested.width, height: requested.height, frameRate: requested.frameRate,
      maxBitrate: requested.maxBitrate, shareAudio: requested.shareAudio,
    },
    capture: safeCapture,
    audio: { present: audio.present, live: audio.live, enabled: audio.enabled },
    error: { name: safeErrorText(error.name, 96), message: safeErrorText(error.message, 1024) },
  };
}

/** The main process supplies the log directory; renderer messages cannot choose a path. */
export function createStreamDiagnosticLogger(logsDirectory: string, appVersion: string): (message: unknown) => boolean {
  const logFile = path.join(logsDirectory, STREAM_DIAGNOSTIC_FILENAME);
  return (message) => {
    const failure = parseFailure(message);
    if (!failure) return false;
    const line = JSON.stringify({
      time: new Date().toISOString(), appVersion: safeErrorText(appVersion, 64), ...failure,
    }) + '\n';
    try {
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
