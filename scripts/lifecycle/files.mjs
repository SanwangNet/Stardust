import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const shaPattern=/^[a-f0-9]{40}$/;
export const digestPattern=/^[a-f0-9]{64}$/;
export const idPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const archiveLimit=2*1024**3;
export const missing=error=>error.code==='ENOENT';
export async function openFile(path,max,owner){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await file.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.size>max||(owner!==undefined&&stat.uid!==owner))throw Error('UNSAFE_FILE');
    return file;
  } catch(error){await file.close();throw error;}
}
export async function readJson(path,max=32768,owner){
  const file=await openFile(path,max,owner);
  try {
    const bytes=Buffer.alloc(max+1);
    const {bytesRead}=await file.read(bytes,0,max+1,0);
    if(bytesRead>max)throw Error('FILE_TOO_LARGE');
    return JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
  } finally {await file.close();}
}
export async function syncDirectory(path){
  if(process.platform==='win32')return;
  const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);
  try{await file.sync();}finally{await file.close();}
}
export async function atomicJson(path,value,mode=0o640,gid){
  const temp=path+'.'+randomUUID()+'.tmp',file=await open(temp,'wx',mode);
  try {
    try{if(gid!==undefined)await file.chown(0,gid);await file.chmod(mode);await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}
    finally{await file.close();}
    await rename(temp,path);
    await syncDirectory(dirname(path));
  } finally {await unlink(temp).catch(error=>{if(!missing(error))throw error;});}
}
export async function capture(input,path,limit=archiveLimit){
  let size=0;
  const hash=createHash('sha256');
  await pipeline(input,new Transform({transform(chunk,_encoding,done){
    size+=chunk.length;
    if(size>limit){done(Error('FILE_TOO_LARGE'));return;}
    hash.update(chunk);done(null,chunk);
  }}),createWriteStream(path,{flags:'wx',mode:0o600}));
  return {size,sha256:hash.digest('hex')};
}
export async function digest(path){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk);
  return hash.digest('hex');
}
const repo='SanwangNet/Stardust';
const api='https://api.github.com/repos/'+repo;
export const packageName='stardust-linux-x64.tar.gz';
export function version(value){
  if(!value || value.format!==1 || typeof value.sha!=='string' || !shaPattern.test(value.sha) || !Number.isSafeInteger(value.sequence)||value.sequence<1||
    typeof value.version!=='string'||!/^[0-9A-Za-z.+-]{1,80}$/.test(value.version)||
    !Number.isSafeInteger(value.dataFormat)||value.dataFormat<1||value.platform!=='linux-x64'||value.node!==24 ||
    !Number.isSafeInteger(value.manager)||value.manager<1)throw Error('INVALID_RELEASE');
  return {format:1,sha:value.sha,sequence:value.sequence,version:value.version,dataFormat:value.dataFormat,platform:value.platform,node:value.node,manager:value.manager};
}
export function releases(token,fetcher=fetch){
  const transient=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
  function networkReason(error,signal){
    if(signal.aborted || error?.name==='TimeoutError' || error?.name==='AbortError')return 'NETWORK_TIMEOUT';
    for(let current=error;current;current=current.cause){
      if(transient.has(current.code))return current.code==='ECONNRESET'||current.code==='UND_ERR_SOCKET'?'NETWORK_RESET':current.code.includes('TIMEOUT')||current.code==='ETIMEDOUT'?'NETWORK_TIMEOUT':'NETWORK_UNAVAILABLE';
    }
    return null;
  }
  async function retry(action){
    const signal=AbortSignal.timeout(120000);
    for(let attempt=0;attempt<3;attempt++){
      try{return await action(signal);}
      catch(error){
        const reason=networkReason(error,signal);
        if(!reason){if(error instanceof TypeError && error.message==='fetch failed')throw Error('NETWORK_REQUEST_FAILED',{cause:error});throw error;}
        if(attempt===2||signal.aborted)throw Error(reason,{cause:error});
        try{await delay(250*(attempt+1),undefined,{signal});}catch{throw Error('NETWORK_TIMEOUT',{cause:error});}
      }
    }
  }
  async function request(url,accept,signal){
    const options={redirect:'manual',signal,headers:{Accept:accept,'User-Agent':'Stardust-Lifecycle',...(token?{Authorization:'Bearer '+token}:{})}};
    let response=await fetcher(url,options);
    if(accept==='application/octet-stream' && [301,302,303,307,308].includes(response.status)){
      const location=new URL(response.headers.get('location'));
      if(location.protocol!=='https:'||location.username||location.password||location.port||!['release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com'].includes(location.hostname))throw Error('INVALID_DOWNLOAD_REDIRECT');
      response=await fetcher(location,{redirect:'error',signal:options.signal});
    }
    if(!response.ok||!response.body)throw Error('GITHUB_HTTP_'+response.status);
    return response.body;
  }
  async function json(url,limit,accept='application/vnd.github+json'){
    return retry(async signal=>{
      let size=0;const chunks=[];
      for await(const chunk of await request(url,accept,signal)){
        size+=chunk.length;if(size>limit)throw Error('RELEASE_METADATA_TOO_LARGE');chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    });
  }
  const asset=(release,name)=>release.assets?.find(item=>item.name===name&&item.state==='uploaded'&&Number.isSafeInteger(item.id)&&item.id>0);
  async function fromRelease(release){
    const archive=asset(release,packageName),manifest=asset(release,'stardust-release.json');
    if(release.draft!==false||release.prerelease!==false||!release.published_at||!archive||!manifest)return null;
    const data=await json(api+'/releases/assets/'+manifest.id,32768,'application/octet-stream');
    const meta=version(data);
    if(release.tag_name!==`main-${meta.sequence}-${meta.sha}` || data.archive!==packageName || typeof data.sha256!=='string' || !digestPattern.test(data.sha256) ||
      !Number.isSafeInteger(data.size)||data.size!==archive.size||data.size<1||data.size>archiveLimit||
      (archive.digest&&archive.digest!=='sha256:'+data.sha256))throw Error('INVALID_RELEASE');
    return {...meta,assetId:archive.id,size:data.size,sha256:data.sha256,message:typeof data.message==='string'?data.message.slice(0,4096):''};
  }
  return {
    async latest(){
      const list=await json(api+'/releases?per_page=30',4*1024**2);
      if(!Array.isArray(list))throw Error('INVALID_RELEASE');
      const candidates=list.filter(r=>/^main-[0-9]+-[a-f0-9]{40}$/.test(r.tag_name))
        .sort((a,b)=>Number(b.tag_name.split('-')[1])-Number(a.tag_name.split('-')[1]));
      for(const release of candidates){
        const found=await fromRelease(release);
        if(found)return found;
      }
      throw Error('NO_PUBLISHED_RELEASE');
    },
    async find(sha,sequence){
      if(!shaPattern.test(sha)||!Number.isSafeInteger(sequence)||sequence<1)throw Error('VERSION_NOT_AVAILABLE');
      const found=await fromRelease(await json(api+'/releases/tags/main-'+sequence+'-'+sha,1024**2));
      if(!found||found.sha!==sha||found.sequence!==sequence)throw Error('VERSION_NOT_AVAILABLE');
      return found;
    },
    async download(target,path){
      await retry(async signal=>{
        const temp=path+'.'+randomUUID()+'.tmp';
        try{
          const result=await capture(Readable.fromWeb(await request(api+'/releases/assets/'+target.assetId,'application/octet-stream',signal)),temp,target.size);
          if(result.size!==target.size||result.sha256!==target.sha256)throw Error('PACKAGE_CHECKSUM_MISMATCH');
          await rename(temp,path);
        }finally{await unlink(temp).catch(error=>{if(!missing(error))throw error;});}
      });
    },
  };
}
