#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

// Preserve the existing module interface while keeping the CLI out of the
// dependency graph used by the coordinator and build worker.
export { prepareCandidate, buildSystemdWorker, inspectStagedArtifacts, runCommand } from './prepare-core.mjs';

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const {main}=await import('./update.mjs');
 await main(process.argv.slice(2),{legacyPrepare:true});
}
