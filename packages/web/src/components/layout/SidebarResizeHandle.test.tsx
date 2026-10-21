import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidebarWidth } from '../../hooks/useSidebarWidth';
import { useInterfaceScaleStore } from '../../stores/interfaceScaleStore';
import { normalizeSidebarWidth, useSidebarWidthStore } from '../../stores/sidebarWidthStore';
import { SidebarResizeHandle } from './SidebarResizeHandle';

function Sidebar() {
  const sidebar = useSidebarWidth();
  return <SidebarResizeHandle {...sidebar} />;
}

function pointer(target: Element, type: string, pointerId: number, clientX: number, button = 0) {
  fireEvent(target, new PointerEvent(type, { bubbles: true, pointerId, clientX, button }));
}

beforeEach(() => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1440);
  useInterfaceScaleStore.getState().setScale(100);
  useSidebarWidthStore.getState().setWidth(312);
});

afterEach(() => {
  cleanup();
  useInterfaceScaleStore.getState().setScale(100);
  vi.restoreAllMocks();
});

describe('left sidebar resizing', () => {
  it('persists the preferred width and validates restored values', async () => {
    useSidebarWidthStore.getState().setWidth(444);
    const saved = localStorage.getItem('backspace-sidebar-width')!;
    useSidebarWidthStore.getState().setWidth(312);
    localStorage.setItem('backspace-sidebar-width', saved);
    await useSidebarWidthStore.persist.rehydrate();
    render(<Sidebar />);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '444');

    localStorage.setItem('backspace-sidebar-width', JSON.stringify({ state: { width: 'invalid' }, version: 0 }));
    await act(async () => { await useSidebarWidthStore.persist.rehydrate(); });
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '312');
  });

  it.each([[0, 280], [9999, 520], [NaN, 312], [Infinity, 312], ['400', 312], [null, 312]])(
    'normalizes stored width %s to %i', (input, expected) => {
      expect(normalizeSidebarWidth(input)).toBe(expected);
    },
  );

  it('supports keyboard resizing, limits, and double-click reset', () => {
    render(<Sidebar />);
    const handle = screen.getByRole('separator', { name: 'Resize left sidebar' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '322');
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(handle).toHaveAttribute('aria-valuenow', '282');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '280');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '520');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '280');
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', '312');
  });

  it('clamps small desktop windows without losing a wider saved preference', () => {
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(768);
    useSidebarWidthStore.getState().setWidth(500);
    render(<Sidebar />);
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-valuemax', '368');
    expect(handle).toHaveAttribute('aria-valuenow', '368');
    expect(useSidebarWidthStore.getState().width).toBe(500);
    viewport.mockReturnValue(1200);
    fireEvent(window, new Event('resize'));
    expect(handle).toHaveAttribute('aria-valuenow', '500');

    act(() => { useInterfaceScaleStore.getState().setScale(150); });
    expect(handle).toHaveAttribute('aria-valuenow', '400');
    expect(useSidebarWidthStore.getState().width).toBe(500);
  });

  it('converts captured pointer deltas at interface scale, ignores other pointers, and restores styles', () => {
    useInterfaceScaleStore.getState().setScale(150);
    render(<Sidebar />);
    const handle = screen.getByRole('separator');
    const capture = vi.fn();
    const release = vi.fn();
    handle.setPointerCapture = capture;
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = release;
    document.body.style.cursor = 'crosshair';
    document.body.style.userSelect = 'text';

    pointer(handle, 'pointerdown', 1, 468);
    expect(capture).toHaveBeenCalledWith(1);
    expect(document.body.style.cursor).toBe('col-resize');
    pointer(handle, 'pointermove', 2, 528);
    expect(handle).toHaveAttribute('aria-valuenow', '312');
    pointer(handle, 'pointermove', 1, 528);
    expect(handle).toHaveAttribute('aria-valuenow', '352');
    pointer(handle, 'pointerup', 1, 528);
    expect(release).toHaveBeenCalledWith(1);
    expect(document.body.style.cursor).toBe('crosshair');
    expect(document.body.style.userSelect).toBe('text');
    pointer(handle, 'pointermove', 1, 700);
    expect(handle).toHaveAttribute('aria-valuenow', '352');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'resize', 'unmount'])(
    'cleans up an active drag on %s', reason => {
      const { unmount } = render(<Sidebar />);
      const handle = screen.getByRole('separator');
      handle.setPointerCapture = vi.fn();
      handle.hasPointerCapture = () => true;
      handle.releasePointerCapture = vi.fn();
      pointer(handle, 'pointerdown', 4, 312);
      if (reason === 'unmount') unmount();
      else if (reason === 'blur' || reason === 'resize') fireEvent(window, new Event(reason));
      else pointer(handle, reason, 4, 312);
      expect(document.body.style.cursor).toBe('');
      expect(document.body.style.userSelect).toBe('');
      pointer(handle, 'pointermove', 4, 500);
      expect(useSidebarWidthStore.getState().width).toBe(312);
    },
  );
});
