import { CHANNEL_TOPIC_MAX_LENGTH } from '@backspace/shared/src/constants';

// Voice topics have no visible editor. Keep the existing topic alongside the
// image so removing a vibe restores it, using the server's existing channel API.
const PREFIX = 'backspace:voice-vibe:v1:';
const RECENTS_KEY = 'backspace.voice-vibe-recents.v1';
const RECENTS_LIMIT = 9;

interface VoiceChannelVibe {
  url: string;
  topic: string | null;
}

export function normalizeVibeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\s\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function readVoiceChannelVibe(topic: string | null | undefined): VoiceChannelVibe | null {
  if (!topic?.startsWith(PREFIX)) return null;
  try {
    const value: unknown = JSON.parse(topic.slice(PREFIX.length));
    if (!value || typeof value !== 'object') return null;
    const vibe = value as Record<string, unknown>;
    if (typeof vibe.url !== 'string' || !(vibe.topic === null || typeof vibe.topic === 'string')) return null;
    const url = normalizeVibeUrl(vibe.url);
    return url ? { url, topic: vibe.topic } : null;
  } catch {
    return null;
  }
}

/** Returns null for an invalid/oversized selection; never truncates channel data. */
export function topicWithVoiceChannelVibe(topic: string | null, imageUrl: string): string | null {
  const url = normalizeVibeUrl(imageUrl);
  if (!url) return null;
  const existing = readVoiceChannelVibe(topic);
  const originalTopic = existing ? existing.topic : topic;
  const result = PREFIX + JSON.stringify({ url, topic: originalTopic });
  return result.length <= CHANNEL_TOPIC_MAX_LENGTH ? result : null;
}

export function topicWithoutVoiceChannelVibe(topic: string | null): string | null {
  const vibe = readVoiceChannelVibe(topic);
  return vibe ? vibe.topic : topic;
}

export function readRecentVoiceVibes(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((url): url is string => typeof url === 'string')
      .map(normalizeVibeUrl).filter((url): url is string => !!url && url.length <= CHANNEL_TOPIC_MAX_LENGTH))]
      .slice(0, RECENTS_LIMIT);
  } catch {
    return [];
  }
}

export function rememberVoiceVibe(url: string): void {
  try {
    const normalized = normalizeVibeUrl(url);
    if (!normalized) return;
    localStorage.setItem(RECENTS_KEY, JSON.stringify(
      [normalized, ...readRecentVoiceVibes().filter((recent) => recent !== normalized)].slice(0, RECENTS_LIMIT),
    ));
  } catch {
    // A blocked/full local storage must not prevent setting a channel's vibe.
  }
}
