export function isElectron(): boolean {
  return typeof window !== 'undefined' && typeof window.backspace !== 'undefined';
}

/** A bundled interface is updated by the desktop app rather than the instance. */
export function isBundledDesktopClient(): boolean {
  return typeof window !== 'undefined' && window.backspace?.bundledWebClient === true;
}

export const BUNDLED_CLIENT_SOURCE_URL = 'https://github.com/lorxray/backspace-revork';

export function isElectronMac(): boolean {
  return isElectron() && window.backspace?.platform === 'darwin';
}

export function getElectronAPI(): BackspaceElectronAPI | null {
  return window.backspace ?? null;
}
