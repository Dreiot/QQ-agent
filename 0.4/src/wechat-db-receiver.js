// Read-only database receive source and server receipts, independent of the selected sender.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {DATA_DIR,ROOT} from './config.js';
export const wechatMediaRoot=path.join(DATA_DIR,'desktop-wechat','media');
export function trustedWechatMedia(items=[]) {
  return (Array.isArray(items)?items:[]).slice(0,4).filter(item=>{
    if(item?.kind!=='image'||typeof item.localFile!=='string')return false;
    const relative=path.relative(wechatMediaRoot,path.resolve(item.localFile));
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return false;
    try{const root=fs.realpathSync(wechatMediaRoot),real=fs.realpathSync(item.localFile),rel=path.relative(root,real),file=fs.statSync(real);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel)&&file.isFile()&&file.size<=4*1024*1024;}catch{return false;}
  }).map(item=>({kind:'image',localFile:item.localFile,mime:item.mime||'image/jpeg',source:'wechat-database',
    width:Number(item.width)||0,height:Number(item.height)||0,originalWidth:Number(item.originalWidth)||0,originalHeight:Number(item.originalHeight)||0,quality:item.quality||'unknown'}));
}
export class WechatDatabaseReceiver {
  constructor({onMessage,onStatus=()=>{},spawnProcess=spawn}={}) {
    Object.assign(this,{onMessage,onStatus,spawnProcess});this.proc=null;this.key='';this.retryAt=0;
    this.receipts=[];this.waiters=[];this.consumedReceipts=new Set();this.receiptSequence=0;
    this.mediaRequests=new Map();this.mediaSequence=0;
    this.state={connected:false,ready:false,identitySource:'unverified',lastError:'',targetCount:0,unresolvedTargets:[],lastPollAt:0};
  }
  configure(settings) {
    const key=JSON.stringify(settings);
    if(this.proc){if(key!==this.key){this.key=key;this.state.ready=false;this.proc.stdin.write(JSON.stringify({op:'configure',...settings})+'\n');}return;}
    if(Date.now()<this.retryAt)return;
    const credentials=path.join(DATA_DIR,'desktop-wechat','database.private.json');
    const python=path.join(ROOT,'runtime','wechat-db','venv','Scripts','python.exe');
    if(!fs.existsSync(credentials)||!fs.existsSync(python)){this.state.lastError='数据库读取尚未连接，请先完成原账号的读取验证';return;}
    this.key=key;
    const child=this.spawnProcess(python,['-X','utf8',path.join(ROOT,'src','wechat-db','reader.py'),'--credentials',credentials,'--media-root',wechatMediaRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.proc=child;child.stdin.on('error',()=>{});child.stderr.resume();
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      if(this.proc!==child)return;
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.event==='db-ready'){
        const accountStableId=String(message.accountStableId||'');
        if(this.state.accountStableId&&this.state.accountStableId!==accountStableId){
          this.state.ownerCandidates=[];this.clearReceipts();
        }
        this.state={...this.state,connected:true,ready:false,identitySource:'database',accountStableId,
          accountDirectory:String(message.accountDirectory||''),lastError:''};
        child.stdin.write(JSON.stringify({op:'configure',...JSON.parse(this.key)})+'\n');
      }else if(message.event==='db-configured'){
        this.state.targetCount=Number(message.targetCount)||0;this.state.unresolvedTargets=message.unresolvedTargets||[];this.state.targets=message.targets||[];
        this.state.ready=false;
      }else if(message.event==='db-polled'){
        this.state.lastPollAt=Date.now();this.state.receivedCount=Number(message.receivedCount)||0;
        this.state.ready=this.state.connected&&this.state.targetCount>0;
      }else if(message.event==='db-roster'){
        this.state.ownerCandidates=[...(this.state.ownerCandidates||[]).filter(item=>item.chatName!==message.chatName),
          ...(message.members||[]).slice(0,100).map(item=>({id:String(item.id||''),name:String(item.name||''),wechatId:String(item.wechatId||item.id||''),chatName:String(message.chatName)}))];
      }else if(message.event==='db-outbound'&&message.accountStableId===this.state.accountStableId){
        this.acceptReceipt(message);
      }else if(message.event==='message'&&this.state.connected){
        if(message.accountStableId===this.state.accountStableId&&message.receiver==='database'&&message.senderStableId&&message.chatStableId)
          this.onMessage({...message,media:trustedWechatMedia(message.media)});
      }else if(message.event==='db-media'){
        this.mediaRequests.get(message.requestId)?.(message.ok?trustedWechatMedia(message.media):[]);
      }else if(message.event==='db-error'){this.state.ready=false;this.state.lastError=String(message.code||'数据库读取失败');}
      this.onStatus(this.state);
    });
    child.on('error',()=>{this.state.lastError='数据库读取进程未能启动';this.onStatus(this.state);});
    child.on('exit',()=>{lines.close();if(this.proc!==child)return;this.proc=null;this.state.connected=false;this.state.ready=false;
      this.clearReceipts();
      this.retryAt=Date.now()+15000;this.onStatus(this.state);});
  }
  receiptIdentity(item){return `${item.accountStableId}\0${item.chatStableId}\0${item.mid}`;}
  snapshotReceiptBaseline(talker){
    return {accountStableId:this.state.accountStableId,sequence:this.receiptSequence,
      mids:this.receipts.filter(item=>item.chatStableId===talker).map(item=>item.mid)};
  }
  claimReceipt(item){
    const identity=this.receiptIdentity(item);
    if(this.consumedReceipts.has(identity))return false;
    this.consumedReceipts.add(identity);
    if(this.consumedReceipts.size>1000)this.consumedReceipts.delete(this.consumedReceipts.values().next().value);
    return true;
  }
  acceptReceipt(message){
    if(!message.mid||message.accountStableId!==this.state.accountStableId)return;
    const identity=this.receiptIdentity(message);
    if(this.receipts.some(item=>this.receiptIdentity(item)===identity))return;
    message={...message,receivedSequence:++this.receiptSequence};
    this.receipts.push(message);this.receipts=this.receipts.slice(-100);
    // A server message can confirm one submission only, even for identical text.
    for(const waiter of [...this.waiters])if(waiter.match(message)&&waiter.finish(message))break;
  }
  clearReceipts(){
    for(const finish of [...this.mediaRequests.values()])finish([]);
    for(const waiter of [...this.waiters])waiter.finish(null);
    this.receipts=[];this.consumedReceipts.clear();
  }
  refreshMedia(talker,mid){
    if(!this.proc||!this.state.ready)return Promise.resolve([]);
    return new Promise(resolve=>{
      const requestId='media-'+(++this.mediaSequence);let timer;
      const finish=items=>{clearTimeout(timer);this.mediaRequests.delete(requestId);resolve(items);};
      this.mediaRequests.set(requestId,finish);timer=setTimeout(()=>finish([]),12000);
      this.proc.stdin.write(JSON.stringify({op:'resolve-media',requestId,talker,mid:String(mid)})+'\n',error=>{if(error)finish([]);});
    });
  }
  waitForReceipt(talker,text,since,timeout=10000,type='text',baseline=null,expected={}){
    const accountStableId=this.state.accountStableId;
    if(baseline?.accountStableId&&baseline.accountStableId!==accountStableId)return Promise.resolve(null);
    const previous=new Set(baseline?.mids||[]);
    const match=item=>item.accountStableId===accountStableId&&item.chatStableId===talker&&item.mid&&!previous.has(item.mid)&&
      !this.consumedReceipts.has(this.receiptIdentity(item))&&(item.messageType||'text')===type&&(type==='image'||item.text===text)&&
      (!expected.atUserIds?.length||(Array.isArray(item.atUserIds)&&item.atUserIds.length===expected.atUserIds.length&&expected.atUserIds.every(id=>item.atUserIds.includes(id))))&&
      // Server create_time is not the local submission clock. With a pre-send
      // baseline, require a new observed receipt instead of rejecting a real
      // send because the server timestamp trails Windows by a few seconds.
      (Number.isSafeInteger(baseline?.sequence)?item.receivedSequence>baseline.sequence:item.ts>=since-1000);
    const found=this.receipts.find(match);if(found&&this.claimReceipt(found))return Promise.resolve(found);
    if(!this.state.ready)return Promise.resolve(null);
    return new Promise(resolve=>{let finished=false;const waiter={match,finish:value=>{
      if(finished||(value&&!this.claimReceipt(value)))return false;
      finished=true;clearTimeout(waiter.timer);this.waiters=this.waiters.filter(item=>item!==waiter);resolve(value);return true;}};
      waiter.timer=setTimeout(()=>waiter.finish(null),timeout);this.waiters.push(waiter);});
  }
  probe(settings) {
    return new Promise((resolve,reject)=>{
      const child=this.spawnProcess(path.join(ROOT,'runtime','wechat-db','venv','Scripts','python.exe'),['-X','utf8',path.join(ROOT,'src','wechat-db','reader.py'),
        '--credentials',path.join(DATA_DIR,'desktop-wechat','database.private.json'),'--media-root',wechatMediaRoot],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      const lines=createInterface({input:child.stdout});const members=[];let result=null,problem='';
      const timer=setTimeout(()=>{child.kill();reject(new Error('数据库只读检测超时'));},25000);
      child.stderr.resume();child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({op:'probe',...settings,testMedia:false})+'\n');
      lines.on('line',line=>{try{const value=JSON.parse(line);
        if(value.event==='db-roster')members.push(...(value.members||[]).map(item=>({...item,chatName:value.chatName})));
        if(value.event==='db-probe')result=value;
        if(value.event==='db-error')problem=String(value.code||'数据库读取失败');
      }catch{}});
      child.on('error',error=>{clearTimeout(timer);reject(new Error('数据库组件未就绪：'+error.name));});
      child.on('exit',()=>{clearTimeout(timer);lines.close();if(!result)return reject(new Error(problem||'数据库验证未完成'));
        this.state.ownerCandidates=members;this.state.verified=true;this.state.probeAt=Date.now();this.state.lastError='';
        this.onStatus(this.state);resolve({ok:true,readOnly:true,targetCount:result.targetCount,unresolvedTargets:result.unresolvedTargets,messageCounts:result.messageCounts,ownerCandidates:members});});
    });
  }
  stop(){
    const child=this.proc;this.proc=null;this.key='';this.state.connected=false;this.state.ready=false;
    this.clearReceipts();
    if(child){child.stdin.end(JSON.stringify({op:'stop'})+'\n');const timer=setTimeout(()=>{if(child.exitCode===null)child.kill();},3000);timer.unref?.();child.once('exit',()=>clearTimeout(timer));}
  }
}
