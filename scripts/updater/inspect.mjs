#!/usr/bin/env node
// Read-only inventory; does not inspect file contents or initiate deployment.
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function inspect(root, service, execute = execFileSync) {
  if (!isAbsolute(root) || /[\x00-\x1f]/.test(root)) throw new Error('INVALID_ROOT');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(service) || service.length > 128) throw new Error('INVALID_SERVICE');
  const paths = {};
  for (const name of ['config.toml', '.env', 'env', 'data', 'apps/server/dist/main.js', 'apps/web/dist/index.html']) {
    try { const stat = lstatSync(join(root, name)); paths[name] = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'; }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error('PATH_CHECK_FAILED'); paths[name] = 'missing'; }
  }
  let systemd;
  try {
    const output = String(execute('systemctl', ['show', '--no-pager', '--property=Id,User,Group,WorkingDirectory,FragmentPath,ActiveState,SubState', '--', service], { encoding:'utf8', timeout:5000, stdio:['ignore','pipe','ignore'], env:{PATH:process.env.PATH ?? '/usr/bin:/bin', LANG:'C'} }));
    systemd = Object.fromEntries(output.trim().split(/\r?\n/).filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  } catch { systemd = { error:'SYSTEMD_UNAVAILABLE' }; }
  return { root, service, node:process.version, paths, systemd };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('USAGE: node scripts/updater/inspect.mjs ABSOLUTE_ROOT EXACT_SERVICE.service');
    console.log(JSON.stringify(inspect(process.argv[2],process.argv[3]),null,2));
  } catch (error) { console.error(error instanceof Error ? error.message : 'INSPECTION_FAILED'); process.exitCode=1; }
}
