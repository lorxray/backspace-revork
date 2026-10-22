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
  updateFile: string;
  sha256: string;
  cacheDirectory: string;
  relaunch: boolean;
}

/** Start a detached, acknowledged helper before allowing the application to quit. */
export async function launchPortableReplacement(options: PortableInstall): Promise<{ configPath: string; pid: number }> {
  const target = path.resolve(options.target);
  if (!path.isAbsolute(options.target) || path.extname(target).toLowerCase() !== '.exe'
    || !/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error('Invalid portable update target');
  if (!(await fs.promises.lstat(target)).isFile()) throw new Error('Portable executable is not a regular file');
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
    await fs.promises.copyFile(options.updateFile, stage, fs.constants.COPYFILE_EXCL);
    if (await fileSha256(stage) !== options.sha256) throw new Error('Staged update checksum mismatch');
    // One previous version per portable, rather than a growing set of EXEs.
    await fs.promises.rm(backup, { force: true });
    const config = {
      Target: target, Stage: stage, Backup: backup, Sha256: options.sha256,
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
