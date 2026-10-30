'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

// Use the same ASAR reader as the installed packager, including with pnpm's
// isolated dependencies; the hook runs in Node, where fs cannot read ASAR paths.
const packagerRequire = createRequire(require.resolve('electron-builder'));
const asar = createRequire(packagerRequire.resolve('app-builder-lib'))('@electron/asar');

function verifyWindowIcons(archive) {
  asar.uncache(archive);
  for (const name of ['icon.ico', 'icon.png']) {
    const relative = `build/${name}`;
    let actual;
    try { actual = asar.extractFile(archive, relative); }
    catch { throw new Error(`Packaged window icon is missing: ${relative}`); }
    const expected = fs.readFileSync(path.join(__dirname, '../build', name));
    if (!actual.length || !actual.equals(expected)) {
      throw new Error(`Packaged window icon does not match the application artwork: ${relative}`);
    }
  }
}

module.exports = { verifyWindowIcons };
