'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('Windows portable replacement helper', { skip: process.platform !== 'win32' }, () => {
  let root, helper, good, fresh, bad;
  const children = new Set();
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'backspace-helper-test-'));
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compile = (source, output, references = []) => {
      const result = spawnSync(compiler, ['/nologo', '/target:winexe', ...references, `/out:${output}`, source], {
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(result.status, 0, String(result.error || result.stdout || result.stderr));
    };
    helper = path.join(root, 'replace.exe');
    compile(path.join(__dirname, '../resources/portable-update-helper.cs'), helper, ['/r:System.Runtime.Serialization.dll']);
    for (const code of [0, 1, 2]) {
      const source = path.join(root, `exit-${code}.cs`);
      const binary = path.join(root, `exit-${code}.exe`);
      fs.writeFileSync(source, `class SilentStub${code} { static int Main() { return ${code === 1 ? 1 : 0}; } }`);
      compile(source, binary);
    }
    good = path.join(root, 'exit-0.exe'); bad = path.join(root, 'exit-1.exe'); fresh = path.join(root, 'exit-2.exe');
  });
  after(() => {
    for (const child of children) child.kill();
    if (root) {
      assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('backspace-helper-test-'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  async function install({ renameOnly = false, customName = false, failLaunch = false, collision = false,
    lateCollision = false, tamperOriginal = false } = {}) {
    const directory = fs.mkdtempSync(path.join(root, 'Клиент & $ [test] '));
    const target = path.join(directory, customName ? 'Мой клиент.exe' : 'Backspace-1.11.16-portable-x64.exe');
    const destination = customName ? target : path.join(directory, 'Backspace-1.11.17-portable-x64.exe');
    const stage = path.join(directory, '.backspace-update-1234.new.exe');
    const backup = path.join(directory, '.backspace-update-5678.backup.exe');
    fs.copyFileSync(renameOnly && failLaunch ? bad : good, target);
    if (renameOnly) fs.writeFileSync(backup, 'older backup preserved');
    else fs.copyFileSync(failLaunch ? bad : fresh, stage);
    const originalHash = hash(target);
    const expectedHash = hash(renameOnly ? target : stage);
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    children.add(parent);
    const config = {
      Target: target, Destination: destination, RenameOnly: renameOnly,
      Stage: renameOnly ? null : stage, Backup: renameOnly ? null : backup,
      Sha256: expectedHash, OriginalSha256: originalHash, ParentPid: parent.pid,
      Relaunch: failLaunch, Ready: path.join(directory, 'ready'), Cancel: path.join(directory, 'cancel'),
      Result: path.join(directory, 'result.json'),
    };
    if (collision) fs.writeFileSync(destination, 'existing file');
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    const child = spawn(helper, [configPath], { windowsHide: true, stdio: 'ignore' });
    children.add(child);
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    const deadline = Date.now() + 12_000;
    while (!fs.existsSync(config.Ready) && !fs.existsSync(config.Result) && Date.now() < deadline) await pause(25);
    assert.ok(fs.existsSync(config.Ready) || fs.existsSync(config.Result), 'helper must acknowledge readiness or report validation failure');
    if (lateCollision) fs.writeFileSync(destination, 'existing file');
    if (tamperOriginal) fs.writeFileSync(target, 'changed after acknowledgement');
    parent.kill();
    while (!fs.existsSync(config.Result) && Date.now() < deadline) await pause(25);
    assert.ok(fs.existsSync(config.Result), 'helper result was not written');
    await exited;
    children.delete(child); children.delete(parent);
    const result = JSON.parse(fs.readFileSync(config.Result, 'utf8'));
    return { target, destination, stage, backup, originalHash, expectedHash, result };
  }

  it('replaces, renames and keeps the previous executable as a verified backup', async () => {
    const f = await install();
    assert.equal(f.result.success, true);
    assert.equal(f.result.executable, f.destination);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.existsSync(f.stage), false);
    assert.equal(hash(f.destination), f.expectedHash);
    assert.equal(hash(f.backup), f.originalHash);
  });
  it('preserves a custom executable name', async () => {
    const f = await install({ customName: true });
    assert.equal(f.result.success, true); assert.equal(hash(f.target), f.expectedHash);
    assert.equal(hash(f.backup), f.originalHash);
  });
  for (const mode of ['collision', 'lateCollision']) it(`preserves both executables on ${mode}`, async () => {
    const f = await install({ [mode]: true });
    assert.equal(f.result.success, false);
    assert.equal(hash(f.target), f.originalHash);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'existing file');
  });
  it('restores the old filename and original bytes if the renamed update fails to start', async () => {
    const f = await install({ failLaunch: true });
    assert.equal(f.result.success, false); assert.equal(f.result.rolledBack, true);
    assert.equal(fs.existsSync(f.destination), false); assert.equal(hash(f.target), f.originalHash);
  });
  it('renames an already installed legacy update without replacing its older backup', async () => {
    const f = await install({ renameOnly: true });
    assert.equal(f.result.success, true); assert.equal(hash(f.destination), f.originalHash);
    assert.equal(fs.existsSync(f.target), false);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), 'older backup preserved');
  });
  it('undoes a legacy rename when relaunch fails and retains the older backup', async () => {
    const f = await install({ renameOnly: true, failLaunch: true });
    assert.equal(f.result.success, false); assert.equal(f.result.rolledBack, true);
    assert.equal(hash(f.target), f.originalHash); assert.equal(fs.existsSync(f.destination), false);
    assert.equal(fs.readFileSync(f.backup, 'utf8'), 'older backup preserved');
  });
  it('refuses replacement if the original changes after acknowledgement', async () => {
    const f = await install({ tamperOriginal: true });
    assert.equal(f.result.success, false); assert.equal(f.result.rolledBack, false);
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'changed after acknowledgement');
    assert.equal(fs.existsSync(f.destination), false);
  });
});
