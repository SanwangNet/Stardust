import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const TAIL_BYTES=16384, TEXT_CHARS=4096, FILE_BYTES=65536;
const secretName=/(?:secret|token|password|passwd|credential|authorization|api[_-]?key|qq[_-]?(?:key|secret))/i;

/** Keep the end of each stream, including test-runner summaries. */
export function createOutputTail(limit=TAIL_BYTES) {
  let tail=Buffer.alloc(0),total=0;
  return {push(chunk){const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=data.length;if(data.length>=limit)tail=Buffer.from(data.subarray(data.length-limit));else {tail=Buffer.concat([tail,data]);if(tail.length>limit)tail=Buffer.from(tail.subarray(tail.length-limit));}},snapshot(env={}){
    let value=tail.toString('utf8');
    // The command receives a restricted environment, but redact sensitive values
    // if a caller supplies any. This is best effort, not a guarantee.
    for(const [key,secret] of Object.entries(env)){if(secretName.test(key)&&typeof secret==='string'&&secret.length>=4&&secret.length<=512)value=value.split(secret).join('[REDACTED]');}
    value=value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi,'$1 [REDACTED]')
      .replace(/((?:["']?[\w.-]*(?:secret|token|password|passwd|credential|authorization|api[_-]?key)[\w.-]*["']?)\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi,'$1"[REDACTED]"')
      .replace(/((?:["']?[\w.-]*(?:secret|token|password|passwd|credential|authorization|api[_-]?key)[\w.-]*["']?)\s*[:=]\s*)([^\s,;]+)/gi,'$1[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[REDACTED]@')
      .replace(/^(\s*["']?[A-Z_][A-Z0-9_]{2,}["']?\s*[:=]\s*).*$/gm,'$1[REDACTED]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'');
    const truncated=total>limit||value.length>TEXT_CHARS;
    return {text:value.slice(-TEXT_CHARS),truncated};
  }};
}

export class CommandFailure extends Error {
  constructor(reason,details){super(reason);this.diagnostic={reason,...details};}
}

/** Keep short failure and summary lines separately from arbitrarily long stacks. */
export function createFailureHints() {
  const tail=createOutputTail(8192);
  const reader=()=>{
    const decoder=new StringDecoder('utf8');let pending='',discard=false;
    const consume=value=>{let start=0;while(start<value.length){const end=value.indexOf('\n',start),part=value.slice(start,end<0?value.length:end);if(!discard){if(pending.length+part.length>2048){pending='';discard=true;}else pending+=part;}if(end<0)break;if(!discard){const line=pending.replace(/\x1b\[[0-9;]*m/g,'');if(/^\s*(?:✖|not ok\s+\d+|#\s*(?:fail|tests|pass|cancelled|skipped|todo)\b|(?:AssertionError|Error|TypeError|SyntaxError)(?:\s|:)|(?:error|actual|expected|operator|code):)/i.test(line))tail.push(Buffer.from(line+'\n'));}pending='';discard=false;start=end+1;}};
    return {push:chunk=>consume(decoder.write(chunk)),end(){consume(decoder.end());consume('\n');}};
  };
  const stdout=reader(),stderr=reader();
  return {stdout,stderr,snapshot(env){const result=tail.snapshot(env);return {text:result.text.slice(-2048),truncated:result.truncated||result.text.length>2048};}};
}

/** A single fixed-name diagnostic, never a caller-selected path. */
export async function writeFailureDiagnostic(taskDir,stage,details) {
  const name=String(stage).toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,80);
  const record={format:1,stage:name,reason:details?.reason??'VALIDATION_FAILED',exitCode:details?.exitCode??null,signal:details?.signal??null,stdout:details?.stdout??'',stderr:details?.stderr??'',failureHints:details?.failureHints??{text:'',truncated:false},truncated:details?.truncated??{stdout:false,stderr:false}};
  const data=JSON.stringify(record,null,2)+'\n';if(Buffer.byteLength(data)>FILE_BYTES)throw new Error('DIAGNOSTIC_TOO_LARGE');
  const file=await open(join(taskDir,'failure.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{await file.writeFile(data);await file.sync();}finally{await file.close();}
}

export async function recordWorkerEvent(taskDir,event) {
  if(event.event==='start')await writeFile(join(taskDir,'progress'),String(event.stage).toUpperCase().replace(/[^A-Z0-9_]/g,'_').slice(0,80)+'\n',{mode:0o600});
  else if(event.event==='failed')await writeFailureDiagnostic(taskDir,event.stage,event.diagnostic);
}
