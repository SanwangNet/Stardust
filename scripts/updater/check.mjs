#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'https://github.com/SanwangNet/Stardust.git';
export function checkRemote(branch = 'main', current = null, execute = execFileSync) {
  // Refuse ambiguous or option-like refs; no user-supplied repository URL.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(branch) || branch.includes('//') || branch.endsWith('/')) throw new Error('INVALID_BRANCH');
  if (current !== null && !/^[0-9a-f]{40}$/.test(current)) throw new Error('INVALID_CURRENT_SHA');
  let output;
  try {
    output = String(execute('git', ['-c', 'credential.helper=', 'ls-remote', '--heads', '--', REPOSITORY, `refs/heads/${branch}`], {
      encoding:'utf8', timeout:15000, stdio:['ignore','pipe','ignore'],
      env:{ PATH:process.env.PATH ?? '', GIT_TERMINAL_PROMPT:'0', GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null' },
    }));
  } catch { throw new Error('REMOTE_CHECK_FAILED'); }
  const lines = output.trim().split(/\r?\n/);
  const match = lines.length === 1 && /^([0-9a-f]{40})\t([^\s]+)$/.exec(lines[0]);
  if (!match || match[2] !== `refs/heads/${branch}`) throw new Error('INVALID_REMOTE_RESPONSE');
  return { branch, current, target:match[1], status:current === null ? 'current_unknown' : current === match[1] ? 'no_update' : 'update_available' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { if (process.argv.length > 4) throw new Error('USAGE: node scripts/updater/check.mjs [branch] [current-sha]'); console.log(JSON.stringify(checkRemote(process.argv[2] ?? 'main',process.argv[3] ?? null),null,2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'REMOTE_CHECK_FAILED'); process.exitCode=1; }
}
