import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

const enabled=process.platform==='linux'&&process.getuid?.()===0;
const reason='需要 root 的隔离 Linux 环境、GNU tar 与 fuser';
const task='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',next='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sha='a'.repeat(40);

async function internals(){
  const source=readFileSync(new URL('../scripts/updater/deploy.mjs',import.meta.url),'utf8')
    .replace("from './prepare-core.mjs'",`from ${JSON.stringify(new URL('../scripts/updater/prepare-core.mjs',import.meta.url).href)}`)
    .replace("from './check.mjs'",`from ${JSON.stringify(new URL('../scripts/updater/check.mjs',import.meta.url).href)}`)
    .replace("from './running-port.mjs'",`from ${JSON.stringify(new URL('../scripts/updater/running-port.mjs',import.meta.url).href)}`)
    .replace("from './diagnostics.mjs'",`from ${JSON.stringify(new URL('../scripts/updater/diagnostics.mjs',import.meta.url).href)}`)
    + '\nexport { backup as testBackup, inspectTree as testInspectTree };\n';
  return import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'stardust-deploy-test-'))),within=relative(realpathSync(tmpdir()),root);assert.ok(within&&within!=='..'&&!within.startsWith('..'+sep)&&!isAbsolute(within));t.after(()=>rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return root;}

test('stopped-database backup contains shared files, checksum, and refuses live database users',{skip:!enabled?reason:false},async t=>{
  const {testBackup}=await internals(),{DatabaseSync}=await import('node:sqlite'),root=fixture(t);mkdirSync(join(root,'shared','data'),{recursive:true});writeFileSync(join(root,'shared','config.toml'),'[web]\ntitle="fixture"\n');
  const path=join(root,'shared','data','conversations.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'kept\');');
  await assert.rejects(testBackup(root,task,sha),/DATABASE_IN_USE/);db.close();
  const archive=await testBackup(root,task,sha),record=JSON.parse(readFileSync(join(root,'backups',task+'.json'),'utf8'));const contents=execFileSync('tar',['-tzf',archive],{encoding:'utf8'});
  assert.match(contents,/shared\/config\.toml/);assert.match(contents,/shared\/data\/conversations\.sqlite/);assert.equal(record.sha256,createHash('sha256').update(readFileSync(archive)).digest('hex'));assert.equal(record.version,sha);
  symlinkSync('/etc',join(root,'shared','escape'));await assert.rejects(testBackup(root,next,sha),/SHARED_INVALID/);assert.equal(existsSync(join(root,'backups',next+'.tar.gz')),false);
});

test('release inspection rejects escaping symlinks and external hard links',{skip:!enabled?reason:false},async t=>{
  const {testInspectTree}=await internals(),root=fixture(t),source=join(root,'source'),outside=join(root,'outside');mkdirSync(source);writeFileSync(outside,'untouched');symlinkSync(outside,join(source,'link'));await assert.rejects(testInspectTree(source,0),/UNSAFE_RELEASE/);assert.equal(readFileSync(outside,'utf8'),'untouched');
  unlinkSync(join(source,'link'));const other=join(root,'other');mkdirSync(other);writeFileSync(join(other,'file'),'keep');linkSync(join(other,'file'),join(source,'hardlink'));await assert.rejects(testInspectTree(source,0),/UNSAFE_RELEASE/);
});
