import { RemoteVideoTrack, Track, VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { controlScreenShareDimensions } from './livekitInternals';

export type StreamViewerQualityChoice = 'auto' | 'original' | 'medium' | 'economy';
export interface StreamViewerQualityOption {
  value: Exclude<StreamViewerQualityChoice, 'auto'>;
  height?: number;
  maxBitrate?: number;
  fps?: number;
}

const QUALITY_VALUES = {
  original: VideoQuality.HIGH,
  medium: VideoQuality.MEDIUM,
  economy: VideoQuality.LOW,
} as const;

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Advertised encoding caps, never the receiver's measured throughput. */
export function streamViewerQualityOptions(
  publication: RemoteTrackPublication,
  receivedCodec?: string,
): StreamViewerQualityOption[] {
  const fallback: StreamViewerQualityOption[] = [{
    value: 'original',
    height: positive(publication.dimensions?.height),
  }];
  // Until the negotiated codec is known, do not advertise the primary's
  // layers to a receiver that might actually be getting a single-layer backup.
  if (!receivedCodec || publication.source !== Track.Source.ScreenShare) return fallback;
  const mimeType = receivedCodec.toLowerCase();
  const info = publication.trackInfo;
  const codec = info?.codecs?.find((item) => item.mimeType.toLowerCase() === mimeType);
  const layers = codec?.layers?.length ? codec.layers
    : info?.mimeType.toLowerCase() === mimeType ? info.layers : undefined;
  if (!layers?.length) return fallback;
  const sorted = [...layers].sort((a, b) => b.quality - a.quality);
  const highest = sorted[0]!;
  const options: StreamViewerQualityOption[] = [];
  for (const layer of sorted) {
    const value = layer === highest ? 'original'
      : layer.quality === VideoQuality.MEDIUM ? 'medium'
        : layer.quality === VideoQuality.LOW ? 'economy' : undefined;
    if (!value || options.some((option) => option.value === value)) continue;
    options.push({ value, height: positive(layer.height), maxBitrate: positive(layer.bitrate) });
  }
  return options.length ? options : fallback;
}

/** One subscription; it survives tile/PiP mounts but never an SDK track swap. */
export class StreamViewerQualityController {
  private readonly track: RemoteVideoTrack | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposeDimensions: ((restore: boolean) => void) | undefined;
  private stopped = false;
  private refreshing = false;
  private codec: string | undefined;
  private choice: StreamViewerQualityChoice = 'auto';
  private options: StreamViewerQualityOption[];

  constructor(
    private readonly publication: RemoteTrackPublication,
    private readonly onOptions: (options: StreamViewerQualityOption[]) => void,
  ) {
    this.track = publication.track instanceof RemoteVideoTrack ? publication.track : undefined;
    this.options = streamViewerQualityOptions(publication);
    this.onOptions(this.options);
    if (this.track) {
      void this.refresh();
      this.timer = setInterval(() => { void this.refresh(); }, 3000);
    }
  }

  setQuality(choice: StreamViewerQualityChoice): void {
    this.choice = choice;
    this.apply();
  }

  private apply(): void {
    if (this.stopped || !this.track || this.publication.track !== this.track) return;
    const selected = this.options.find((option) => option.value === this.choice);
    const multiple = this.options.length > 1;
    const sameResolution = multiple && this.options.every((option) => option.height === this.options[0]?.height);
    const explicit = this.choice !== 'auto' && selected !== undefined;
    if (multiple && (explicit || sameResolution)) {
      this.disposeDimensions ??= controlScreenShareDimensions(this.publication, this.track) ?? undefined;
      if (!this.disposeDimensions) {
        // The installed SDK changed its adaptive-stream contract. Keep the
        // original stream working instead of offering controls that do nothing.
        this.options = this.options.filter((option) => option.value === 'original');
        this.onOptions(this.options);
      }
    } else if (this.disposeDimensions) {
      this.disposeDimensions(true);
      this.disposeDimensions = undefined;
    }
    const quality = explicit && this.disposeDimensions && this.choice !== 'auto'
      ? QUALITY_VALUES[this.choice] : VideoQuality.HIGH;
    this.publication.setVideoQuality(quality);
    // setVideoQuality short-circuits when the requested cap did not change,
    // including rebinds after resubscription. Send the cleared adaptive state.
    this.publication.emitTrackUpdate();
  }

  async refresh(): Promise<void> {
    if (this.stopped || this.refreshing || !this.track) return;
    this.refreshing = true;
    try {
      const stats = await this.track.getReceiverStats();
      if (this.stopped || this.publication.track !== this.track) return;
      if (stats?.mimeType) this.codec = stats.mimeType;
      const next = streamViewerQualityOptions(this.publication, this.codec);
      if (JSON.stringify(next) !== JSON.stringify(this.options)) {
        this.options = next;
        this.onOptions(next);
        this.apply();
      }
    } catch {
      // Stats are optional (and briefly unavailable while reconnecting).
    } finally {
      this.refreshing = false;
    }
  }

  dispose(restore = false): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.disposeDimensions?.(restore);
    this.disposeDimensions = undefined;
  }
}
