import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStreamDiagnosticLogger,
  MAX_STREAM_DIAGNOSTIC_BYTES,
  STREAM_DIAGNOSTIC_FILENAME,
  STREAM_DIAGNOSTIC_PREFIX,
} from './streamDiagnostics';

let directory: string;
const payload = () => ({
  phase: 'video-publish', codec: 'h264', sourceKind: 'monitor',
  requested: { width: 2560, height: 1440, frameRate: 60, maxBitrate: 30_000_000, shareAudio: false },
  capture: { width: 2560, height: 1440, frameRate: 60, displaySurface: 'monitor' },
  audio: { present: false, live: false, enabled: false },
  error: { name: 'OperationError', message: "Failed to execute 'setRemoteDescription' on 'RTCPeerConnection': Failed to set remote answer sdp: Failed to set video send parameters." },
});
const message = (value: unknown) => STREAM_DIAGNOSTIC_PREFIX + JSON.stringify(value);
const readRecords = () => fs.readFileSync(path.join(directory, STREAM_DIAGNOSTIC_FILENAME), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-stream-diagnostic-')); });
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

describe('local stream failure diagnostics', () => {
  it('keeps the original negotiation error and bounded capture data with time and app version', () => {
    const log = createStreamDiagnosticLogger(directory, '1.11.5');
    expect(log(message(payload()))).toBe(true);
    const [record] = readRecords();
    expect(record).toMatchObject({ ...payload(), appVersion: '1.11.5' });
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });

  it('ignores other console messages, malformed and oversized input, and invalid fields', () => {
    const log = createStreamDiagnosticLogger(directory, '1.11.5');
    for (const input of [null, 'ordinary error', STREAM_DIAGNOSTIC_PREFIX + '{', message(null),
      message({ ...payload(), codec: 'av1' }), message({ ...payload(), phase: 'other' }),
      message({ ...payload(), requested: { ...payload().requested, width: -1 } }),
      message({ ...payload(), capture: { width: '2560' } }),
      message({ ...payload(), error: { name: 'Error', message: 'x'.repeat(9000) } }),
    ]) expect(log(input)).toBe(false);
    expect(fs.existsSync(path.join(directory, STREAM_DIAGNOSTIC_FILENAME))).toBe(false);
  });

  it('never saves extra renderer fields or uses a renderer-supplied file path', () => {
    const log = createStreamDiagnosticLogger(directory, '1.11.5');
    const target = path.join(directory, 'chosen-by-renderer.log');
    expect(log(message({ ...payload(), path: target, sdp: 'private SDP', token: 'private token',
      capture: { ...payload().capture, sourceTitle: 'private window title' },
      error: { ...payload().error, stack: 'private stack' },
    }))).toBe(true);
    const saved = fs.readFileSync(path.join(directory, STREAM_DIAGNOSTIC_FILENAME), 'utf8');
    expect(saved).not.toMatch(/private|chosen-by-renderer|sourceTitle|stack/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('redacts URLs, JWTs, bearer credentials and SDP from error strings', () => {
    const log = createStreamDiagnosticLogger(directory, '1.11.5');
    const failure = payload();
    failure.error.message = 'Failure https://private.example/join?access_token=secret Bearer abc123 ' +
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl token=secret2\nv=0\na=ice-pwd:secret3';
    expect(log(message(failure))).toBe(true);
    const [record] = readRecords();
    expect(record.error.message).toContain('Failure');
    expect(record.error.message).not.toMatch(/private\.example|secret|abc123|eyJ|ice-pwd|v=0/);
  });

  it('limits accepted error text and keeps the entire log under 256 KiB', () => {
    const log = createStreamDiagnosticLogger(directory, '1.11.5');
    const failure = payload();
    failure.error.message = 'Ж'.repeat(2500);
    for (let index = 0; index < 160; index++) expect(log(message(failure))).toBe(true);
    expect(fs.statSync(path.join(directory, STREAM_DIAGNOSTIC_FILENAME)).size).toBeLessThanOrEqual(MAX_STREAM_DIAGNOSTIC_BYTES);
    expect(readRecords().every((record) => record.error.message.length === 1024)).toBe(true);
  });

  it('does not throw if the log directory cannot be written', () => {
    const blockedDirectory = path.join(directory, 'not-a-directory');
    fs.writeFileSync(blockedDirectory, 'occupied');
    const log = createStreamDiagnosticLogger(blockedDirectory, '1.11.5');
    expect(() => log(message(payload()))).not.toThrow();
    expect(log(message(payload()))).toBe(false);
  });
});
