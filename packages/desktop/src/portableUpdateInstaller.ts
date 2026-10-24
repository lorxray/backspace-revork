import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export interface PortableInstall {
  target: string;
  version: string;
  updateFile: string;
  sha256: string;
  cacheDirectory: string;
  relaunch: boolean;
}

/** Preserve custom names; advance the version in our standard portable name. */
export function portableInstallDestination(target: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid portable update version');
  return /^Backspace-\d+\.\d+\.\d+-portable-x64\.exe$/i.test(path.basename(target))
    ? path.join(path.dirname(target), `Backspace-${version}-portable-x64.exe`) : target;
}

/** Start a detached, acknowledged helper before allowing the application to quit. */
export async function launchPortableReplacement(options: PortableInstall): Promise<{ configPath: string; pid: number }> {
  return launchPortableHelper(options, false);
}

async function launchPortableHelper(options: PortableInstall, renameOnly: boolean): Promise<{ configPath: string; pid: number }> {
  const target = path.resolve(options.target);
  const destination = portableInstallDestination(target, options.version);
  if (!path.isAbsolute(options.target) || path.extname(target).toLowerCase() !== '.exe'
    || !/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error('Invalid portable update target');
  if (!(await fs.promises.lstat(target)).isFile()) throw new Error('Portable executable is not a regular file');
  if (destination.toLowerCase() !== target.toLowerCase() && fs.existsSync(destination)) {
    throw new Error('An executable with the new version name already exists; both files were preserved');
  }
  if (await fileSha256(options.updateFile) !== options.sha256) throw new Error('Downloaded update checksum changed');
  const id = randomUUID();
  const directory = path.dirname(target);
  const stage = path.join(directory, `.backspace-update-${id}.new.exe`);
  const targetId = createHash('sha256').update(target.toLowerCase()).digest('hex').slice(0, 16);
  const backup = path.join(directory, `.backspace-update-${targetId}.backup.exe`);
  const helperDirectory = path.join(options.cacheDirectory, `install-${id}`);
  await fs.promises.mkdir(helperDirectory, { recursive: true });
  const helperPath = path.join(helperDirectory, 'replace.exe');
  const configPath = path.join(helperDirectory, 'config.json');
  const ready = path.join(helperDirectory, 'ready');
  const cancel = path.join(helperDirectory, 'cancel');
  try {
    if (!renameOnly) {
      await fs.promises.copyFile(options.updateFile, stage, fs.constants.COPYFILE_EXCL);
      if (await fileSha256(stage) !== options.sha256) throw new Error('Staged update checksum mismatch');
      // One previous version per portable, rather than a growing set of EXEs.
      await fs.promises.rm(backup, { force: true });
    }
    const config = {
      Target: target, Destination: destination, RenameOnly: renameOnly,
      Stage: renameOnly ? null : stage, Backup: renameOnly ? null : backup, Sha256: options.sha256,
      OriginalSha256: await fileSha256(target), ParentPid: process.pid,
      Relaunch: options.relaunch, Ready: ready, Cancel: cancel, Result: path.join(helperDirectory, 'result.json'),
    };
    // readFile works for both packaged ASAR resources and development files.
    await fs.promises.writeFile(helperPath, await fs.promises.readFile(path.join(__dirname, 'portable-update-helper.exe')), { flag: 'wx', mode: 0o700 });
    await fs.promises.writeFile(configPath, JSON.stringify(config), 'utf8');
    const child = spawn(helperPath, [configPath], { detached: true, windowsHide: true, stdio: 'ignore' });
    let failure: Error | null = null;
    child.on('error', error => { failure = error; });
    child.on('exit', code => { failure = new Error(`Portable update helper exited (${code})`); });
    child.unref();
    for (let attempt = 0; attempt < 160; attempt++) {
      if (failure) throw failure;
      if (fs.existsSync(ready)) {
        if (!child.pid) throw new Error('Portable update helper has no process ID');
        child.unref();
        return { configPath, pid: child.pid };
      }
      await delay(50);
    }
    throw new Error('Portable update helper did not become ready; application remains open');
  } catch (error) {
    await fs.promises.writeFile(cancel, 'cancelled').catch(() => {});
    await fs.promises.rm(stage, { force: true }).catch(() => {});
    throw error;
  }
}

/** Finish a rename missed by the updater in <=1.11.16, once per verified install.
 * This runs before opening the UI, never during a call or an ordinary update check.
 */
export async function repairLegacyPortableName(
  options: Pick<PortableInstall, 'target' | 'version' | 'cacheDirectory'>,
  launch = (install: PortableInstall) => launchPortableHelper(install, true),
): Promise<boolean> {
  const target = path.resolve(options.target);
  if (portableInstallDestination(target, options.version).toLowerCase() === target.toLowerCase()) return false;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(options.cacheDirectory, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^install-[a-f0-9-]{36}$/.test(entry.name)) continue;
    const directory = path.join(options.cacheDirectory, entry.name);
    try {
      const config = JSON.parse(await fs.promises.readFile(path.join(directory, 'config.json'), 'utf8'));
      if (config.Destination || typeof config.Target !== 'string'
        || path.resolve(config.Target).toLowerCase() !== target.toLowerCase()
        || typeof config.Sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(config.Sha256)
        || await fileSha256(target) !== config.Sha256) continue;
      // The old helper records success after its 3-second launch check. The
      // replacement may already be starting while that check is still running.
      const resultPath = path.join(directory, 'result.json');
      for (let attempt = 0; attempt < 25 && !fs.existsSync(resultPath); attempt++) await delay(200);
      const result = JSON.parse(await fs.promises.readFile(resultPath, 'utf8'));
      if (result.success !== true) continue;
      // Claim before restarting. A failed rename must never cause a restart loop.
      await fs.promises.writeFile(path.join(directory, 'filename-repair-attempted'), options.version, { flag: 'wx' });
      await launch({ ...options, target, updateFile: target, sha256: config.Sha256, relaunch: true });
      return true;
    } catch { /* A failed repair leaves the current executable usable. */ }
  }
  return false;
}
