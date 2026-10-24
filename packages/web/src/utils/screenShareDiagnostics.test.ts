import { afterEach, describe, expect, it, vi } from 'vitest';
import { logScreenShareEncoder } from './screenShareDiagnostics';

const PREFIX = '[ScreenShare:Diagnostic] ';

function report(entries: Array<Record<string, unknown>>): RTCStatsReport {
  return new Map(entries.map((entry, index) => [String(index), { id: String(index), timestamp: 0, ...entry }])) as unknown as RTCStatsReport;
}

function capture(settings: Record<string, unknown> = {}): MediaStreamTrack {
  return { getSettings: () => settings } as unknown as MediaStreamTrack;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('screen-share encoder diagnostics', () => {
  it('records startup targets and the selected network estimate without persisting candidate addresses', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    logScreenShareEncoder('h264', capture(), report([
      { id: 'codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640020;x-google-start-bitrate=22050' },
      { type: 'outbound-rtp', kind: 'video', codecId: 'codec', targetBitrate: 2_000_000 },
      { id: 'selected', type: 'candidate-pair', state: 'succeeded', availableOutgoingBitrate: 3_000_000,
        currentRoundTripTime: 0.035, localCandidateId: 'private-local', remoteCandidateId: 'private-remote' },
      { type: 'transport', selectedCandidatePairId: 'selected' },
      { type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 999_999 },
      { type: 'remote-candidate', address: 'private-address' },
    ]), 15_000_000);
    const message = String(output.mock.calls[0]![0]);
    expect(JSON.parse(message.slice(PREFIX.length))).toMatchObject({
      requestedMaxBitrate: 15_000_000,
      encoders: [{ targetBitrate: 2_000_000, startBitrateKbps: 22050 }],
      network: { availableOutgoingBitrate: 3_000_000, roundTripTimeMs: 35 },
    });
    expect(message).not.toMatch(/private|selectedCandidatePairId|localCandidateId/);
  });

  it('records selected H264 parameters and technical capture/encoder fields without source content', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    const getCapabilities = vi.fn(() => ({ codecs: [
      { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42E01F;packetization-mode=1;private=secret-capability' },
      { mimeType: 'video/h264', sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=1' },
      { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640032;packetization-mode=0' },
      { mimeType: 'video/VP8', sdpFmtpLine: 'profile-level-id=424242' },
      { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=invalid' },
    ] }));
    vi.stubGlobal('RTCRtpSender', { getCapabilities });

    logScreenShareEncoder('h264', capture({
      width: 3440, height: 1440, frameRate: 60, displaySurface: 'monitor',
      deviceId: 'private-device-id', label: 'Private window title',
    }), report([
      { id: 'unused-codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=640032' },
      { id: 'selected-codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42E033;private=secret-fmtp' },
      { type: 'outbound-rtp', kind: 'video', codecId: 'selected-codec', bytesSent: 12345, framesEncoded: 60,
        frameWidth: 3440, frameHeight: 1440, framesPerSecond: 59.9, rid: 'f',
        encoderImplementation: 'SimulcastEncoderAdapter (OpenH264)', powerEfficientEncoder: false,
        qualityLimitationReason: 'cpu', trackIdentifier: 'private-track-id', url: 'https://private.example/token' },
      { type: 'outbound-rtp', kind: 'video', mimeType: 'video/VP8', active: false, bytesSent: 99999 },
      { type: 'outbound-rtp', kind: 'audio', mimeType: 'audio/opus', bytesSent: 99999 },
    ]));

    expect(getCapabilities).toHaveBeenCalledWith('video');
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0]![0]).slice(PREFIX.length))).toEqual({
      phase: 'encoder', codec: 'h264',
      capture: { width: 3440, height: 1440, frameRate: 60, displaySurface: 'monitor' },
      encoders: [{
        codec: 'h264', profile: '42e033', packetizationMode: '1',
        implementation: 'SimulcastEncoderAdapter (OpenH264)', powerEfficient: false, rid: 'f',
        bytesSent: 12345, framesEncoded: 60, width: 3440, height: 1440, fps: 59.9, qualityLimitation: 'cpu',
      }],
      capabilities: [{ profile: '42e01f', packetizationMode: '1' }, { profile: '640032', packetizationMode: '0' }],
    });
    expect(String(output.mock.calls[0]![0])).not.toMatch(/private|secret|selected-codec|unused-codec/i);
  });

  it('caps encoder layers and distinct capability profiles', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: Array.from({ length: 30 }, (_, index) => ({
      mimeType: 'video/H264', sdpFmtpLine: `profile-level-id=42${index.toString(16).padStart(4, '0')}`,
    })) }) });

    logScreenShareEncoder('vp9', capture(), report(Array.from({ length: 6 }, (_, index) => ({
      type: 'outbound-rtp', mediaType: 'video', mimeType: 'video/VP9', bytesSent: index,
    }))));

    const record = JSON.parse(String(output.mock.calls[0]![0]).slice(PREFIX.length));
    expect(record.encoders).toHaveLength(3);
    expect(record.encoders.map((entry: { bytesSent: number }) => entry.bytesSent)).toEqual([5, 4, 3]);
    expect(record.capabilities).toHaveLength(16);
  });

  it('drops malformed values and avoids passing paths, URLs, or raw fmtp through string fields', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => null });

    logScreenShareEncoder('h264', capture({ width: Infinity, height: -1, frameRate: NaN, displaySurface: 'private title' }), report([
      { id: 'codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f-token;packetization-mode=2' },
      { type: 'outbound-rtp', kind: 'video', codecId: 'codec', encoderImplementation: 'C:\\private\\file',
        powerEfficientEncoder: 'true', rid: 'https://private.example', bytesSent: -1, framesEncoded: NaN,
        frameWidth: Infinity, frameHeight: 100_001, framesPerSecond: 1001, qualityLimitationReason: 'private text' },
    ]));

    expect(JSON.parse(String(output.mock.calls[0]![0]).slice(PREFIX.length))).toEqual({
      phase: 'encoder', codec: 'h264', capture: {},
      encoders: [{ codec: 'h264', implementation: null, powerEfficient: null, bytesSent: 0, framesEncoded: 0 }],
      capabilities: [],
    });
  });

  it('still records available stats when optional capture and capabilities APIs throw', () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('RTCRtpSender', { getCapabilities: () => { throw new Error('unsupported'); } });
    const track = { getSettings: () => { throw new Error('ended'); } } as unknown as MediaStreamTrack;

    expect(() => logScreenShareEncoder('vp9', track, report([]))).not.toThrow();
    expect(JSON.parse(String(output.mock.calls[0]![0]).slice(PREFIX.length))).toEqual({
      phase: 'encoder', codec: 'vp9', capture: {}, encoders: [], capabilities: [],
    });
    output.mockImplementation(() => { throw new Error('console unavailable'); });
    expect(() => logScreenShareEncoder('vp9', track, report([]))).not.toThrow();
  });
});
