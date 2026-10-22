'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function buildPortableUpdaterHelper() {
  if (process.platform !== 'win32') throw new Error('The Windows portable update helper must be compiled on Windows');
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const source = path.resolve(__dirname, '../resources/portable-update-helper.cs');
  const output = path.resolve(__dirname, '../dist/portable-update-helper.exe');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/r:System.Runtime.Serialization.dll', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Could not build portable update helper: ${result.error || result.stdout || result.stderr}`);
  console.log('[desktop] Built Windows portable update helper');
}
module.exports = { buildPortableUpdaterHelper };
if (require.main === module && process.platform === 'win32') buildPortableUpdaterHelper();
