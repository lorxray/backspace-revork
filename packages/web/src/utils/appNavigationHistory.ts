export interface AppHistoryEntry { key: string; href: string }
export interface AppHistory { entries: AppHistoryEntry[]; index: number }

/** Keep only history observed in this renderer, never the instance picker or a previous document. */
export function updateAppHistory(history: AppHistory, action: 'PUSH' | 'REPLACE' | 'POP', entry: AppHistoryEntry, retainedEntries = Infinity): AppHistory {
  const current = history.entries[history.index]!;
  if (current.key === entry.key && current.href === entry.href) return history;
  if (current.key === entry.key || action === 'REPLACE') {
    return { entries: history.entries.map((item, index) => index === history.index ? entry : item), index: history.index };
  }
  if (action === 'POP') {
    const index = history.entries.findIndex(item => item.key === entry.key);
    if (index < 0) return { entries: [entry], index: 0 };
    return { entries: history.entries.map((item, i) => i === index ? entry : item), index };
  }
  // Chromium can discard old entries as its native history reaches capacity.
  const entries = [...history.entries.slice(0, history.index + 1), entry].slice(-Math.max(1, retainedEntries));
  return { entries, index: entries.length - 1 };
}

/** Skip repeat clicks on the same destination while retaining the real browser offsets. */
export function appHistoryOffset(history: AppHistory, direction: -1 | 1): number | null {
  const current = history.entries[history.index]!;
  for (let index = history.index + direction; index >= 0 && index < history.entries.length; index += direction) {
    if (history.entries[index]!.href !== current.href) return index - history.index;
  }
  return null;
}
