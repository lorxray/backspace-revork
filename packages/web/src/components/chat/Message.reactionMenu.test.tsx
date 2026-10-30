import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel, MessageWithUser, Reaction, User } from '@backspace/shared';
import { useAuthStore } from '../../stores/authStore';
import { useChatStore } from '../../stores/chatStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { ContextMenuRenderer } from '../ui/ContextMenuRenderer';
import { Message } from './Message';

// An open socket: every send is taken.
vi.mock('../../hooks/useWebSocket', () => ({ wsSend: vi.fn(() => true), wsSendAll: vi.fn() }));
// The picker as a single choice: picking 👍. It says which layout it was
// asked for: the full-width mobile one or the fixed desktop box.
vi.mock('./EmojiPicker', () => ({
  EmojiPicker: ({ onEmojiSelect, mobile = false }: { onEmojiSelect: (emoji: { native: string }) => void; mobile?: boolean }) => (
    <button type="button" data-testid="emoji-picker" data-mobile={String(mobile)} onClick={() => onEmojiSelect({ native: '👍' })}>pick</button>
  ),
}));
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { wsSend } from '../../hooks/useWebSocket';

/**
 * #393, the menu path: a reaction picked in the message menu (the long-press
 * sheet on mobile, the right-click menu on desktop) closes the menu, as the
 * emoji picker does, and is never sent as a second add for a reaction the
 * user already holds. The menu's "+" opens the picker, also on mobile where
 * the message has no hover bar to hang it off.
 */

function makeUser(id: string, username: string): User {
  return {
    id, username, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const me = makeUser('me', 'alice');
const bob = makeUser('bob', 'bob');
const dm = { id: 'dm-1', ownerId: 'me', name: null, createdAt: 1, members: [me, bob], lastMessage: null } as unknown as DmChannel;

const message: MessageWithUser = {
  id: 'm-1',
  channelId: '',
  dmChannelId: dm.id,
  userId: bob.id,
  replyToId: null,
  content: 'hello',
  editedAt: null,
  createdAt: 1,
  user: bob,
  attachments: [],
  embeds: [],
  reactions: [],
} as MessageWithUser;

function ownReaction(): Reaction {
  return { id: 'r-1', messageId: message.id, userId: me.id, emoji: '👍', createdAt: 2, user: me };
}

function sent(type: 'reaction_add' | 'reaction_remove'): unknown[] {
  return vi.mocked(wsSend).mock.calls.filter(([event]) => (event as { type: string }).type === type);
}

function openMenu(): void {
  fireEvent.contextMenu(document.getElementById(`msg-${message.id}`)!);
}

function renderMessage(): void {
  render(
    <>
      <Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />
      <ContextMenuRenderer />
    </>,
  );
}

beforeEach(() => {
  vi.mocked(wsSend).mockClear();
  useAuthStore.setState({ user: me, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [dm], channelOriginMap: new Map([[dm.id, '']]) });
  useChatStore.setState({ messages: new Map([[dm.id, [message]]]), detachedChannels: new Map(), reactionAddsInFlight: new Map() });
});

afterEach(() => {
  act(() => useContextMenuStore.getState().close());
  useUIStore.setState({ isMobile: false });
  useAuthStore.setState({ user: null, myRowIds: new Map() });
  useSpaceStore.setState({ dmChannels: [], channelOriginMap: new Map() });
  useChatStore.setState({ messages: new Map(), reactionAddsInFlight: new Map() });
});

describe.each([
  ['the mobile long-press sheet', true],
  ['the desktop context menu', false],
])('a quick reaction in %s', (_label, isMobile) => {
  beforeEach(() => {
    useUIStore.setState({ isMobile });
  });

  it('sends one add and closes the menu', () => {
    renderMessage();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toEqual([[{ type: 'reaction_add', messageId: message.id, emoji: '👍' }, '']]);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('sends nothing for a second tap while the add is in flight, neither an add nor a remove', () => {
    renderMessage();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    // No answer yet: no pill shows the reaction, so the second tap is an add.
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toEqual([]);
  });

  it('reads the reactions the store holds when tapped, not the ones it held when the menu opened', () => {
    renderMessage();
    openMenu();
    // The user's reaction arrives while the menu is open (added from another
    // device, say); the menu's items were built before it.
    act(() => useChatStore.getState().onReactionAdded(message.id, ownReaction()));
    fireEvent.click(screen.getByRole('button', { name: '👍' }));

    expect(sent('reaction_add')).toEqual([]);
    expect(sent('reaction_remove')).toHaveLength(1);
  });
});

describe.each([
  ['the mobile long-press sheet', true],
  ['the desktop context menu', false],
])('the "+" in %s', (_label, isMobile) => {
  beforeEach(() => {
    useUIStore.setState({ isMobile });
  });

  function openPickerFromMenu(): void {
    openMenu();
    const plus = screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction');
    fireEvent.click(plus!);
  }

  it('closes the menu and opens the picker', () => {
    renderMessage();
    openPickerFromMenu();
    expect(useContextMenuStore.getState().menu).toBeNull();
    expect(screen.getByTestId('emoji-picker')).toBeTruthy();
  });

  it('sends one add for a picked emoji and closes the picker', () => {
    renderMessage();
    openPickerFromMenu();
    fireEvent.click(screen.getByTestId('emoji-picker'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });

  it('sends nothing for an emoji the user already reacted with, and closes the picker', () => {
    useChatStore.setState({ messages: new Map([[dm.id, [{ ...message, reactions: [ownReaction()] }]]]) });
    renderMessage();
    openPickerFromMenu();
    fireEvent.click(screen.getByTestId('emoji-picker'));
    expect(sent('reaction_add')).toEqual([]);
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });
});

describe('the picker the mobile long-press sheet opens', () => {
  const innerWidth = window.innerWidth;

  beforeEach(() => {
    useUIStore.setState({ isMobile: true });
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  function openPickerFromSheet(): void {
    openMenu();
    const plus = screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction');
    fireEvent.click(plus!);
  }

  // A bottom sheet as wide as the viewport, never a box positioned against
  // the message row: nothing in it depends on where the message sits or on
  // the viewport's width, so it cannot run off the side or the bottom.
  it.each([360, 375])('is a full-width bottom sheet with the mobile picker at %i px', (width) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    renderMessage();
    openPickerFromSheet();

    const sheet = screen.getByRole('dialog', { name: 'Add reaction' });
    expect(sheet.className).toContain('fixed');
    expect(sheet.className).toContain('left-0');
    expect(sheet.className).toContain('right-0');
    expect(sheet.style.left).toBe('');
    expect(sheet.style.top).toBe('');
    expect(sheet.style.width).toBe('');
    expect(sheet.style.bottom).toBe('var(--keyboard-inset)');
    expect(screen.getByTestId('emoji-picker').dataset.mobile).toBe('true');
    expect(screen.getByTestId('picker-sheet-backdrop')).toBeTruthy();
  });

  it.each([
    ['a tap', 'touchStart'],
    ['a click', 'mouseDown'],
  ] as const)('closes on %s on the backdrop, sending nothing', (_label, event) => {
    renderMessage();
    openPickerFromSheet();
    fireEvent[event](screen.getByTestId('picker-sheet-backdrop'));
    expect(screen.queryByRole('dialog', { name: 'Add reaction' })).toBeNull();
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
    expect(sent('reaction_add')).toEqual([]);
  });

  it('stays open for a tap inside the sheet', () => {
    renderMessage();
    openPickerFromSheet();
    fireEvent.mouseDown(screen.getByRole('dialog', { name: 'Add reaction' }));
    fireEvent.touchStart(screen.getByRole('dialog', { name: 'Add reaction' }));
    expect(screen.getByTestId('emoji-picker')).toBeTruthy();
  });

  it('closes on Escape', () => {
    renderMessage();
    openPickerFromSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });
});

describe('the picker the desktop context menu opens', () => {
  it('is the popover with the desktop picker, not a sheet', () => {
    renderMessage();
    openMenu();
    const plus = screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction');
    fireEvent.click(plus!);
    // The desktop popover is now labelled too, but is not a modal sheet.
    expect(screen.getByRole('dialog', { name: 'Add reaction' })).not.toHaveAttribute('aria-modal', 'true');
    expect(screen.queryByTestId('picker-sheet-backdrop')).toBeNull();
    expect(screen.getByTestId('emoji-picker').dataset.mobile).toBe('false');
  });
});

describe('a quick reaction in the desktop hover bar', () => {
  function quick(emoji: string): HTMLElement {
    fireEvent.mouseEnter(document.getElementById(`msg-${message.id}`)!);
    return screen.getByRole('button', { name: emoji });
  }

  it('sends one add for a double click, and no remove', () => {
    renderMessage();
    fireEvent.click(quick('👍'));
    fireEvent.click(quick('👍'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toEqual([]);
  });

  it('removes the reaction once the answer has stored it', () => {
    renderMessage();
    fireEvent.click(quick('👍'));
    act(() => useChatStore.getState().onReactionAdded(message.id, ownReaction()));
    fireEvent.click(quick('👍'));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(sent('reaction_remove')).toHaveLength(1);
  });
});

describe('the "+" in the desktop hover bar', () => {
  it('opens the picker and closes it again', () => {
    renderMessage();
    fireEvent.mouseEnter(document.getElementById(`msg-${message.id}`)!);
    const plus = () => screen.getAllByRole('button').find(b => b.getAttribute('title') === 'Add reaction')!;
    fireEvent.click(plus());
    expect(screen.getByTestId('emoji-picker')).toBeTruthy();
    fireEvent.click(plus());
    expect(screen.queryByTestId('emoji-picker')).toBeNull();
  });
});


describe('message action menu and text selection', () => {
  const actions = () => screen.queryAllByRole('button', { name: 'Message actions' });
  const row = () => document.getElementById(`msg-${message.id}`)!;
  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event('selectionchange'));
  };

  afterEach(() => { act(clearSelection); });

  it('opens the complete existing menu from the compact button without a right click', () => {
    renderMessage();
    fireEvent.pointerDown(actions()[0]!, { button: 0 });
    expect(actions()).toHaveLength(1);
    fireEvent.click(actions()[0]!);
    expect(screen.getByRole('button', { name: 'Copy Text' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '👍' }));
    expect(sent('reaction_add')).toHaveLength(1);
    expect(useContextMenuStore.getState().menu).toBeNull();
  });

  it('hides actions before dragging selects any characters and restores them on pointer release', () => {
    renderMessage();
    fireEvent.mouseEnter(row());
    expect(screen.getByRole('button', { name: '👍' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByText('hello'), { button: 0 });
    expect(actions()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: '👍' })).toBeNull();
    fireEvent.pointerUp(document.body, { button: 0 });
    expect(actions()).toHaveLength(1);
  });

  it('keeps actions hidden across messages after a drag until the selection is cleared', () => {
    const second = { ...message, id: 'm-2', content: 'another message' };
    render(<>
      <Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />
      <Message message={second} isCompact={false} isFirstInGroup={false} previousMessageId={message.id} />
    </>);
    const start = screen.getByText('hello');
    const end = screen.getByText('another message');
    fireEvent.pointerDown(start, { button: 0 });
    act(() => {
      const range = document.createRange();
      range.setStart(start.firstChild!, 0);
      range.setEnd(end.firstChild!, end.textContent!.length);
      window.getSelection()!.addRange(range);
      fireEvent(document, new Event('selectionchange'));
    });
    fireEvent.pointerUp(end, { button: 0 });
    expect(actions()).toHaveLength(0);
    fireEvent.mouseEnter(document.getElementById('msg-m-2')!);
    expect(screen.queryByRole('button', { name: '👍' })).toBeNull();
    expect(window.getSelection()!.toString()).toContain('another message');
    act(clearSelection);
    expect(actions()).toHaveLength(2);
  });

  it('suppresses keyboard-created selections but leaves unrelated text selections alone', () => {
    render(<>
      <Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />
      <p>outside text</p>
    </>);
    act(() => {
      window.getSelection()!.selectAllChildren(screen.getByText('outside text'));
      fireEvent(document, new Event('selectionchange'));
    });
    expect(actions()).toHaveLength(1);
    act(() => {
      window.getSelection()!.selectAllChildren(screen.getByText('hello'));
      fireEvent(document, new Event('selectionchange'));
    });
    expect(actions()).toHaveLength(0);
    act(clearSelection);
    expect(actions()).toHaveLength(1);
  });

  it('hides actions when a selection encloses rows but both endpoints are outside them', () => {
    render(<section data-testid="selection-host">
      <p>before messages</p>
      <Message message={message} isCompact={false} isFirstInGroup previousMessageId={null} />
      <p>after messages</p>
    </section>);
    act(() => {
      window.getSelection()!.selectAllChildren(screen.getByTestId('selection-host'));
      fireEvent(document, new Event('selectionchange'));
    });
    expect(actions()).toHaveLength(0);
    act(clearSelection);
    expect(actions()).toHaveLength(1);
  });

  it('preserves the selected-text copy action on right click', () => {
    renderMessage();
    act(() => {
      window.getSelection()!.selectAllChildren(screen.getByText('hello'));
      fireEvent(document, new Event('selectionchange'));
    });
    openMenu();
    const items = useContextMenuStore.getState().menu!.items;
    expect(items.find(item => item.key === 'copy-selected')?.hidden).toBe(false);
    const copy = items.find(item => item.key === 'copy-selected');
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      if (copy?.type !== 'action') throw new Error('Missing selected text copy action');
      copy.onClick();
      expect(writeText).toHaveBeenCalledWith('hello');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
