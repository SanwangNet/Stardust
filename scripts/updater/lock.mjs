import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

async function lockFile(dir, create) {
  if(process.platform!=='linux') throw new Error('LINUX_FLOCK_REQUIRED');
  const file=await open(join(dir,'update.lock'),constants.O_RDONLY | (create ? 0 : 0) | (constants.O_NOFOLLOW??0)).catch(async e=>{
    if(e.code==='ENOENT' && create){try{return await open(join(dir,'update.lock'),constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);}catch(createError){if(createError.code==='EEXIST')return open(join(dir,'update.lock'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));throw createError;}}
    throw e;
  });
  try {const st=await file.stat();if(!st.isFile() || st.nlink!==1 || st.uid!==process.getuid() || (st.mode&0o077)!==0)throw new Error('LOCK_FILE_UNSAFE');return file;}catch(e){await file.close();throw e;}
}

// flock owns the kernel lock while its helper lives; closing stdin also handles a dead coordinator.
// An interrupted persistent task blocks further writes even if descendants outlive this helper.
export async function acquireLock(dir) {
  const file=await lockFile(dir,true);
  const child=spawn('flock',['-n','-E','75','/proc/self/fd/3',process.execPath,'-e',"process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"],{stdio:['pipe','pipe','ignore',file.fd],windowsHide:true});
  try {
    await new Promise((resolve,reject)=>{
      let data='';const timer=setTimeout(()=>{child.kill();reject(new Error('LOCK_HELPER_TIMEOUT'));},5000);
      child.stdout.on('data',chunk=>{data+=chunk;if(data==='LOCKED\n'){clearTimeout(timer);resolve();}else if(data.length>64){clearTimeout(timer);reject(new Error('LOCK_HELPER_FAILED'));}});
      child.once('error',()=>{clearTimeout(timer);reject(new Error('LOCK_HELPER_FAILED'));});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error(code===75?'LOCK_BUSY':'LOCK_HELPER_FAILED'));});
    });
  } catch(e){child.kill();await file.close();throw e;}
  let released=false, alive=true;const lost=new AbortController();
  child.once('exit',()=>{alive=false;if(!released)lost.abort();});
  return {get alive(){return alive;},signal:lost.signal,async release(){if(released)return;released=true;const done=new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once('exit',resolve);});child.stdin.end();await done;await file.close();}};
}
export async function observeLock(dir) {
  let file;try{file=await lockFile(dir,false);}catch(e){if(e.code==='ENOENT')return 'not_held';if(e.message==='LINUX_FLOCK_REQUIRED')return 'unavailable';throw e;}
  try {const result=spawnSync('flock',['-n','-E','75','/proc/self/fd/3',process.execPath,'-e',''],{stdio:['ignore','ignore','ignore',file.fd],timeout:3000,windowsHide:true});if(result.status===0)return 'not_held';if(result.status===75)return 'held';return 'unavailable';}finally{await file.close();}
}
