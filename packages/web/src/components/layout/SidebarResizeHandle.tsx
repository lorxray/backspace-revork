import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { layoutPixels } from '../../platform/interfaceScale';
import { MIN_SIDEBAR_WIDTH } from '../../stores/sidebarWidthStore';

interface Props {
  width: number;
  maxWidth: number;
  setWidth: (width: number) => void;
  resetWidth: () => void;
}

export function SidebarResizeHandle({ width, maxWidth, setWidth, resetWidth }: Props) {
  const { t } = useTranslation('common');
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    pointerId: number; startX: number; startWidth: number; element: HTMLElement;
    cursor: string; userSelect: string;
  } | null>(null);

  const finishDrag = useCallback(() => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.body.style.cursor = active.cursor;
    document.body.style.userSelect = active.userSelect;
    if (active.element.hasPointerCapture?.(active.pointerId)) {
      active.element.releasePointerCapture(active.pointerId);
    }
    setDragging(false);
  }, []);

  useEffect(() => {
    window.addEventListener('blur', finishDrag);
    window.addEventListener('resize', finishDrag);
    return () => {
      window.removeEventListener('blur', finishDrag);
      window.removeEventListener('resize', finishDrag);
      finishDrag();
    };
  }, [finishDrag]);

  return (
    <div
      role="separator"
      aria-label={t('chrome.resizeSidebar')}
      aria-orientation="vertical"
      aria-controls="desktop-channel-sidebar"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title={t('chrome.resizeSidebarHint')}
      className={`absolute top-0 bottom-0 -right-[3px] z-[110] hidden desktop:block w-[7px] cursor-col-resize touch-none outline-none group ${dragging ? 'bg-accent-mint/20' : 'hover:bg-accent-mint/10 focus-visible:bg-accent-mint/20'}`}
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId, startX: event.clientX, startWidth: width, element: event.currentTarget,
          cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        setDragging(true);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        setWidth(active.startWidth + layoutPixels(event.clientX - active.startX));
      }}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(); }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag(); }}
      onLostPointerCapture={finishDrag}
      onDoubleClick={resetWidth}
      onKeyDown={event => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') setWidth(width - step);
        else if (event.key === 'ArrowRight') setWidth(width + step);
        else if (event.key === 'Home') setWidth(MIN_SIDEBAR_WIDTH);
        else if (event.key === 'End') setWidth(maxWidth);
        else return;
        event.preventDefault();
      }}
    >
      <span className={`absolute inset-y-0 left-[3px] w-px transition-colors ${dragging ? 'bg-accent-mint' : 'group-hover:bg-accent-mint/70 group-focus-visible:bg-accent-mint'}`} />
    </div>
  );
}
