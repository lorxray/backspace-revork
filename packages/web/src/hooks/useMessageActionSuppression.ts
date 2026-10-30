import { useSyncExternalStore } from 'react';

// One document subscription for the whole list, rather than several listeners
// per message. Suppress before the first selectionchange, when dragging starts.
const listeners = new Set<() => void>();
let suppressed = false;
let dragging = false;
let detach: (() => void) | undefined;

function inMessage(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return !!element?.closest('[data-message-row]');
}

function includesMessage(selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed) return false;
  if (inMessage(selection.anchorNode) || inMessage(selection.focusNode)) return true;
  // Select-all and ranges that start/end outside the list can enclose rows
  // while neither endpoint belongs to one. This slower path is uncommon.
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    const ancestor = range.commonAncestorContainer;
    const parent = ancestor instanceof Element || ancestor instanceof Document ? ancestor : ancestor.parentElement;
    if (parent && Array.from(parent.querySelectorAll('[data-message-row]')).some(row => range.intersectsNode(row))) return true;
  }
  return false;
}

function update(): void {
  const selected = includesMessage(window.getSelection());
  const next = dragging || selected;
  if (next === suppressed) return;
  suppressed = next;
  listeners.forEach((listener) => listener());
}

function attach(): () => void {
  const down = (event: PointerEvent) => {
    const target = event.target;
    dragging = event.button === 0 && target instanceof Element && inMessage(target)
      && !target.closest('button, input, textarea, select, [contenteditable="true"], [role="button"]');
    update();
  };
  const up = () => { dragging = false; update(); };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  document.addEventListener('selectionchange', update);
  window.addEventListener('blur', up);
  update();
  return () => {
    document.removeEventListener('pointerdown', down, true);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', up, true);
    document.removeEventListener('selectionchange', update);
    window.removeEventListener('blur', up);
    dragging = false;
    suppressed = false;
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) detach = attach();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { detach?.(); detach = undefined; }
  };
}

export function useMessageActionSuppression(): boolean {
  return useSyncExternalStore(subscribe, () => suppressed, () => false);
}
