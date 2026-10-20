'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifyBundle, writeManifest } = require('./webClientBundle.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-web-bundle-'));
  // The absolute directory was created by this test and never comes from input.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(path.join(directory, 'index.html'), '<script type="module" src="/assets/client.js"></script>');
  fs.writeFileSync(path.join(directory, 'assets/client.js'), 'console.log("bundled client");');
  return directory;
}

test('accepts a complete bundle and emits a deterministic content manifest', (t) => {
  const directory = fixture(t);
  writeManifest(directory, '1.0.0');
  const first = fs.readFileSync(path.join(directory, 'bundle-manifest.json'), 'utf8');
  assert.equal(verifyBundle(directory, '1.0.0'), 2);
  writeManifest(directory, '1.0.0');
  assert.equal(fs.readFileSync(path.join(directory, 'bundle-manifest.json'), 'utf8'), first);
});

test('refuses a missing bundle instead of shipping a remote-only desktop', (t) => {
  const directory = fixture(t);
  assert.throws(() => verifyBundle(directory, '1.0.0'), /Bundled web client is missing/);
});

test('refuses a bundle from another desktop version', (t) => {
  const directory = fixture(t);
  writeManifest(directory, '1.0.0');
  assert.throws(() => verifyBundle(directory, '1.0.1'), /does not match desktop/);
});

test('detects changed asset contents even when their size is unchanged', (t) => {
  const directory = fixture(t);
  writeManifest(directory, '1.0.0');
  const asset = path.join(directory, 'assets/client.js');
  fs.writeFileSync(asset, fs.readFileSync(asset, 'utf8').replace('client', 'broken'));
  assert.throws(() => verifyBundle(directory, '1.0.0'), /do not match its manifest/);
});

test('detects omitted files from the copied application resources', (t) => {
  const directory = fixture(t);
  fs.writeFileSync(path.join(directory, 'assets/client.css'), 'body {}');
  writeManifest(directory, '1.0.0');
  fs.unlinkSync(path.join(directory, 'assets/client.css'));
  assert.throws(() => verifyBundle(directory, '1.0.0'), /do not match its manifest/);
});

test('rejects an output tree without a runnable web entrypoint', (t) => {
  const directory = fixture(t);
  fs.unlinkSync(path.join(directory, 'index.html'));
  assert.throws(() => writeManifest(directory, '1.0.0'), /missing index.html/);
});
