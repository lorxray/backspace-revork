import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NavigationButtons } from './NavigationButtons';

function Destinations() {
  const navigate = useNavigate();
  const location = useLocation();
  return <>
    <output data-testid="location">{location.pathname + location.search + location.hash}</output>
    <button onClick={() => navigate('/channels/space/general')}>Channel</button>
    <button onClick={() => navigate('/channels/@me/person')}>DM</button>
    <button onClick={() => navigate('/explore')}>Explore</button>
    <button onClick={() => navigate('/backspace', { replace: true })}>Replace</button>
    <button onClick={() => navigate(-1)}>Browser back</button>
    <button onClick={() => navigate('/channels/space/general?filter=unread#last')}>Filtered</button>
  </>;
}

function setup(entries = ['/channels/@me'], index = entries.length - 1) {
  render(<MemoryRouter initialEntries={entries} initialIndex={index}>
    <NavigationButtons /><Destinations />
  </MemoryRouter>);
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name, exact: true }));
const back = () => screen.getByRole('button', { name: 'Back', exact: true });
const forward = () => screen.getByRole('button', { name: 'Forward', exact: true });
const at = (path: string) => expect(screen.getByTestId('location').textContent).toBe(path);

describe('in-app navigation arrows', () => {
  it('starts disabled and never exposes history from before this interface mounted', () => {
    setup(['/instance-picker', '/channels/@me']);
    expect(back()).toBeDisabled();
    expect(forward()).toBeDisabled();
    click('Back');
    at('/channels/@me');
  });

  it('goes back and forward through channels, DMs and sections', () => {
    setup();
    click('Channel'); click('DM'); click('Explore');
    expect(back()).toBeEnabled(); expect(forward()).toBeDisabled();
    click('Back'); at('/channels/@me/person');
    click('Back'); at('/channels/space/general');
    click('Forward'); at('/channels/@me/person');
    click('Forward'); at('/explore');
    expect(forward()).toBeDisabled();
  });

  it('drops the old forward branch when a new destination is opened', () => {
    setup();
    click('Channel'); click('DM'); click('Back'); click('Explore');
    expect(forward()).toBeDisabled();
    click('Back'); at('/channels/space/general');
    click('Forward'); at('/explore');
  });

  it('treats route replacement as the same history position', () => {
    setup();
    click('Replace');
    expect(back()).toBeDisabled();
    click('Channel'); click('Replace');
    click('Back'); at('/backspace');
    // Two visits now resolve to the same URL, so no extra back/forward step is offered.
    expect(back()).toBeDisabled(); expect(forward()).toBeDisabled();
  });

  it('skips repeat visits to one destination with the correct browser offset', () => {
    setup();
    click('Channel'); click('Channel'); click('Channel');
    click('Back'); at('/channels/@me');
    expect(back()).toBeDisabled();
    click('Forward'); at('/channels/space/general');
    expect(forward()).toBeDisabled();
    click('DM'); click('Back'); at('/channels/space/general');
    click('Back'); at('/channels/@me');
  });

  it('tracks browser back and resets safely on a history entry it did not observe', () => {
    setup(['/outside', '/channels/@me']);
    click('Channel'); click('Browser back'); at('/channels/@me');
    expect(forward()).toBeEnabled();
    click('Browser back'); at('/outside');
    expect(back()).toBeDisabled(); expect(forward()).toBeDisabled();
  });

  it('supports Alt+Left and Alt+Right and blocks native back at the starting boundary', () => {
    setup();
    expect(fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true })).toBe(false);
    at('/channels/@me');
    click('Channel'); click('DM');
    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true }); at('/channels/space/general');
    fireEvent.keyDown(document, { key: 'ArrowRight', altKey: true }); at('/channels/@me/person');
    fireEvent.keyDown(document, { key: 'ArrowLeft', altKey: true, ctrlKey: true }); at('/channels/@me/person');
  });

  it('preserves query and hash destinations', () => {
    setup();
    click('Filtered');
    click('Back'); at('/channels/@me');
    click('Forward'); at('/channels/space/general?filter=unread#last');
  });

  it('disables back at the oldest entry retained by the native browser', async () => {
    const original = { state: window.history.state, url: window.location.href };
    const size = vi.spyOn(window.history, 'length', 'get').mockReturnValue(3);
    try {
      window.history.replaceState({ key: 'initial', idx: 0 }, '', '/channels/@me');
      render(<BrowserRouter><NavigationButtons /><Destinations /></BrowserRouter>);
      click('Channel'); click('DM'); click('Explore'); click('Channel'); click('DM');
      click('Back'); await waitFor(() => at('/channels/space/general'));
      click('Back'); await waitFor(() => at('/explore'));
      expect(back()).toBeDisabled();
      expect(forward()).toBeEnabled();
    } finally {
      size.mockRestore();
      window.history.replaceState(original.state, '', original.url);
    }
  });
});
