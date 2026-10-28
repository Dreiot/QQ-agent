// Native WeChat transport only. Persona, policies and receipts remain in the channel.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DATA_DIR,ROOT} from './config.js';
const execute=promisify(execFile);

const unavailable=message=>Object.assign(new Error(message),{sendUncertain:false});
export class WechatNativeSender {
  constructor({fetchImpl=globalThis.fetch,configFile=path.join(DATA_DIR,'desktop-wechat','native-send.private.json'),loadBackend}={}) {
    this.fetch=fetchImpl;this.configFile=configFile;
    this.loadBackend=loadBackend||(()=>{const dir=path.join(ROOT,'runtime/wechat-native');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'backend-config.path'),path.resolve(this.configFile),'utf8');return execute(path.join(dir,'NativeMentionLoader.exe'),[],{windowsHide:true,timeout:15000});});
    this.nextLoadAt=0;this.probedPid=null;this.imageProbedPid=null;this.mentionProbedPid=null;
    this.state={connected:false,sendAvailable:false,backend:'native-hook',lastError:'原生发送后端尚未完成当前版本适配'};
  }
  configuration() {
    let config;
    try{config=JSON.parse(fs.readFileSync(this.configFile,'utf8'));}
    catch{throw unavailable('原生发送后端尚未配置；不会回退到窗口按键');}
    let url;
    try{url=new URL(config.baseUrl);}catch{throw unavailable('原生发送接口地址无效');}
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
      throw unavailable('原生发送接口必须使用本机回环地址');
    if(!/^[a-f0-9]{64}$/.test(config.token||'')||!/^\d+\.\d+\.\d+\.\d+$/.test(config.expectedVersion||''))
      throw unavailable('原生发送配置缺少令牌或精确微信版本');
    // A profile is enabled only after its ABI and a real database receipt are accepted.
    if(config.accepted!==true)throw unavailable('当前版本原生发送仍待实发验收，未启用');
    return {...config,baseUrl:url.origin};
  }
  async request(config,route,body,accountDirectory) {
    const submitted=body!==undefined;
    let response;
    try{
      response=await this.fetch(config.baseUrl+route,{method:submitted?'POST':'GET',redirect:'error',
        signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+config.token,
          ...(submitted?{'Content-Type':'application/json','X-WeChatAgent-Account':accountDirectory}:{})},
        ...(submitted?{body:JSON.stringify(body)}:{})});
    }catch(error){throw Object.assign(new Error(submitted?'原生发送请求结果未知，不自动重发':'原生发送后端未连接',{cause:error}),{sendUncertain:submitted});}
    if(!response.ok)throw Object.assign(new Error('原生发送后端拒绝请求（HTTP '+response.status+'）'),
      {sendUncertain:submitted&&response.status>=500});
    try{return await response.json();}
    catch{throw Object.assign(new Error('原生发送后端返回内容无效'),{sendUncertain:submitted});}
  }
  async health(database) {
    try{
      const config=this.configuration();let data;
      try{data=await this.request(config,'/WeChatAgent/health');}
      catch(error){
        if(error.cause?.cause?.code!=='ECONNREFUSED'&&error.cause?.code!=='ECONNREFUSED')throw error;
        if(Date.now()<this.nextLoadAt)throw error;
        this.nextLoadAt=Date.now()+30000;await this.loadBackend(config);
        await new Promise(resolve=>setTimeout(resolve,200));
        data=await this.request(config,'/WeChatAgent/health');
      }
      const accounts=data.databaseAccounts;
      if(data.backend!=='wechat-hook'||!['WeChatAgent-1','QQAgent-native-1'].includes(data.integration))
        throw unavailable('不是已适配的原生发送后端');
      if(data.version!==config.expectedVersion)throw unavailable('原生发送版本不匹配：'+String(data.version||'未知'));
      const account=String(database?.accountDirectory||'').toLowerCase();
      if(!database?.connected||!account||!Array.isArray(accounts)||accounts.length!==1||accounts[0]!==account)
        throw unavailable('原生发送与数据库读取账号尚未匹配');
      if(data.nativeTextSend===false&&data.integration==='QQAgent-native-1'&&!data.faulted&&this.probedPid!==data.pid){
        this.probedPid=data.pid;
        // A previously accepted binary may verify its constructors after a WeChat restart. No send is performed.
        const probe=await this.request(config,'/WeChatAgent/probe',{},account);
        if(probe.ok===true)data=await this.request(config,'/WeChatAgent/health');
      }
      let imageError='';
      if(config.nativeImagesAccepted===true&&data.nativeImageSend!==true&&data.integration==='QQAgent-native-1'&&!data.faulted&&this.imageProbedPid!==data.pid){
        this.imageProbedPid=data.pid;
        try{const probe=await this.request(config,'/WeChatAgent/probe-image',{},account);
          if(probe.ok===true)data=await this.request(config,'/WeChatAgent/health');
        }catch(error){imageError=error.message;}
      }
      if(data.nativeTextSend===false||data.faulted)throw unavailable('当前微信版本的原生文字发送不可用');
      let mentionError='';
      if(config.nativeMentionsAccepted===true&&data.nativeMentionSend!==true&&!data.faulted&&this.mentionProbedPid!==data.pid){
        this.mentionProbedPid=data.pid;
        try{const probe=await this.request(config,'/WeChatAgent/probe-mention',{},account);
          if(probe.ok===true)data=await this.request(config,'/WeChatAgent/health');
        }catch(error){mentionError=error.message;}
      }
      this.state={connected:true,sendAvailable:true,backend:'native-hook',clientVersion:data.version,
        pid:Number(data.pid)||0,lastError:'',nativeImagesAccepted:config.nativeImagesAccepted===true,
        nativeImageSend:config.nativeImagesAccepted===true&&data.nativeImageSend===true,imageError,
        nativeMentionSend:config.nativeMentionsAccepted===true&&data.nativeMentionSend===true,mentionError};
      return {config,account,data};
    }catch(error){this.state={...this.state,connected:false,sendAvailable:false,lastError:error.message};throw error;}
  }
  async sendText({targetStableId,text,database,atUserIds=[]}) {
    if(typeof targetStableId!=='string'||!targetStableId||targetStableId.length>256||
        typeof text!=='string'||!text||Buffer.byteLength(text,'utf8')>16000||targetStableId.includes('\0')||text.includes('\0'))
      throw unavailable('原生文字发送参数无效');
    if(!Array.isArray(atUserIds)||atUserIds.length>8||atUserIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))
      throw unavailable('原生艾特需要真实成员 ID，不支持全体或显示昵称');
    if(atUserIds.length&&!targetStableId.endsWith('@chatroom'))throw unavailable('原生艾特只用于群聊');
    const {config,account}=await this.health(database);
    if(atUserIds.length&&!this.state.nativeMentionSend)throw unavailable(this.state.mentionError||'原生艾特尚未启用，未提交消息');
    const data=await this.request(config,atUserIds.length?'/SendTextAtMsg':'/SendTextMsg',
      {wxidorgid:targetStableId,msg:text,...(atUserIds.length?{atUserIds:[...new Set(atUserIds)]}:{})},account);
    if(data.ret!==0)throw Object.assign(new Error('原生发送未被接受'),{sendUncertain:false});
    // ret=0 means accepted, never delivered. The channel must confirm a fresh server ID.
    return {submitted:true,sendConfirmed:false,foregroundChanged:false,transport:'native-hook'};
  }
  async sendImage({targetStableId,file,database}){
    if(typeof targetStableId!=='string'||!targetStableId||targetStableId.length>256||targetStableId.includes('\0')||
      typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw unavailable('原生图片发送参数无效');
    const {config,account}=await this.health(database);
    if(!this.state.nativeImageSend)throw unavailable(this.state.imageError||'原生后台图片尚未就绪，未提交，也不切换前台发送');
    const result=await this.request(config,'/SendImgMsg',{wxidorgid:targetStableId,path:file},account);
    if(result.ret!==0)throw Object.assign(Error('原生图片发送未被接受'),{sendUncertain:false});
    return{submitted:true,sendConfirmed:false,foregroundChanged:false,transport:'native-hook-image'};
  }
}
