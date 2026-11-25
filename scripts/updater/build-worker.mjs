#!/usr/bin/env node
import { buildSystemdWorker } from './prepare-core.mjs';

const [root,taskId,sha,branch,unit,timeoutText,...extra]=process.argv.slice(2);
const controller=new AbortController();const cancel=()=>controller.abort();
process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
try {
  if(extra.length||!root||!taskId||!sha||!branch||!unit||!timeoutText)throw new Error('WORKER_FORBIDDEN');
  await buildSystemdWorker({root,taskId,sha,branch,unit,timeout:Number(timeoutText),signal:controller.signal});
} catch(e) {
  // Never print subprocess output or arbitrary exception text.
  const known=['WORKER_FORBIDDEN','WORKER_DIRECTORY_INVALID'];
  console.error(known.includes(e?.message)?e.message:'BUILD_WORKER_FAILED');process.exitCode=1;
} finally {process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);}
