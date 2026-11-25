#!/usr/bin/env node
import { buildSystemdWorker } from './prepare-core.mjs';

const [root,taskId,sha,branch,unit,timeoutText,...extra]=process.argv.slice(2);
try {
  if(extra.length||!root||!taskId||!sha||!branch||!unit||!timeoutText)throw new Error('WORKER_FORBIDDEN');
  await buildSystemdWorker({root,taskId,sha,branch,unit,timeout:Number(timeoutText)});
} catch(e) {
  // Never print subprocess output or arbitrary exception text.
  const known=['WORKER_FORBIDDEN','WORKER_DIRECTORY_INVALID'];
  console.error(known.includes(e?.message)?e.message:'BUILD_WORKER_FAILED');process.exitCode=1;
}
