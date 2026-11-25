// Pure evidence assessment for a future coordinator. It performs no unit operations.
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const invocation=/^[a-f0-9]{32}$/;

/** Unit names are derived, never supplied by a caller as an arbitrary systemd unit. */
export function buildUnitName(root,taskId) {
  if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root||/[\x00-\x1f]/.test(root)||!uuid.test(taskId??''))throw new Error('INVALID_TASK_IDENTITY');
  const deployment=createHash('sha256').update(root).digest('hex').slice(0,16);
  return `stardust-build-${deployment}-${taskId}.service`;
}

/**
 * Intent must come from validated, trusted persistent state, not worker output.
 * An absent/unloaded unit never supplies the result or invocation evidence needed
 * to claim success. An observation is only a snapshot and grants no permission to
 * publish or stop anything.
 */
export function assessBuildEvidence(intent,observation) {
  let unit;try{unit=buildUnitName(intent?.root,intent?.taskId);}catch{return {status:'uncertain',reason:'INVALID_TASK_IDENTITY'};}
  if(!uuid.test(intent?.bootId??'')||!invocation.test(intent?.invocationId??''))return {status:'uncertain',reason:'IDENTITY_INCOMPLETE'};
  if(observation?.bootId!==intent.bootId)return {status:'uncertain',reason:'BOOT_CHANGED_OR_UNKNOWN'};
  if(observation.unit!==unit||observation.invocationId!==intent.invocationId)return {status:'uncertain',reason:'UNIT_IDENTITY_UNCONFIRMED'};
  if(observation.cgroupPath!==`/system.slice/${unit}`)return {status:'uncertain',reason:'CGROUP_IDENTITY_UNCONFIRMED'};
  const retained=observation.activeState==='active'&&observation.subState==='exited';
  if(observation.activeState==='active'&&!retained||observation.activeState==='activating'||observation.activeState==='deactivating'||observation.cgroupState==='populated')return {status:'running',reason:'UNIT_OR_CGROUP_ACTIVE'};
  if(!(['inactive','failed'].includes(observation.activeState)||retained)||!['empty','destroyed'].includes(observation.cgroupState))return {status:'uncertain',reason:'TERMINATION_UNCONFIRMED'};
  if(typeof observation.result!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(observation.result))return {status:'uncertain',reason:'RESULT_UNAVAILABLE'};
  if(observation.result!=='success')return {status:'failed',reason:'UNIT_RESULT_FAILED'};
  if(!(observation.activeState==='inactive'||retained)||!Number.isSafeInteger(observation.mainCode)||!Number.isSafeInteger(observation.mainStatus))return {status:'uncertain',reason:'RESULT_INCONSISTENT'};
  if(observation.mainCode!==1||observation.mainStatus!==0)return {status:'failed',reason:'MAIN_PROCESS_FAILED'};
  return {status:'succeeded',reason:'SERVICE_AND_CGROUP_COMPLETED'};
}
