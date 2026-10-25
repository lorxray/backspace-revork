import { beforeEach, describe, expect, it } from 'vitest';
import { CHANNEL_TOPIC_MAX_LENGTH, normalizeChannelTopic } from '@backspace/shared/src/constants';
import {
  normalizeVibeUrl, readRecentVoiceVibes, readVoiceChannelVibe, rememberVoiceVibe,
  topicWithoutVoiceChannelVibe, topicWithVoiceChannelVibe,
} from './voiceChannelVibe';

const GIF = 'https://media.tenor.com/example/cat.gif';

beforeEach(() => localStorage.clear());

describe('voice vibe channel storage', () => {
  it.each([null, 'Existing voice topic\nwith a second line'])('survives server topic normalization and restores %j', (original) => {
    const encoded = topicWithVoiceChannelVibe(original, GIF)!;
    expect(readVoiceChannelVibe(normalizeChannelTopic(encoded))?.url).toBe(GIF);
    const replaced = topicWithVoiceChannelVibe(encoded, 'https://static.klipy.com/other.gif')!;
    expect(topicWithoutVoiceChannelVibe(replaced)).toBe(original);
  });

  it('does not interpret ordinary topics, malformed metadata or unsafe URLs as images', () => {
    for (const topic of [GIF, 'normal topic', 'backspace:voice-vibe:v1:{',
      'backspace:voice-vibe:v1:{"url":"javascript:alert(1)","topic":null}',
      'backspace:voice-vibe:v1:{"url":"https://example.com/a.gif","topic":4}']) {
      expect(readVoiceChannelVibe(topic)).toBeNull();
      expect(topicWithoutVoiceChannelVibe(topic)).toBe(topic);
    }
  });

  it('refuses an oversized update without truncating the previous topic', () => {
    const topic = 'a'.repeat(CHANNEL_TOPIC_MAX_LENGTH);
    expect(topicWithVoiceChannelVibe(topic, GIF)).toBeNull();
    expect(topicWithoutVoiceChannelVibe(topic)).toBe(topic);
  });

  it.each(['javascript:alert(1)', 'data:image/gif;base64,AAAA', 'file:///C:/cat.gif',
    'http://example.com/a.gif', 'https://user:secret@example.com/a.gif', 'https://example.com/a\nb.gif'])('rejects %s', (url) => {
    expect(normalizeVibeUrl(url)).toBeNull();
    expect(topicWithVoiceChannelVibe(null, url)).toBeNull();
  });
});

describe('recent voice vibes', () => {
  it('keeps nine unique images, with the most recently used first', () => {
    for (let i = 0; i < 12; i++) rememberVoiceVibe(`https://example.com/${i}.gif`);
    rememberVoiceVibe('https://example.com/7.gif');
    expect(readRecentVoiceVibes()).toHaveLength(9);
    expect(readRecentVoiceVibes()[0]).toBe('https://example.com/7.gif');
    expect(new Set(readRecentVoiceVibes()).size).toBe(9);
  });

  it('tolerates corrupt storage and filters unsafe values', () => {
    localStorage.setItem('backspace.voice-vibe-recents.v1', '{');
    expect(readRecentVoiceVibes()).toEqual([]);
    localStorage.setItem('backspace.voice-vibe-recents.v1', JSON.stringify([false, 'javascript:bad', GIF, GIF]));
    expect(readRecentVoiceVibes()).toEqual([GIF]);
  });
});
