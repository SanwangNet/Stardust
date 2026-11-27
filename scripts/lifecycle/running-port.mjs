import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Inspect the systemd main process's listening sockets, not the next-start config.
// Only the local health endpoint for the expected Stardust process is accepted.
export async function runningEndpoints() {
  const exec=promisify(execFile),env={ PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG:'C' };
  const {stdout}=await exec('/usr/bin/systemctl',['show','stardust.service','--property=MainPID,User'],{timeout:3000,env});
  const fields=Object.fromEntries(stdout.trim().split(/\r?\n/).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const pid=Number(fields.MainPID),user=fields.User;
  if(!Number.isSafeInteger(pid)||pid<1)throw new Error('SERVICE_NOT_RUNNING');
  try{return await endpointsForProcess(pid);}catch(e){
    if(!['EACCES','EPERM'].includes(e.code)||process.getuid?.()!==0||!user||! /^[a-z_][a-z0-9_-]{0,31}$/.test(user)||user==='root')throw e;
    // A container root may lack CAP_SYS_PTRACE. Read the same process as its
    // dedicated service user rather than requesting additional capabilities.
    const result=await exec('/usr/sbin/runuser',['-u',user,'--',process.execPath,fileURLToPath(import.meta.url),'--pid',String(pid)],{timeout:5000,maxBuffer:16384,env});
    const value=JSON.parse(result.stdout);
    if(!Array.isArray(value)||value.length>256||value.some(x=>!x||typeof x.host!=='string'||!/^(?:[0-9.]+|\[[0-9a-f:]+\])$/.test(x.host)||!Number.isInteger(x.port)||x.port<1||x.port>65535))throw new Error('SERVICE_ENDPOINT_INVALID');
    return value;
  }
}

export async function endpointsForProcess(pid) {
  const inodes = new Set();
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    try { const match = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`)); if (match) inodes.add(match[1]); } catch (e) { if(e.code==='EACCES'||e.code==='EPERM')throw e; /* Descriptor closed. */ }
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

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const pid=Number(process.argv[3]);
  if(process.argv.length!==4||process.argv[2]!=='--pid'||!Number.isSafeInteger(pid)||pid<1)process.exitCode=2;
  else try{console.log(JSON.stringify(await endpointsForProcess(pid)));}catch{console.error('PROCESS_ENDPOINT_UNAVAILABLE');process.exitCode=1;}
}
