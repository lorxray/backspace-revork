import { NavigationButtons } from './NavigationButtons';

export function DesktopTitleBar() {
  return (
    <header className="relative flex-shrink-0 bg-surface-base border-b border-border-hard titlebar-drag"
      data-testid="desktop-titlebar"
      style={{ height: 'var(--titlebar-inset)', borderBottomWidth: 'calc(1px / var(--interface-scale))' }}>
      <div className="absolute inset-y-0 flex items-center justify-start"
        style={{
          left: 'var(--titlebar-area-x)',
          width: 'var(--titlebar-area-width)',
        }}>
        <div style={{ zoom: 'calc(1 / var(--interface-scale))' }}>
          <NavigationButtons />
        </div>
      </div>
    </header>
  );
}
