import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, DmChannel, Embed, MessageWithUser, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { openImageAnimation } from '../../utils/imageAnimation';
import * as messageMenu from './messageMenuItems';
import { Message } from './Message';

vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(), wsSendAll: vi.fn() }));
vi.mock('../../audio/AudioManager', () => ({ AudioManager: { getInstance: () => ({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) } }));
vi.mock('../../utils/imageAnimation', () => ({ supportsImageAnimation: () => true, openImageAnimation: vi.fn() }));
const play = vi.fn();
const pause = vi.fn();
const me: User = {
  id: 'me', username: 'alice', displayName: null, avatar: null, banner: null, accentColor: null,
  avatarColor: null, bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
  homeInstance: null, homeUserId: null, replicatedInstances: [],
};
const dm = { id: 'dm-gif', ownerId: me.id, members: [me], name: null, createdAt: 1, lastMessage: null } as unknown as DmChannel;
const base: MessageWithUser = {
  id: 'gif-message', channelId: '', dmChannelId: dm.id, userId: me.id, replyToId: null,
  content: null, editedAt: null, createdAt: 1, user: me, attachments: [], embeds: [], reactions: [],
} as MessageWithUser;

beforeEach(() => {
  play.mockClear(); pause.mockClear();
  vi.mocked(openImageAnimation).mockImplementation(async (_src, _canvas, callbacks) => ({
    play: (loops) => { play(loops); callbacks.onPaint(); }, pause, dispose: vi.fn(),
  }));
  vi.spyOn(messageMenu, 'buildMessageMenuItems');
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, '']]) });
});
afterEach(() => {
  vi.restoreAllMocks();
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useContextMenuStore.getState().close();
});

describe('GIFs sent to chat', () => {
  it('uses three-loop playback and preserves image menu actions on the frozen canvas', async () => {
    const url = 'https://static.klipy.com/chat.gif';
    const { container } = render(<Message message={{ ...base, content: url }} isCompact={false} isFirstInGroup previousMessageId={null} />);
    const surface = container.querySelector<HTMLElement>('[data-image-source]')!;
    fireEvent.contextMenu(surface.querySelector('img')!);
    expect(messageMenu.buildMessageMenuItems).toHaveBeenLastCalledWith(expect.objectContaining({ imageUrl: url }));
    fireEvent.load(surface.querySelector('img')!);
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
    act(() => vi.mocked(openImageAnimation).mock.calls.at(-1)![2].onFinish());
    expect(surface).toHaveAttribute('data-animation-state', 'paused');
    fireEvent.contextMenu(surface.querySelector('canvas')!);
    expect(messageMenu.buildMessageMenuItems).toHaveBeenLastCalledWith(expect.objectContaining({ imageUrl: url }));
    fireEvent.mouseEnter(surface);
    expect(play).toHaveBeenLastCalledWith(0);
    fireEvent.mouseLeave(surface);
    expect(pause).toHaveBeenCalled();
  });

  it('plays an uploaded GIF from its original file and retains sticker collection on its canvas', async () => {
    const attachment: Attachment = { id: 'gif-file', messageId: base.id, filename: 'file.gif', originalName: 'cat.gif', mimetype: 'image/gif', size: 100, thumbnailFilename: 'static-thumb.webp', width: 200, height: 120, createdAt: 1 };
    const { container } = render(<Message message={{ ...base, attachments: [attachment] }} isCompact={false} isFirstInGroup previousMessageId={null} />);
    const surface = container.querySelector<HTMLElement>('[data-image-source]')!;
    expect(surface.querySelector('img')).toHaveAttribute('src', '/api/uploads/file.gif');
    fireEvent.load(surface.querySelector('img')!);
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
    fireEvent.contextMenu(surface.querySelector('canvas')!);
    expect(messageMenu.buildMessageMenuItems).toHaveBeenLastCalledWith(expect.objectContaining({
      imageUrl: new URL('/api/uploads/file.gif', window.location.href).href,
      stickerSource: '/api/uploads/file.gif', stickerName: 'cat',
    }));
  });

  it('controls GIF image embeds too', async () => {
    const embed: Embed = { id: 'gif-embed', messageId: base.id, dmMessageId: null, url: 'https://example.com/cat.gif', image: 'https://example.com/cat.gif', embedType: 'image', provider: null, title: 'Cat', description: null, embedUrl: null, width: 200, height: 120, color: null, createdAt: 1 };
    const { container } = render(<Message message={{ ...base, content: embed.url, embeds: [embed] }} isCompact={false} isFirstInGroup previousMessageId={null} />);
    fireEvent.load(container.querySelector('[data-image-source] img')!);
    await waitFor(() => expect(play).toHaveBeenCalledWith(3));
  });
});
