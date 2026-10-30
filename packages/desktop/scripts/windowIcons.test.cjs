'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyWindowIcons } = require('./windowIcons.cjs');
const packagerRequire = createRequire(require.resolve('electron-builder'));
const asar = createRequire(packagerRequire.resolve('app-builder-lib'))('@electron/asar');

async function fixture(t, icons) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-window-icons-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'app');
  fs.mkdirSync(path.join(source, 'build'), { recursive: true });
  for (const name of icons) fs.copyFileSync(path.join(__dirname, '../build', name), path.join(source, 'build', name));
  const archive = path.join(directory, 'app.asar');
  await asar.createPackage(source, archive);
  return archive;
}

test('accepts the real window icons inside the packaged ASAR', async t => {
  verifyWindowIcons(await fixture(t, ['icon.ico', 'icon.png']));
});

test('rejects an application that embeds an EXE icon but omits runtime window icons', async t => {
  const archive = await fixture(t, []);
  assert.throws(() => verifyWindowIcons(archive), /Packaged window icon is missing: build\/icon.ico/);
});

test('rejects truncated or replaced window artwork', async t => {
  const archive = await fixture(t, ['icon.ico', 'icon.png']);
  const source = path.join(path.dirname(archive), 'app');
  fs.writeFileSync(path.join(source, 'build/icon.png'), 'damaged');
  await asar.createPackage(source, archive);
  assert.throws(() => verifyWindowIcons(archive), /does not match.*build\/icon.png/);
});
