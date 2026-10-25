import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {terminateOwnedProtocolProcess} from '../src/protocols/process-tree.js';

const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'qq-agent-own-process-tree-'));
const script=path.join(temporary,'synthetic-tree.mjs');
await fs.writeFile(script,`import {spawn} from 'node:child_process';import net from 'node:net';
if(process.argv[2]==='worker'){const server=net.createServer();server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({workerPid:process.pid,port:server.address().port})));}
else{const child=spawn(process.execPath,[process.argv[1],'worker'],{windowsHide:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);setInterval(()=>{},1000);}
`);
let parent,worker;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const wait=async check=>{for(let n=0;n<100;n++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,30));}throw Error('Synthetic process tree did not settle');};
try{
  parent=spawn(process.execPath,[script,'parent'],{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>parent.once('exit',resolve));
  worker=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(Error('Synthetic worker startup timeout')),8000);parent.once('error',reject);parent.stdout.on('data',chunk=>{buffer+=chunk;const line=buffer.split('\n')[0];try{const data=JSON.parse(line);if(data.workerPid&&data.port){clearTimeout(timer);resolve(data);}}catch{}});});
  assert.ok(alive(parent.pid)&&alive(worker.workerPid));
  await new Promise((resolve,reject)=>{const socket=net.connect(worker.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);});
  await terminateOwnedProtocolProcess(parent);await exited;await wait(()=>!alive(worker.workerPid));
  assert.equal(alive(parent.pid),false);assert.equal(alive(worker.workerPid),false);
  await assert.rejects(new Promise((resolve,reject)=>{const socket=net.connect(worker.port,'127.0.0.1');socket.once('connect',()=>{socket.destroy();resolve();});socket.once('error',reject);}),/ECONNREFUSED/);
  const evidence=path.resolve('.qa-local/local-protocol-runtime-20261024');await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'process-tree.json'),JSON.stringify({platform:process.platform,parentPid:parent.pid,workerPid:worker.workerPid,parentExited:true,workerExited:true,listenerClosed:true,thirdPartyProgramsExecuted:false},null,2));
  console.log('✓ owned synthetic launcher and listening worker both exit; port is released; no third-party runtime executed');
}finally{
  if(parent&&alive(parent.pid))await terminateOwnedProtocolProcess(parent).catch(()=>{});
  const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(temporary));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(temporary).startsWith('qq-agent-own-process-tree-'));
  await fs.rm(temporary,{recursive:true,force:true});
}
