import { copyFile, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest, packageName, shaPattern, version } from './lifecycle/files.mjs';

const [stagingArg,outputArg]=process.argv.slice(2);
if(!stagingArg||!outputArg)throw Error('USAGE: node scripts/package-release.mjs STAGING OUTPUT');
const staging=await realpath(stagingArg),output=resolve(outputArg);
const pkg=JSON.parse(await readFile(join(staging,'package.json'),'utf8'));
const sha=process.env.GITHUB_SHA, sequence=Number(process.env.GITHUB_RUN_NUMBER);
if(!shaPattern.test(sha))throw Error('INVALID_COMMIT');
const meta=version({format:1,sha,sequence,version:pkg.version,dataFormat:pkg.stardustDataFormat??1,manager:pkg.stardustManagerContract??1,platform:'linux-x64',node:24});
await mkdir(output,{recursive:true});
await mkdir(join(staging,'lifecycle'),{recursive:true});
for(const name of ['manage.mjs','files.mjs','running-port.mjs','archive.py'])await copyFile(new URL('./lifecycle/'+name,import.meta.url),join(staging,'lifecycle',name));
await writeFile(join(staging,'version.json'),JSON.stringify(meta)+'\n');
const archive=join(output,packageName);
execFileSync('tar',['--format=ustar','--exclude=node_modules/.bin','-czf',archive,'-C',staging,'apps','node_modules','lifecycle','package.json','version.json'],{stdio:'inherit'});
const {size}=await import('node:fs/promises').then(fs=>fs.stat(archive));
const sha256=await digest(archive);
const message=execFileSync('git',['log','-1','--format=%B',sha],{encoding:'utf8'}).trim().slice(0,4096);
await writeFile(join(output,'stardust-release.json'),JSON.stringify({...meta,archive:packageName,size,sha256,message},null,2)+'\n');
await writeFile(join(output,'SHA256SUMS'),sha256+'  '+basename(archive)+'\n');
let installer=await readFile(new URL('./install.sh',import.meta.url),'utf8');
let embedded=`STARDUST_INSTALLER_SHA=${sha}\nSTARDUST_INSTALLER_SEQUENCE=${sequence}\nSTARDUST_INSTALLER_DIGEST=${sha256}\nSTARDUST_INSTALLER_SIZE=${size}\ninstall_manager(){\n`;
for(const name of ['manage.mjs','files.mjs','running-port.mjs','archive.py']){
  const content=(await readFile(new URL('./lifecycle/'+name,import.meta.url),'utf8')).replaceAll('\r\n','\n');
  if(/^STARDUST_EMBEDDED_SOURCE$/m.test(content))throw Error('INSTALLER_HEREDOC_COLLISION');
  embedded+='  cat > "$1/'+name+'" <<\'STARDUST_EMBEDDED_SOURCE\'\n'+content.trimEnd()+'\nSTARDUST_EMBEDDED_SOURCE\n';
}
embedded+='  chmod 0644 "$1"/{manage,files,running-port}.mjs "$1/archive.py"\n}\n';
installer=installer.replace(/^(#![^\r\n]*\r?\n)/,header=>header+embedded);
await writeFile(join(output,'install.sh'),installer.replaceAll('\r\n','\n'));
