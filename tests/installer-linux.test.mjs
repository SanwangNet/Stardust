import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Exercise the real installer in a temporary filesystem with privileged system calls mocked.
test('Linux fresh install defaults to management and repeated install preserves data',{skip:process.platform!=='linux'||process.arch!=='x64'||process.versions.node.split('.')[0]!=='24'},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'stardust-installer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'bin'),root=join(dir,'stardust'),code=join(dir,'manager'),unit=join(dir,'systemd');
  await mkdir(bin);await mkdir(unit);
  const fake=async(name,body)=>{const path=join(bin,name);await writeFile(path,'#!/bin/bash\nset -e\n'+body+'\n');await chmod(path,0o755);};
  await fake('id','if [[ "$1" == -u && "$2" == stardust ]]; then echo 1234; else echo 0; fi');
  await fake('getent',`if [[ -f '${dir}/user-created' && "$1" == group && "$2" == stardust ]]; then echo stardust:x:1234:; exit 0; fi; exit 2`);
  await fake('useradd',`touch '${dir}/user-created'`);await fake('chown',':');await fake('chgrp',':');
  await fake('stat',`if [[ "$*" == *${root}/shared* ]]; then echo 1234; else exec /usr/bin/stat "$@"; fi`);
  await fake('systemctl',`printf '%s\\n' "$*" >> '${dir}/systemctl.log'; exit 0`);
  await fake('install',`dir=false; mode=0755; args=(); while (($#)); do case "$1" in -d) dir=true ;; -o|-g) shift ;; -m) shift; mode=$1 ;; *) args+=("$1") ;; esac; shift; done
if $dir; then for item in "\${args[@]}"; do mkdir -p "$item"; chmod "$mode" "$item"; done; else cp "\${args[0]}" "\${args[1]}"; chmod "$mode" "\${args[1]}"; fi`);
  const os=join(dir,'os-release'),init=join(dir,'init-name');await writeFile(os,'ID=debian\nVERSION_ID=13\n');await writeFile(init,'systemd\n');
  let script=await readFile(new URL('../scripts/install.sh',import.meta.url),'utf8');
  script=script.replace('export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',`export PATH='${bin}':\"$PATH\"`)
    .replaceAll('/opt/stardust',root).replaceAll('/usr/local/lib/stardust-lifecycle',code).replaceAll('/etc/systemd/system',unit).replaceAll('/etc/os-release',os).replaceAll('/proc/1/comm',init)
    .replace(/safe_path\(\)\{[\s\S]*?\n\}/,'safe_path(){ return 0; }');
  const manager=`import {mkdir,writeFile,symlink} from 'node:fs/promises';\nconst root=${JSON.stringify(root)};\nawait mkdir(root+'/releases/'+ 'a'.repeat(40));\nawait writeFile(root+'/releases/'+ 'a'.repeat(40)+'/version.json',JSON.stringify({version:'1.0'}));\nawait symlink('releases/'+ 'a'.repeat(40),root+'/current');\n`;
  script=script.replace(/^(#![^\n]*\n)/,header=>`${header}install_manager(){ cat > "$1/manage.mjs" <<'MANAGER'\n${manager}MANAGER\n}\n`);
  const installer=join(dir,'install.sh');await writeFile(installer,script);
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;
  const options={encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}};
  const occupied=spawnSync('/bin/bash',[installer,'--port',String(port)],options);
  assert.notEqual(occupied.status,0);assert.match(occupied.stderr,/端口.*占用/);
  await new Promise(resolve=>listener.close(resolve));
  const first=execFileSync('/bin/bash',[installer,'--port',String(port)],options);
  assert.match(first,/安装完成/);assert.match(first,new RegExp(':'+port+'/'));
  assert.equal(JSON.parse(await readFile(join(root,'management','config.json'),'utf8')).enabled,true);
  assert.match(await readFile(join(root,'shared','config.toml'),'utf8'),new RegExp('port = '+port));
  const data=join(root,'shared','user-data');await writeFile(data,'do not replace');
  const before=await readFile(join(unit,'stardust.service'),'utf8');
  const second=execFileSync('/bin/bash',[installer,'--port','42'],options);
  assert.match(second,/检测到已有 Stardust 安装/);
  assert.equal(await readFile(data,'utf8'),'do not replace');
  assert.equal(await readFile(join(unit,'stardust.service'),'utf8'),before);
  assert.match(await readFile(join(root,'shared','config.toml'),'utf8'),new RegExp('port = '+port));
  const events=(await readFile(join(dir,'systemctl.log'),'utf8')).length;
  await rm(root,{recursive:true});await rm(code,{recursive:true});await rm(unit,{recursive:true});await mkdir(unit);await rm(join(dir,'user-created'));
  execFileSync('/bin/bash',[installer,'--disable-management','--port',String(port)],options);
  assert.equal(JSON.parse(await readFile(join(root,'management','config.json'),'utf8')).enabled,false);
  assert.doesNotMatch((await readFile(join(dir,'systemctl.log'),'utf8')).slice(events),/enable --now stardust-lifecycle\.path/);
});
