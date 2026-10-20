'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const desktopDir = path.resolve(__dirname, '..');
const repositoryDir = path.resolve(desktopDir, '../..');
const bundleDir = path.join(desktopDir, 'dist', 'web-client');
const manifestName = 'bundle-manifest.json';

function bundleFiles(directory, prefix = '') {
  const files = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (relative === manifestName) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, bundleFiles(absolute, relative));
    else if (entry.isFile()) {
      const contents = fs.readFileSync(absolute);
      files[relative] = { bytes: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') };
    } else throw new Error(`Bundled web client contains a non-regular file: ${relative}`);
  }
  return files;
}

function assertEntrypoint(files) {
  if (!files['index.html']?.bytes || !Object.keys(files).some((file) => /^assets\/.+\.js$/.test(file))) {
    throw new Error('Bundled web client is missing index.html or its compiled JavaScript assets');
  }
}

function writeManifest(directory, version) {
  const files = bundleFiles(directory);
  assertEntrypoint(files);
  fs.writeFileSync(path.join(directory, manifestName), `${JSON.stringify({ version, files }, null, 2)}\n`);
}

function verifyBundle(directory, version = require('../package.json').version) {
  const manifestPath = path.join(directory, manifestName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundled web client is missing: ${manifestPath}. Run pnpm --filter @backspace/desktop build:web-client.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`Bundled web client version ${manifest.version} does not match desktop ${version}`);
  }
  const files = bundleFiles(directory);
  assertEntrypoint(files);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) {
    throw new Error('Bundled web client files do not match its manifest; rebuild the desktop web client');
  }
  return Object.keys(files).length;
}

function runPnpm(args) {
  // Reuse the exact pnpm that launched the build, including Flatpak's vendored
  // offline CLI. A direct electron-builder invocation can use Node's Corepack
  // shim without depending on a globally installed pnpm command.
  const inheritedCli = process.env.npm_execpath;
  const corepackCli = path.join(path.dirname(process.execPath), 'node_modules/corepack/dist/pnpm.js');
  const pnpmCli = inheritedCli && /pnpm[^/\\]*\.(?:c?js)$/i.test(inheritedCli) && fs.existsSync(inheritedCli)
    ? inheritedCli
    : fs.existsSync(corepackCli) ? corepackCli : null;
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, ...args], { cwd: repositoryDir, stdio: 'inherit' })
    : process.platform !== 'win32'
      ? spawnSync('pnpm', args, { cwd: repositoryDir, stdio: 'inherit' })
      : { error: new Error('Launch the desktop build with pnpm so its CLI is available to build the bundled web client') };
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Web client build failed (pnpm ${args.join(' ')}, exit ${result.status})`);
}

function buildWebClient() {
  const version = require('../package.json').version;
  const webVersion = require('../../web/package.json').version;
  if (version !== webVersion) throw new Error(`Desktop ${version} and web client ${webVersion} versions differ`);
  // Build into the desktop's ignored output directory rather than reusing the
  // server's web/dist. Never package an old build left by a previous checkout.
  runPnpm(['--filter', '@backspace/shared', 'build']);
  runPnpm(['--filter', '@backspace/web', 'build', '--outDir', bundleDir, '--emptyOutDir']);
  writeManifest(bundleDir, version);
  const count = verifyBundle(bundleDir, version);
  console.log(`[desktop] Bundled web client ${version}: ${count} verified files`);
}

module.exports = { buildWebClient, bundleDir, verifyBundle, writeManifest };

if (require.main === module) {
  try {
    if (process.argv[2] === '--verify') verifyBundle(bundleDir);
    else buildWebClient();
  } catch (error) {
    console.error(`[desktop] ${error.message}`);
    process.exitCode = 1;
  }
}
