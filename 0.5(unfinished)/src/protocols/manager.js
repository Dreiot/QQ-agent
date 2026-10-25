// User-supplied runtimes only. This host never downloads or ships a provider,
// accepts its terms, logs into QQ, or takes ownership of an existing process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {inspectRuntimeArchive,extractRuntimeArchive,assertPlainTree} from '../../scripts/lib/runtime-archive.mjs';
import {detectProtocolLayouts,configureProtocolConnection,protocolAccounts} from './adapters.js';
import {terminateOwnedProtocolProcess} from './process-tree.js';

const PROVIDERS=[
  {id:'napcat',title:'NapCat',url:'https://github.com/NapNeko/NapCatQQ/releases'},
  {id:'snowluma',title:'SnowLuma',url:'https://github.com/SnowLuma/SnowLuma/releases'},
];
const MAX_ARCHIVE=512*1024**2,MAX_FILES=60000;
const inside=(base,target)=>{const rel=path.relative(base,target);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status,expose:true});};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex').slice(0,24);
const plain=filename=>{const stat=fs.lstatSync(filename);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))fail('协议端路径不能是链接或特殊文件');return stat;};
function containedPath(base,target){const absolute=path.resolve(target);if(absolute!==base&&!inside(base,absolute))fail('协议端路径越界');plain(base);let current=base;for(const part of path.relative(base,absolute).split(path.sep).filter(Boolean)){current=path.join(current,part);plain(current);}const resolved=fs.realpathSync(absolute),anchor=fs.realpathSync(base);if(resolved!==anchor&&!inside(anchor,resolved))fail('协议端路径越界');return resolved;}
const port=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});
export function resolveProtocolRoot({appRoot,env=process.env}={}){return path.resolve(env.QQ_AGENT_PROTOCOL_DIR||path.join(appRoot,'protocols'));}

export function createLocalProtocols({appRoot,dataDir,config,bus,log=console,env=process.env,platform=process.platform,arch=process.arch,
  spawnImpl=spawn,terminateImpl=terminateOwnedProtocolProcess,allocatePort=port,inspectArchive=inspectRuntimeArchive,extractArchive=extractRuntimeArchive}={}){
  const root=resolveProtocolRoot({appRoot,env}),cache=path.join(dataDir,'protocols','packages');
  const archiveIndex=new Map();
  let entries=new Map(),scanPromise=null,operation=null,watcher=null,configWatcher=null,watchTimer=null,outputTimer=null,closed=false,started=false,runtime=null,output='';
  const settings=()=>({autoStart:config.get().localProtocols?.autoStart===true});
  const notify=()=>{if(!closed)bus?.emit('local-protocols',{id:runtime?.id??null,status:runtime?.status??'idle',outputVersion:runtime?.outputVersion??0});};
  function prepareRoot(){fs.mkdirSync(root,{recursive:true});if(!plain(root).isDirectory())fail('协议端放置路径必须是目录');}
  function active(){return runtime&&(runtime.treePending||['preparing','running','stopping'].includes(runtime.status));}
  function snapshot(){return {root,providers:PROVIDERS.map(provider=>({...provider,items:[...entries.values()].filter(item=>item.provider===provider.id).map(({physical,archivePath,layoutRoot,fingerprint,...item})=>item)})),
    running:runtime?{id:runtime.id,provider:runtime.provider,status:runtime.status,pid:runtime.child?.pid??null,account:runtime.account??'',webUiUrl:runtime.webUiUrl??null,error:runtime.error??null,outputVersion:runtime.outputVersion??0}:null,settings:settings()};}
  async function collect(){
    prepareRoot();const names=[],archives=[];let count=0;
    async function walk(dir,prefix='',depth=0){
      for(const entry of await fs.promises.readdir(dir,{withFileTypes:true})){
        if(++count>MAX_FILES)fail('协议端目录文件过多，请只放发行包');
        if(entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
        const relative=prefix+entry.name,absolute=path.join(dir,entry.name);
        if(entry.isFile()){names.push(relative);if(depth<=2&&/\.zip$/i.test(entry.name))archives.push({relative,absolute});}
        else if(entry.isDirectory()&&depth<7&&!/^(node_modules|logs?|cache|data|temp|tmp)$/i.test(entry.name))await walk(absolute,relative+'/',depth+1);
      }
    }
    await walk(root);const next=new Map();
    function add(layout,source,archivePath=null,fingerprint=''){
      const relative=source+(archivePath?'!':'')+layout.root;
      const id=hash(layout.provider+'|'+relative);
      const physical=archivePath?null:path.resolve(root,layout.root);
      const name=archivePath?path.basename(archivePath):path.basename(physical||root);
      next.set(id,{...layout,id,name,location:archivePath||physical,archive:!!archivePath,physical,archivePath,layoutRoot:layout.root,fingerprint});
    }
    for(const layout of detectProtocolLayouts(names,{platform,arch}))add(layout,'');
    for(const item of archives){
      try{
        const stat=plain(item.absolute);if(stat.size>MAX_ARCHIVE)fail('ZIP 超过 512 MiB，请自行解压后放入目录');
        const fingerprint=`${stat.size}:${stat.mtimeMs}`,previous=archiveIndex.get(item.absolute);
        let layouts;if(previous?.fingerprint===fingerprint)layouts=previous.layouts;else{const info=inspectArchive(item.absolute);layouts=detectProtocolLayouts(info.entries.filter(entry=>!entry.directory).map(entry=>entry.name),{platform,arch});archiveIndex.set(item.absolute,{fingerprint,layouts});}
        for(const layout of layouts){
          add(layout,item.relative,item.absolute,fingerprint);
          const id=hash(layout.provider+'|'+item.relative+'!'+layout.root),install=path.join(cache,hash(id+'|'+fingerprint));
          if(fs.existsSync(install))try{const physical=containedPath(cache,path.join(install,layout.root));next.get(id).accounts=await protocolAccounts(physical,layout.configDir,layout.provider);}catch(error){next.get(id).ready=false;next.get(id).reason=error.message;}
        }
        if(!layouts.length&&/napcat|snowluma/i.test(item.relative)){
          const provider=/snowluma/i.test(item.relative)?'snowluma':'napcat';
          add({provider,variant:'unknown',root:'',entry:'',ready:false,reason:'未找到可运行的完整发行包；请从 Releases 下载对应平台的 ZIP',accounts:[]},item.relative,item.absolute);
        }
      }catch(error){
        if(/napcat|snowluma/i.test(item.relative))add({provider:/snowluma/i.test(item.relative)?'snowluma':'napcat',variant:'invalid',root:'',entry:'',ready:false,reason:error.message,accounts:[]},item.relative,item.absolute);
      }
    }
    entries=next;return snapshot();
  }
  function scan(){if(closed)return Promise.reject(new Error('协议端管理已停止'));if(!scanPromise)scanPromise=collect().finally(()=>{scanPromise=null;});return scanPromise;}
  function exclusive(action){if(closed)fail('协议端管理已停止',409);if(operation)fail('正在准备或停止协议端，请稍候',409);operation=Promise.resolve().then(action).finally(()=>{operation=null;});return operation;}
  async function packageRoot(item){
    if(!item.archive){const physical=containedPath(root,item.physical);assertPlainTree(physical);return physical;}
    const stat=plain(item.archivePath);if(`${stat.size}:${stat.mtimeMs}`!==item.fingerprint)fail('ZIP 已变化，请刷新后再启动',409);
    plain(dataDir);let ancestor=dataDir;for(const part of ['protocols','packages']){ancestor=path.join(ancestor,part);fs.mkdirSync(ancestor,{recursive:true});if(!plain(ancestor).isDirectory())fail('解压目录不是普通目录');}
    const install=path.join(cache,hash(item.id+'|'+item.fingerprint)),marker=path.join(install,'.qq-agent-package.json');
    if(fs.existsSync(marker)){
      containedPath(cache,marker);const saved=JSON.parse(fs.readFileSync(marker,'utf8'));
      if(saved.id!==item.id||saved.fingerprint!==item.fingerprint)fail('已解压目录与原 ZIP 不一致');
      const physical=containedPath(cache,path.join(install,item.layoutRoot));assertPlainTree(physical);return physical;
    }
    const stage=path.join(cache,'.stage-'+crypto.randomUUID());
    try{
      await extractArchive(item.archivePath,stage);
      if(`${plain(item.archivePath).size}:${fs.statSync(item.archivePath).mtimeMs}`!==item.fingerprint)fail('解压过程中 ZIP 已变化，请重试',409);
      const physical=path.resolve(stage,item.layoutRoot);if(physical!==stage&&!inside(stage,physical))fail('归档中的协议端路径越界');
      const detected=detectProtocolLayouts((await filesIn(physical)).map(name=>name),{platform,arch}).find(layout=>layout.provider===item.provider&&layout.ready&&layout.root==='');
      if(!detected)fail('ZIP 解压后缺少所需运行文件');
      fs.writeFileSync(path.join(stage,'.qq-agent-package.json'),JSON.stringify({id:item.id,fingerprint:item.fingerprint}));
      await fs.promises.rename(stage,install);return path.join(install,item.layoutRoot);
    }catch(error){if(inside(path.resolve(cache),path.resolve(stage))&&path.basename(stage).startsWith('.stage-'))await fs.promises.rm(stage,{recursive:true,force:true});throw error;}
  }
  async function filesIn(directory){const names=[];async function walk(dir,prefix='',depth=0){for(const entry of await fs.promises.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())fail('协议端不能包含链接');if(entry.isFile())names.push(prefix+entry.name);else if(entry.isDirectory()&&depth<7&&!/^(node_modules|logs?|cache|data)$/i.test(entry.name))await walk(path.join(dir,entry.name),prefix+entry.name+'/',depth+1);if(names.length>MAX_FILES)fail('协议端文件过多');}}await walk(directory);return names;}
  function ingestOutput(record,chunk){
    if(runtime!==record||closed)return;const text=String(chunk);output=(output+text).slice(-65536);record.outputVersion++;
    record.lineBuffer=(record.lineBuffer+text).slice(-8192);
    const lines=record.lineBuffer.split(/\r?\n/);record.lineBuffer=lines.pop();
    for(const line of lines){
      if(!/web\s*ui/i.test(line))continue;
      for(const match of line.matchAll(/https?:\/\/[^\s<>"']+/g))try{
        const url=new URL(match[0]);if(url.hostname==='0.0.0.0')url.hostname='127.0.0.1';if(url.hostname==='[::]')url.hostname='[::1]';if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)continue;
        if([record.httpPort,record.wsPort].includes(Number(url.port)))continue;
        url.search='';url.hash='';record.webUiUrl=url.href;
      }catch{/* Ignore decoration around a log URL. */}
    }
    if(!outputTimer){outputTimer=setTimeout(()=>{outputTimer=null;notify();},150);outputTimer.unref?.();}
  }
  function acquirePackage(record,directory){
    const lock=path.join(directory,'.qq-agent-runtime.lock'),nonce=crypto.randomUUID();
    const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
    try{const fd=fs.openSync(lock,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({ownerPid:process.pid,childPid:null,nonce}));fs.closeSync(fd);}
    catch(error){if(error.code!=='EEXIST')throw error;plain(lock);let owner;try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{fail('此发行包的进程标记损坏，请确认旧程序已退出后移开 .qq-agent-runtime.lock',409);}if(owner.uncertainTree)fail('上次未能确认协议端已完全停止，请检查旧进程后移开 .qq-agent-runtime.lock',409);if(alive(owner.ownerPid)||alive(owner.childPid))fail('此发行包正在由另一个实例运行，请先从原实例停止',409);fs.renameSync(lock,lock+'.stale-'+crypto.randomUUID());return acquirePackage(record,directory);}
    record.releasePackage=()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).nonce===nonce)fs.unlinkSync(lock);}catch{}};
    record.updatePackage=(pid,uncertainTree=false)=>{fs.writeFileSync(lock,JSON.stringify({ownerPid:process.pid,childPid:pid,nonce,uncertainTree}),{mode:0o600});};
  }
  function retainUncertainTree(record,detail=''){
    record.treePending=true;record.orphaned=true;
    try{record.updatePackage?.(record.child?.pid??null,true);}catch{log.warn?.('[protocols] 无法保留异常退出的进程标记，请检查包目录');}
    record.status='error';record.error=`协议端启动器已退出${detail}，无法确认工作进程已停止。请查看启动输出，确认并关闭遗留进程后，移开包内的 .qq-agent-runtime.lock，再重启 QQ-Agent`;
    if(runtime===record){configWatcher?.close();configWatcher=null;notify();}
  }
  async function launch(id,account,options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)||options.deferConnection!==undefined&&typeof options.deferConnection!=='boolean')fail('延后连接设置必须为开关');
    await scan();const item=entries.get(id);if(!item)fail('未找到此发行包，请刷新检测结果',404);if(!item.ready)fail(item.reason||'此包无法直接运行');
    if(runtime?.orphaned)fail(runtime.error,409);
    if(active()){if(runtime.id===id&&runtime.status==='running'&&(!account||account===runtime.account))return snapshot();fail('请先停止当前协议端，再切换发行包或账号',409);}
    const record={id,instanceId:crypto.randomUUID(),provider:item.provider,status:'preparing',account:account||'',error:null,outputVersion:0,lineBuffer:'',webUiUrl:null,child:null};runtime=record;output='';notify();
    try{
      const physical=await packageRoot(item);record.physical=physical;if(closed)fail('应用已停止',409);
      // Revalidate extracted directories too; the selected entry is never a
      // caller-provided command, executable path, or arbitrary shell snippet.
      const layout=detectProtocolLayouts(await filesIn(physical),{platform,arch}).find(row=>row.provider===item.provider&&row.ready&&row.root==='');
      if(!layout)fail('发行包已变化或不完整，请重新检测');
      const executable=path.join(physical,layout.executable),entry=path.join(physical,layout.entry);plain(executable);plain(entry);
      // ZIP extraction creates plain data files; restore execute permission on
      // the one validated bundled Node entry on Unix before launching it.
      if(platform!=='win32')await fs.promises.chmod(executable,0o755);
      if(item.provider==='snowluma'){
        const release=JSON.parse(fs.readFileSync(path.join(physical,'release.json'),'utf8'));
        if(release.target&&release.target!==`${platform}-${arch}`)fail('SnowLuma 发行包与当前系统架构不匹配');
      }
      acquirePackage(record,physical);
      const httpPort=await allocatePort();let wsPort=await allocatePort();while(wsPort===httpPort)wsPort=await allocatePort();
      const token=crypto.randomBytes(32).toString('hex');
      // A generic add flow owns only the global template. Remembered accounts
      // keep their exact listeners and credentials until explicitly selected.
      const genericDeferred=options.deferConnection===true&&!account;
      const chosenAccount=genericDeferred?undefined:account||layout.accounts?.[0]||undefined;
      const connection=await configureProtocolConnection({provider:item.provider,root:physical,configDir:layout.configDir,httpPort,wsPort,token,
        account:genericDeferred?undefined:layout.accounts?.length>1?account:chosenAccount,...(genericDeferred?{templateOnly:true}:{})});
      if(closed)fail('应用已停止',409);
      const childEnv={...env};for(const key of Object.keys(childEnv))if(/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|QQ_AGENT_|SNOWLUMA_ACCEPT_)/i.test(key))delete childEnv[key];
      if(item.provider==='napcat')childEnv.NAPCAT_WORKDIR=path.join(physical,'napcat');
      record.httpPort=httpPort;record.wsPort=wsPort;record.account=chosenAccount||'';
      if(options.deferConnection)record.preparedConnection={httpPort,wsPort,token,accountId:record.account,
        ...(genericDeferred?{existingAccounts:[...(layout.accounts||[])]}:{})};
      const args=[entry];if(item.provider==='napcat'&&record.account)args.push('-q',record.account);
      const child=spawnImpl(executable,args,{cwd:physical,env:childEnv,windowsHide:true,detached:platform!=='win32',stdio:['ignore','pipe','pipe']});record.child=child;record.treePending=Number.isSafeInteger(child.pid)&&child.pid>0;record.updatePackage(child.pid??null);
      child.stdout?.on('data',chunk=>ingestOutput(record,chunk));child.stderr?.on('data',chunk=>ingestOutput(record,chunk));
      child.on('error',()=>{if(runtime===record){record.status='error';record.error='协议端进程未能启动，请检查发行包和运行环境';notify();}});
      child.once('exit',(code,signal)=>{
        // An exited launcher does not prove that all its workers have exited.
        // Retain the lease instead of risking duplicate workers or signalling
        // a reused PID. The ordinary stop path settles only after tree cleanup.
        if(record.status==='stopping')return;
        retainUncertainTree(record,`（${code??signal??'未知原因'}）`);
      });
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      if(closed||record.status==='error')fail('协议端未能保持运行，请查看启动输出');
      record.status='running';
      configWatcher?.close();configWatcher=fs.watch(path.join(physical,layout.configDir),()=>scheduleScan());configWatcher.on('error',()=>{configWatcher?.close();configWatcher=null;});
      // A card may be preparing a second account through this shared process.
      // Its native login must verify and register that account before any
      // primary endpoint binding is changed.
      config.update({...(!options.deferConnection?{onebot:{wsUrl:connection.wsUrl,httpUrl:connection.httpUrl,accessToken:connection.accessToken,httpAccessToken:connection.httpAccessToken}}:{}),localProtocols:{selectedId:id,account:record.account,deferConnection:options.deferConnection===true}});
      bus?.emit('status',{configUpdated:true});notify();return snapshot();
    }catch(error){
      if(record.treePending||record.child?.pid&&record.child.exitCode==null&&record.child.signalCode==null){
        try{await halt();}catch{if(!record.orphaned){record.status='running';record.error='启动未完成，且协议端进程尚未停止；请先停止后重试';}notify();throw error;}
      }
      record.releasePackage?.();record.status='error';record.error=error.message;notify();throw error;
    }
  }
  async function halt(){
    const record=runtime,child=record?.child;
    if(record?.treePending&&(child?.exitCode!=null||child?.signalCode!=null))retainUncertainTree(record);
    if(record?.orphaned){record.updatePackage?.(child?.pid??null,true);fail(record.error,409);}
    if(!child?.pid||!record.treePending&&(child.exitCode!=null||child.signalCode!=null)){record?.releasePackage?.();if(record&&record.status!=='error')record.status='stopped';notify();return snapshot();}
    record.treePending=true;
    record.status='stopping';notify();
    try{await new Promise((resolve,reject)=>{
      let timer,settled=false;
      const cleanup=()=>{clearTimeout(timer);child.removeListener('exit',done);};
      const done=()=>{if(settled)return;settled=true;cleanup();resolve();};
      const failed=error=>{if(settled)return;settled=true;cleanup();reject(error);};
      let exited=child.exitCode!=null||child.signalCode!=null,terminated=false;
      const completed=()=>{if(exited&&terminated)done();};
      const onExit=()=>{exited=true;completed();};
      child.once('exit',onExit);
      // Keep the package lease until the tree terminator has completed as well
      // as the launcher's exit; a parent can exit before its workers do.
      Promise.resolve().then(()=>terminateImpl(child,{platform})).then(()=>{terminated=true;completed();},failed).finally(()=>{if(settled)child.removeListener('exit',onExit);});
      timer=setTimeout(()=>{child.removeListener('exit',onExit);failed(new Error('协议端进程树尚未退出，请重试停止'));},8000);timer.unref?.();
    });}catch(error){
      if(child.exitCode!=null||child.signalCode!=null)retainUncertainTree(record);
      else{record.updatePackage?.(child.pid,true);record.status='running';record.error=error.message;notify();}
      throw error;
    }
    configWatcher?.close();configWatcher=null;record.treePending=false;record.releasePackage?.();record.status='stopped';record.error=null;notify();return snapshot();
  }
  async function start(){
    if(started||closed)return;started=true;
    try{await scan();if(closed)return;watcher=fs.watch(root,{recursive:true},(_event,filename)=>{if(filename&&/(?:^|[\\/])(?:node_modules|logs?|cache|data|temp|tmp)(?:[\\/]|$)|\.log$|\.tmp$|\.qq-agent-|\.backup[.-]/i.test(String(filename)))return;scheduleScan();});watcher.on('error',()=>{log.warn?.('[protocols] 目录监听已停止，可手动刷新');watcher?.close();watcher=null;});
      const saved=config.get().localProtocols;if(saved?.autoStart&&saved.selectedId){
        // Isolated account profiles retain their own saved endpoints on reboot.
        // Restart their shared service from the global template, never by
        // selecting a remembered QQ and rebinding it to the primary workspace.
        const deferred=saved.deferConnection===true;
        await exclusive(()=>launch(saved.selectedId,deferred?undefined:saved.account||undefined,{deferConnection:deferred}));
      }
    }catch(error){log.warn?.(`[protocols] ${error.message}`);}
  }
  function scheduleScan(){if(closed)return;clearTimeout(watchTimer);watchTimer=setTimeout(()=>{watchTimer=null;void scan().then(notify,()=>{log.warn?.('[protocols] 无法刷新协议端目录');notify();});},250);watchTimer.unref?.();}
  async function close(){closed=true;watcher?.close();configWatcher?.close();clearTimeout(watchTimer);clearTimeout(outputTimer);await operation?.catch(()=>{});try{await halt();}finally{output='';archiveIndex.clear();}}
  function saveSettings(body){if(typeof body?.autoStart!=='boolean')fail('自动启动设置必须为开关');if(closed)fail('协议端管理已停止',409);config.update({localProtocols:{autoStart:body.autoStart}});bus?.emit('status',{configUpdated:true});notify();return snapshot();}
  // Host-only context. Paths and native credentials never enter the public
  // package snapshot or plugin SDK; each launch has a fresh identity.
  function loginContext(){return !closed&&runtime?.status==='running'?{id:runtime.id,instanceId:runtime.instanceId,provider:runtime.provider,root:runtime.physical,webUiUrl:runtime.webUiUrl,account:runtime.account,httpPort:runtime.httpPort,wsPort:runtime.wsPort,
    ...(runtime.preparedConnection?{preparedConnection:{...runtime.preparedConnection}}:{})}:null;}
  function commitLoginConnection(instanceId,account,{httpPort,wsPort,token}){
    if(closed||operation||runtime?.status!=='running'||runtime.instanceId!==instanceId||!['snowluma','napcat'].includes(runtime.provider))fail('协议端实例已变化，请重新选择账号',409);
    if(!/^\d{5,10}$/.test(account)||![httpPort,wsPort].every(value=>Number.isInteger(value)&&value>0&&value<65536)||httpPort===wsPort||!/^[a-f0-9]{64}$/.test(token))fail('账号连接参数无效');
    if(runtime.provider==='napcat'){
      const prepared=runtime.preparedConnection;
      if(!prepared||prepared.accountId&&prepared.accountId!==account||prepared.httpPort!==httpPort||prepared.wsPort!==wsPort||prepared.token!==token)fail('协议端准备的账号连接已变化，请重新接入',409);
    }
    runtime.account=account;runtime.httpPort=httpPort;runtime.wsPort=wsPort;
    config.update({onebot:{httpUrl:`http://127.0.0.1:${httpPort}`,wsUrl:`ws://127.0.0.1:${wsPort}`,accessToken:token,httpAccessToken:token},localProtocols:{selectedId:runtime.id,account}});
    bus?.emit('status',{configUpdated:true});notify();
  }
  return {root,start,close,scan,snapshot,launch:(id,account,options)=>exclusive(()=>launch(id,account,options)),stop:()=>exclusive(halt),saveSettings,output:()=>({text:output}),loginContext,commitLoginConnection};
}
