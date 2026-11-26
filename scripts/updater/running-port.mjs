import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

// Inspect the systemd main process's listening sockets, not the next-start config.
// Only the local health endpoint for the expected Stardust process is accepted.
export async function runningEndpoints() {
  const { stdout } = await promisify(execFile)('systemctl', ['show', 'stardust.service', '--property=MainPID', '--value'], { timeout: 3000, env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
  const pid = Number(stdout.trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('SERVICE_NOT_RUNNING');
  return endpointsForProcess(pid);
}

export async function endpointsForProcess(pid) {
  const inodes = new Set();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`)); if (match) inodes.add(match[1]); } catch { /* Descriptor closed. */ }
  }
  const endpoints = new Map();
  for (const name of ['tcp', 'tcp6']) {
    let table; try { table = await readFile(`/proc/${pid}/net/${name}`, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && inodes.has(fields[9])) {
        const [raw, hexPort] = fields[1].split(':'); const port = parseInt(hexPort, 16);
        if (!/^[0-9A-F]{8}$/.test(raw) && !/^[0-9A-F]{32}$/.test(raw)) continue;
        const bytes = raw.match(/.{8}/g).flatMap(word => word.match(/../g).reverse().map(byte => parseInt(byte, 16)));
        const host = name === 'tcp' ? (bytes.every(byte => byte === 0) ? '127.0.0.1' : bytes.join('.'))
          : `[${bytes.every(byte => byte === 0) ? '::1' : Array.from({ length: 8 }, (_, i) => ((bytes[i*2] << 8) | bytes[i*2+1]).toString(16)).join(':')}]`;
        if (port > 0 && port <= 65535) endpoints.set(`${host}:${port}`, { host, port });
      }
    }
  }
  return [...endpoints.values()];
}
