import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StreamViewerQualityControls, type StreamViewerQualityChoice, type StreamViewerQualityOption } from './StreamViewerQualityControls';

const options: StreamViewerQualityOption[] = [
  { value: 'original', height: 1440, fps: 60, maxBitrate: 30_000_000 },
  { value: 'medium', height: 1440, fps: 60, maxBitrate: 15_000_000 },
  { value: 'economy', height: 1440, fps: 60, maxBitrate: 7_500_000 },
];

function ControlledQuality({ onChange = () => {} }: { onChange?: (quality: StreamViewerQualityChoice) => void }) {
  const [quality, setQuality] = useState<StreamViewerQualityChoice>('auto');
  return <StreamViewerQualityControls quality={quality} options={options} onQualityChange={(value) => { setQuality(value); onChange(value); }} />;
}

describe('StreamViewerQualityControls', () => {
  it('starts with Auto and shows the actual layer caps at the same resolution', async () => {
    const user = userEvent.setup();
    render(<ControlledQuality />);
    const trigger = screen.getByRole('button', { name: 'Quality: Auto' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Playback quality' });
    expect(within(menu).getByRole('menuitemradio', { name: /Auto/ })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: /Original/ })).toHaveTextContent('1440p 60fps · Up to 30,000');
    expect(within(menu).getByRole('menuitemradio', { name: /Medium/ })).toHaveTextContent('1440p 60fps · Up to 15,000');
    expect(within(menu).getByRole('menuitemradio', { name: /Economy/ })).toHaveTextContent('1440p 60fps · Up to 7,500');
  });

  it('changes only its viewer preference without triggering the surrounding tile', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const focusTile = vi.fn();
    const pointerDown = vi.fn();
    render(<div onClick={focusTile} onPointerDown={pointerDown}><ControlledQuality onChange={onChange} /></div>);

    await user.click(screen.getByRole('button', { name: 'Quality: Auto' }));
    await user.click(screen.getByRole('menuitemradio', { name: /Medium/ }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith('medium');
    expect(focusTile).not.toHaveBeenCalled();
    expect(pointerDown).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quality: Medium' })).toHaveFocus();
  });

  it('supports keyboard navigation and consumes Escape before the surrounding player', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const playerKeyDown = vi.fn();
    render(<div onKeyDown={playerKeyDown}><ControlledQuality onChange={onChange} /></div>);
    const trigger = screen.getByRole('button', { name: 'Quality: Auto' });
    trigger.focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveFocus();
    await user.keyboard('{End}{Enter}');
    expect(onChange).toHaveBeenCalledWith('economy');
    expect(screen.getByRole('button', { name: 'Quality: Economy' })).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: /Economy/ })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitemradio', { name: /Auto/ })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: /Economy/ })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(playerKeyDown).not.toHaveBeenCalled();
  });

  it('closes on touch/pointer outside or a second trigger click', async () => {
    const user = userEvent.setup();
    render(<><ControlledQuality /><button type="button">Outside</button></>);
    const trigger = screen.getByRole('button', { name: 'Quality: Auto' });
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }), { pointerType: 'touch' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('handles old or single-layer streams without inventing choices or bitrate caps', async () => {
    const user = userEvent.setup();
    render(<StreamViewerQualityControls quality="auto" options={[{ value: 'original' }]} onQualityChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Quality: Auto' }));
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(screen.getByRole('menuitemradio', { name: /Original/ })).toHaveTextContent('Source stream settings');
    expect(screen.getByText('This stream offers only original quality.')).toBeInTheDocument();
    expect(screen.queryByText(/Up to/)).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: /Medium/ })).not.toBeInTheDocument();
  });

  it('keeps original quality available while publication details are loading', async () => {
    const user = userEvent.setup();
    render(<StreamViewerQualityControls quality="original" options={[]} onQualityChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Quality: Original' }));
    expect(screen.getByRole('menuitemradio', { name: /Original/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  });

  it('keeps separate stream controls independent', async () => {
    const user = userEvent.setup();
    render(<><ControlledQuality /><ControlledQuality /></>);
    await user.click(screen.getAllByRole('button', { name: 'Quality: Auto' })[0]!);
    await user.click(screen.getByRole('menuitemradio', { name: /Medium/ }));
    expect(screen.getByRole('button', { name: 'Quality: Medium' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quality: Auto' })).toBeInTheDocument();
  });

  it('portals into the fullscreen player so the menu stays visible', async () => {
    const user = userEvent.setup();
    const fullscreen = document.createElement('div');
    document.body.appendChild(fullscreen);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen });
    try {
      render(<ControlledQuality />);
      await user.click(screen.getByRole('button', { name: 'Quality: Auto' }));
      expect(fullscreen).toContainElement(screen.getByRole('menu'));
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      fullscreen.remove();
    }
  });
});
