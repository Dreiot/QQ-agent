import {conversationScope,hasConversation,ruleConversations} from './conversations.js';
import {validateLiteralValue,validatePortValue} from './ports.js';
import {createEventChannel,windowSequence,simulatedEvents,isSequence} from './sequences.js';
import {createGraphState} from './state-store.js';
import {recallMessageWindow} from './recall-window.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {NODE_CATALOG,validateManagement,validateNodeConfig,ids,nodeEdges} from './catalog.js';
import {createValueRuntime} from './value-runtime.js';
import {executeManagementFlow} from './flow.js';
import {evaluateExtendedNode,createMessageWindow,messageFingerprint,messageText,renderManagementText,textMatches} from './nodes.js';

const actionTypes=new Set(['mute','unmute','kick','rename_group','rename_card','whole_mute','whole_unmute','recall','grant_admin','revoke_admin','special_title','approve_join','reject_join','send_text','send_at']);
const textOf=messageText;
const cancel=()=>Object.assign(Error('规则已停止、运行已暂停或账号连接已改变'),{name:'AbortError'});
function found(node,event){const text=textOf(event),c=node.config;return ['contains','equals','prefix','suffix'].includes(c.match)?textMatches(text,c.text,c.match):c.match==='link'?/https?:\/\//i.test(text):c.match==='file'&&event.notice_type==='group_upload'||(Array.isArray(event?.message)?event.message:[]).some(s=>s.type===c.match);}

export function createGroupManagement({config,transport,send,dataDir,bus,isPaused=()=>false,identityOf=()=>transport.selfId,catalog=NODE_CATALOG,handlers={},now=Date.now,log=console}={}){
  const file=path.join(dataDir,'group-management-runs.json');
  let running=false,timer=null,off=null,offPause=null,rules=[],history=[],closed=false;
  const active=new Map(),cooldowns=new Map(),scheduled=new Map(),waiters=new Set(),liveRules=new Map();
  const counters=new Map(),gates=new Map(),recallLedger=new Map(),window=createMessageWindow(),stateFile=path.join(dataDir,'group-management-state.json');let windowIdentity=null;
  const channel=createEventChannel({now}),graphState=createGraphState({dataDir,now,log});
  const specs=new Map(catalog.map(spec=>[spec.type,spec]));
  let saveTimer=null,publishTimer=null,saveTail=Promise.resolve();
  try{const old=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(old))history=old.slice(0,100);}catch{}
  try{if(fs.statSync(stateFile).size<=8*1024*1024)for(const [key,item] of JSON.parse(fs.readFileSync(stateFile,'utf8'))){if(counters.size>=10000)break;if(typeof key==='string'&&key.length<500&&Number.isInteger(item?.value)&&item.value>=0&&item.value<=1000000&&Number.isFinite(item.expires)&&item.expires>now()&&item.expires<now()+2678400000)counters.set(key,item);}}catch{}
  function publish(){if(!publishTimer&&!closed)publishTimer=setTimeout(()=>{publishTimer=null;bus?.emit('management.update',{changed:true});},80);}
  function flushHistory(){clearTimeout(saveTimer);saveTimer=null;for(const [key,value]of counters)if(value.expires<=now())counters.delete(key);const snapshot=JSON.stringify(history),state=JSON.stringify([...counters]);saveTail=saveTail.then(async()=>{await fs.promises.mkdir(dataDir,{recursive:true});await fs.promises.writeFile(file+'.tmp',snapshot);await fs.promises.rename(file+'.tmp',file);await fs.promises.writeFile(stateFile+'.tmp',state);await fs.promises.rename(stateFile+'.tmp',stateFile);}).catch(e=>log.warn?.(`[管理] 执行记录保存失败：${e.message}`));return saveTail;}
  function persist(){if(closed)return;publish();clearTimeout(saveTimer);saveTimer=setTimeout(()=>void flushHistory(),250);}
  function reload(){
    // Visual placement is editor metadata; moving a card must not cancel a running rule.
    let next;try{next=validateManagement(config.get().management??{rules:[]},catalog).rules.map(({layout,...rule})=>rule);}catch(e){next=[];log.warn?.(`[管理] 无效规则已停用：${e.message}`);}
    const previous=new Map(rules.map(rule=>[rule.id,rule]));
    rules=next.map(rule=>{const old=previous.get(rule.id);if(old&&JSON.stringify(old)===JSON.stringify(rule))return old;scheduled.delete(rule.id);return rule;});
    liveRules.clear();for(const rule of rules)liveRules.set(rule.id,rule);
    for(const item of active.values())if(!liveRules.get(item.rule.id)?.enabled||liveRules.get(item.rule.id)!==item.binding)item.controller.abort();
  }
  const connected=()=>transport.status?.().connected===true;
  function guard(run){if(run.controller.signal.aborted)throw cancel();if(run.dry)return;if(!running||isPaused()||run.identity!==identityOf()||run.self!==String(transport.selfId)||!connected()||run.source?.signal?.aborted||run.source?.current?.()===false||!run.binding?.enabled||liveRules.get(run.rule.id)!==run.binding)throw cancel();}
  function trace(run,node,status,detail='',extra={}){run.record.revision=(run.record.revision??0)+1;const skipped=status==='skipped'&&!['recall_window','for_each'].includes(node.type)?run.record.trace.find(item=>item.nodeId===node.id&&item.status==='skipped'):null;if(skipped){skipped.count=(skipped.count??1)+1;skipped.detail=`跳过 ${skipped.count} 位受保护或身份不适用的用户`;}else if(run.record.trace.length<800)run.record.trace.push({at:now(),nodeId:node.id,type:node.type,label:specs.get(node.type)?.label??node.type,status,detail,...(run.iterationPath?{iterationPath:run.iterationPath}:{}),...extra});if(!run.dry)publish();}
  function delay(run,ms){return new Promise((resolve,reject)=>{const signal=run.controller.signal;const abort=()=>{clearTimeout(t);signal.removeEventListener('abort',abort);reject(cancel());};const t=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
  function observe(run,node){
    if(!run.targets.length)throw Error('请先选择要观察的用户');
    return new Promise((resolve,reject)=>{
      const seen=new Set(),signal=run.controller.signal;let t;
      const done=(value,error)=>{clearTimeout(t);waiters.delete(waiter);signal.removeEventListener('abort',abort);error?reject(error):resolve(value);};
      const abort=()=>done(false,cancel());
      const waiter={run,accept(event){if(event.type!=='message'||event.kind!==run.kind||String(event.id)!==run.chatId)return;const raw=event.event,uid=String(raw.user_id??raw.sender?.user_id??'');if(!run.targets.includes(uid)||!textOf(raw).includes(node.config.text||''))return;seen.add(uid);if(node.config.quantifier!=='all'||run.targets.every(id=>seen.has(id)))done(true);}};
      waiters.add(waiter);t=setTimeout(()=>done(false),node.config.seconds*1000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  function simMember(run,user){const known=run.simMembers.get(String(user))??{},extra=run.scenario.memberInfo?.[user]??{};return {...known,...extra,userId:String(user),role:String(user)===run.self?run.scenario.botRole??'admin':run.scenario.roles?.[user]??extra.role??known.role??'member'};}
  async function member(run,user){guard(run);if(run.kind==='private')throw Error('该节点仅支持群聊');return run.dry?simMember(run,user):transport.actions.getModerationMember(run.group,user,{signal:run.controller.signal});}
  const at=run=>run.dry?run.startedAt+run.elapsed*1000:now();
  async function members(run){guard(run);if(run.kind==='private')throw Error('该节点仅支持群聊');const list=run.dry?[...run.simMembers.keys()].map(user=>simMember(run,user)):await transport.actions.getModerationMembers(run.group,{signal:run.controller.signal});guard(run);if(!Array.isArray(list)||list.length>10000)throw Error('群成员列表过大或无效');return list;}
  const random=run=>run.dry?Math.max(0,Math.min(.999999,Number(run.scenario.random??.5))):Math.random();
  const recent=(run,since)=>run.dry?[{at:run.startedAt,user:run.user,hash:messageFingerprint(run.event)},...(run.scenario.history??[]).map(item=>({at:run.startedAt+Number(item.afterSeconds??0)*1000,user:String(item.userId),hash:messageFingerprint({message:String(item.text??'')})})),...(run.scenario.messages??[]).filter(item=>item.afterSeconds<=run.elapsed&&(!item.groupId||String(item.groupId)===run.group)).map(item=>({at:run.startedAt+item.afterSeconds*1000,user:String(item.userId),hash:messageFingerprint({message:String(item.text??'')})}))].filter(item=>item.at>=since&&item.at<=at(run)):window.recent(run.scopeId,since).filter(item=>item.user!==run.self);
  async function invokeModeration(run,operation){
    const options={signal:run.controller.signal,current:()=>{guard(run);return true;}};
    if(operation.action!=='recall_window_message')return transport.actions.moderateGroup(run.group,operation,options);
    const key=run.group+':'+operation.messageId,existing=recallLedger.get(key);if(existing&&existing.expires>at(run)){try{const result=await existing.promise;guard(run);return result;}catch{guard(run);}}
    const entry={promise:transport.actions.moderateGroup(run.group,operation,options),expires:at(run)+3600000};recallLedger.set(key,entry);if(recallLedger.size>10000)recallLedger.delete(recallLedger.keys().next().value);try{return await entry.promise;}catch(error){if(recallLedger.get(key)===entry)recallLedger.delete(key);throw error;}
  }
  async function execute(run){
    const nodes=run.rule.nodes;
    if(!run.dry&&nodes[0].type==='message'&&nodes.some(n=>n.type==='recall_window'&&(!n.bindings?.start_time&&!Object.hasOwn(n.values??{},'start_time')||n.bindings?.start_time?.nodeId===nodes[0].id&&n.bindings.start_time.port==='time'))){
      if(!Number.isFinite(run.event.time)||run.event.time<0)throw Error('触发消息缺少有效发送时间，本轮未执行');
      if(!/^-?[1-9]\d*$/.test(String(run.event.message_id))||!Number.isSafeInteger(Number(run.event.message_id)))throw Error('触发消息缺少有效消息 ID，本轮未执行');
    }
    if(!run.dry){for(const target of nodes){const spec=specs.get(target.type);for(const port of spec.ports?.inputs??[]){const binding=target.bindings?.[port.key];if(port.preflight&&binding?.nodeId===nodes[0].id)validatePortValue({...port,required:true},run.event[binding.port]);}}}
    if(!run.dry&&(!/^[1-9]\d*$/.test(run.self)||!transport.selfId))throw Error('无法确认机器人账号，本轮未执行');
    const hooks={window:(source,start,end)=>windowSequence(source,start,end,{now,signal:run.controller.signal,dry:run.dry,startedAt:run.startedAt})};
    const values=createValueRuntime({root:run,catalog,validateConfig:validateNodeConfig,guard,trace,now,hooks});
    async function runScope(initial,values,scope=null,entry=nodes[0].id){
    await executeManagementFlow({rule:run.rule,catalog,initial,scope,entry,onContext:context=>{initial.elapsed=Math.max(initial.elapsed,context.elapsed);},signal:initial.controller.signal,onFailure:()=>initial.controller.abort(),step:async(state,original,index)=>{guard(state);trace(state,original,'running');try{if(state.kind==='private'&&specs.get(original.type)?.groupOnly)throw Error('该节点仅支持群聊');const {run,node,values:inputValues}=await values.prepare(state,original);let pass=true,memberData=null,actionSuccess=false,completedAt;let extraOutputs={};
      const extended=await evaluateExtendedNode(run,node,{input:key=>inputValues[key],at:()=>at(run),random:()=>random(run),recent:since=>recent(run,since),member:user=>member(run,user),members:()=>members(run),wait:async seconds=>{if(run.dry)run.elapsed+=seconds;else await delay(run,seconds*1000);},state:run.dry?run.simCounters:counters,gates:run.dry?run.simGates:gates,persist:()=>{if(!run.dry)persist();}});
      if(extended)pass=extended.pass;
      else if(node.type==='recall_window'){const outcome=await recallMessageWindow({run,node,startTime:inputValues.start_time,window,waiters,guard,at,member,transport,trace,ledger:recallLedger});actionSuccess=outcome.failed===0;extraOutputs=outcome;completedAt=at(run)/1000;}
      else if(node.type==='event_source'){const group=String(inputValues.group_id);if(!run.rule.groups.includes(group))throw Error('事件源群号不在规则范围');extraOutputs={detail:'事件流已建立，按需读取',events:run.dry?simulatedEvents(run,inputValues.event_type,group,at(run)-inputValues.replay_seconds*1000):channel.source({group,type:inputValues.event_type,since:at(run)-inputValues.replay_seconds*1000,signal:run.controller.signal})};}
      else if(node.type.startsWith('state_')){extraOutputs=graphState.apply(node.type,inputValues,{ruleId:run.rule.id,dryMap:run.dry?run.simState:undefined});extraOutputs.detail=node.type==='state_read'?'状态已读取':'状态已更新';}
      else if(node.type==='for_each'){
        let processed=0,failed=0;const items=inputValues.items;
        try{for await(const item of items){guard(run);if(processed>=node.config.max_items)throw Error('逐项处理已达到项数上限');if(!node.each||node.each==='$end')throw Error('请连接逐项处理的“每项”出口');
          const controller=new AbortController(),abort=()=>controller.abort();run.controller.signal.addEventListener('abort',abort,{once:true});if(run.controller.signal.aborted)abort();
          if(run.dry&&isSequence(items)&&Number.isFinite(items.meta.currentTime))run.elapsed=Math.max(run.elapsed,(items.meta.currentTime*1000-run.startedAt)/1000);
          const child={...run,targets:[...run.targets],consumed:new Set(run.consumed),controller,loopItem:item,iterationPath:[...(run.iterationPath??[]),processed+1]},childValues=values.fork(original,{item,index:processed,processed,failed},child);processed++;
          try{await runScope(child,childValues,node.id,node.each);run.elapsed=Math.max(run.elapsed,child.elapsed);}catch(error){guard(run);failed++;if(node.config.on_error!=='continue')throw error;trace(run,node,'skipped',('第 '+processed+' 项失败：'+error.message).slice(0,200));}finally{run.controller.signal.removeEventListener('abort',abort);controller.abort();}
        }}finally{if(run.dry&&isSequence(items)&&Number.isFinite(items.meta.endTime))run.elapsed=Math.max(run.elapsed,(items.meta.endTime*1000-run.startedAt)/1000);}
        extraOutputs={processed,failed,detail:`已处理 ${processed} 项，失败 ${failed} 项`};if(failed){run.record.warnings??=[];run.record.warnings.push('逐项处理：'+failed+' 项失败');}
      }
      else if(node.type==='branch_value')pass=node.config.condition;
      else if(node.type==='member_info'){if(!run.user)throw Error('读取成员信息需要提供 QQ 号');memberData=await member(run,run.user);}
      else if(node.type==='found'||node.type==='not_found')pass=found(node,run.event)===(node.type==='found');
      else if(node.type==='sender_is')pass=ids(node.config.users).includes(run.user);
      else if(node.type==='role_is')pass=(await member(run,run.user))?.role===node.config.role;
      else if(node.type==='time_between'){const date=new Date(at(run)),time=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;pass=node.config.start<=node.config.end?time>=node.config.start&&time<node.config.end:time>=node.config.start||time<node.config.end;}
      else if(node.type==='target_sender')run.targets=run.user?[run.user]:[];
      else if(node.type==='target_users')run.targets=ids(node.config.users);
      else if(node.type==='target_all'){
        const list=await members(run);if(list.length>1000)throw Error('全体用户超过 1000 人，请按特定用户拆分规则');
        run.targets=list.filter(m=>m.role==='member'&&String(m.userId)!==run.self).map(m=>String(m.userId));
      }else if(node.type==='delay'){if(!run.dry)await delay(run,node.config.seconds*1000);else run.elapsed+=node.config.seconds;}
      else if(node.type==='user_sent'||node.type==='user_not_sent'){
        let sent;if(run.dry){if(!run.targets.length)throw Error('请先选择要观察的用户');const matches=(run.scenario.messages??[]).map((m,index)=>({...m,index})).filter(m=>!run.consumed.has(m.index)&&m.afterSeconds>=run.elapsed&&m.afterSeconds<=run.elapsed+node.config.seconds&&(!m.groupId||String(m.groupId)===run.group)&&run.targets.includes(String(m.userId))&&String(m.text??'').includes(node.config.text||''));sent=node.config.quantifier==='all'?run.targets.every(id=>matches.some(m=>String(m.userId)===id)):matches.length>0;const end=sent?(node.config.quantifier==='all'?Math.max(...run.targets.map(id=>Math.min(...matches.filter(m=>String(m.userId)===id).map(m=>m.afterSeconds)))):Math.min(...matches.map(m=>m.afterSeconds))):run.elapsed+node.config.seconds;for(const m of matches)if(m.afterSeconds<=end)run.consumed.add(m.index);run.elapsed=end;}else sent=await observe(run,node);
        pass=node.type==='user_sent'?sent:!sent;
      }else if(actionTypes.has(node.type)){
        const targeted=['mute','unmute','kick','rename_card','grant_admin','revoke_admin','special_title'].includes(node.type),targets=targeted?run.targets:[null];if(targeted&&!targets.length)throw Error('执行前需要选择用户');
        const requiresAdmin=!['send_text','send_at'].includes(node.type);
        for(const userId of targets){guard(run);const self=requiresAdmin?await member(run,run.self):null;if(requiresAdmin&&!['owner','admin'].includes(self?.role))throw Error('此操作需要机器人为群主或管理员，当前权限不足');
          if(specs.get(node.type)?.ownerOnly&&self.role!=='owner')throw Error('该操作仅机器人为群主时可执行');
          if(userId){const target=await member(run,userId);guard(run);if(userId===run.self||target?.role!==(node.type==='revoke_admin'?'admin':'member')){trace(run,node,'skipped',`跳过受保护或身份不适用的用户 ${userId}`);continue;}}
          if(node.type==='recall'&&!run.event.message_id)throw Error('本轮没有可以撤回的触发消息');
          if(['approve_join','reject_join'].includes(node.type)&&(!run.event.flag||run.event.request_type!=='group'||run.event.sub_type!=='add'||String(run.event.group_id)!==run.group))throw Error('本轮没有可以处理的真实入群申请');
          const textPort=specs.get(node.type).ports?.inputs.find(p=>p.configKey==='text')?.key,boundText=textPort&&node.bindings?.[textPort];
          const operation={action:node.type,userId,seconds:node.type==='unmute'?0:node.config.seconds,value:boundText?String(node.config.text??''):renderManagementText(node.config.text,run,at(run)),messageId:run.event.message_id,...(['approve_join','reject_join'].includes(node.type)?{flag:run.event.flag}:{}),...(node.type==='send_at'?{users:[...run.targets]}:{})};
          const maxText={rename_group:60,rename_card:60,special_title:18,send_text:2000,send_at:2000,reject_join:100}[node.type];if(maxText&&operation.value.length>maxText)throw Error(`替换变量后的内容超过 ${maxText} 字，请缩短内容`);
          if(node.type==='send_at'&&(!run.targets.length||run.targets.length>20))throw Error('提醒需要选择 1–20 位用户');
          if(run.dry){if(node.type==='recall'&&(run.scenario.recallFailures??[]).map(String).includes(String(operation.messageId)))throw Error('模拟撤回失败');run.record.actions.push(operation);}
          else if(node.type==='send_text'||node.type==='send_at'){
            if(!send)throw Error('消息发送队列尚未就绪');
            const beforeSend=async()=>{guard(run);};
            const options={signal:run.controller.signal,beforeSend};
            const result=node.type==='send_at'?await send.sendSegments((run.kind==='private'?`private:${run.chatId}`:`group:${run.group}`),[...run.targets.map(id=>({type:'at',id})),{type:'text',text:operation.value}],options):await send.sendTextBatch((run.kind==='private'?`private:${run.chatId}`:`group:${run.group}`),operation.value,options);if(result?.ok===false)throw Error(`管理消息未完整发送（已发送 ${result.sent?.length??0} 条）`);
          }else await invokeModeration(run,node.type==='recall'&&((run.dry&&run.loopItem)||channel.owns(run.loopItem,run.group,operation.messageId))?{...operation,action:'recall_window_message',observedGroupId:run.group}:operation);actionSuccess=true;completedAt=at(run)/1000;
        }
      }else if(node.type==='stop'){values.complete(state,original,run);trace(run,node,'done');return null;}
      else if(handlers[node.type]){pass=(await handlers[node.type]({node,groupId:run.group,event:structuredClone(run.event),targets:[...run.targets],signal:run.controller.signal,dryRun:run.dry}))!==false;}
      else if(!specs.get(node.type)?.trigger)throw Error('该节点尚未提供执行器');
      if(node.type==='recall')extraOutputs.detail='消息 '+run.event.message_id;guard(run);const port=extended?.port??(pass?'next':'otherwise'),nextNodeIds=nodeEdges(nodes,index,catalog).filter(e=>e.port===port&&e.to!=='$end').map(e=>e.to);
      values.complete(state,original,run,{result:pass,member:memberData,success:actionSuccess,completedAt,extra:extraOutputs});trace(run,node,'done',extended?.detail||extraOutputs.detail||(specs.get(node.type)?.branch?(pass?'是':'否'):run.targets.length?`${run.targets.length} 位用户`:''),{port,nextNodeId:nextNodeIds[0]??'$end',nextNodeIds});return port;
      }catch(error){trace(state,original,error.name==='AbortError'?'cancelled':'failed',error.message);throw error;}
    }});
    }
    await runScope(run,values);
    if(run.dry&&run.scenario.inspectNodes?.length)await values.inspect(run.scenario.inspectNodes);
  }
  async function perform(rule,{group,kind='group',id,user='',event={},source,scenario=null}={}){
    const chatId=String(id??(kind==='private'?user:group)),scopeId=conversationScope(kind,chatId);if(kind==='private'){event={...event};delete event.group_id;}event={message_type:kind,...event};
    const run={rule:structuredClone(rule),binding:liveRules.get(rule.id),kind,chatId,scopeId,group:kind==='group'?String(group??chatId):undefined,user:String(user),event,source,dry:!!scenario,scenario,elapsed:0,consumed:new Set(),identity:identityOf(),self:String(transport.selfId??'10000'),targets:user?[String(user)]:[],controller:new AbortController()};
    run.startedAt=run.dry?Number(scenario.now??now()):now();run.simState=new Map();if(run.dry){if(scenario.stateValues!==undefined&&(!Array.isArray(scenario.stateValues)||scenario.stateValues.length>100))throw Error('预置状态最多 100 项');for(const item of scenario.stateValues??[]){if(typeof item.key!=='string'||!item.key||item.key.length>300)throw Error('预置状态键无效');run.simState.set(JSON.stringify([item.scope==='account'?'$account':rule.id,item.key]),{value:validateLiteralValue(item.value),expires:0});}}run.simCounters=new Map();run.simGates=new Map();
    run.simMembers=new Map((scenario?.members??[]).map(m=>typeof m==='object'?[String(m.userId),m]:[String(m),{}]));
    if(run.dry)for(const n of rule.nodes)if(n.type.startsWith('counter_')&&Object.hasOwn(scenario.counterValues??{},n.config.key)){const value=Number(scenario.counterValues[n.config.key]);if(!Number.isInteger(value)||value<0||value>1000000)throw Error('模拟计次数值无效');const day=new Date(run.startedAt);run.simCounters.set(JSON.stringify([rule.id,run.scopeId,n.config.scope==='group'?'$group':run.user,n.config.key,...(n.type==='counter_daily'?['$day',`${day.getFullYear()}-${day.getMonth()+1}-${day.getDate()}`]:[])]),{value,expires:run.startedAt+172800000});}
    run.record={id:crypto.randomUUID(),ruleId:rule.id,name:rule.name,chatKind:run.kind,chatId:run.chatId,...(run.kind==='group'?{groupId:run.group}:{}),userId:run.user,startedAt:now(),dryRun:run.dry,status:'running',trace:[],actions:[]};
    const work=(async()=>{try{await execute(run);run.record.status='done';}catch(e){run.record.status=e.name==='AbortError'?'cancelled':'failed';run.record.error=e.message;}finally{run.record.finishedAt=now();if(!run.dry){active.delete(run.record.id);history.unshift(run.record);history=history.slice(0,100);persist();}}return run.record;})();
    run.promise=work;if(!run.dry)active.set(run.record.id,run);return work;
  }
  function launch(rule,context){if(!running||isPaused()||!connected()||active.size>=32)return;const key=`${rule.id}:${context.kind??'group'}:${context.id??context.group}:${context.user??''}`;if([...active.values()].some(r=>r.rule.id===rule.id&&r.kind===(context.kind??'group')&&r.chatId===String(context.id??context.group)&&r.user===String(context.user??''))||now()-(cooldowns.get(key)??-Infinity)<rule.cooldownSeconds*1000)return;
    cooldowns.delete(key);cooldowns.set(key,now());if(cooldowns.size>10000)cooldowns.delete(cooldowns.keys().next().value);void perform(rule,context);
  }
  function handleEvent(event,source){if(!running||!['group','private'].includes(event.kind))return;
    if(windowIdentity!==identityOf()){window.clear();channel.clear();recallLedger.clear();windowIdentity=identityOf();}
    if(!isPaused()&&['message','message_observed'].includes(event.type)&&rules.some(r=>r.enabled&&hasConversation(r,event.kind,event.id))&&window.add(conversationScope(event.kind,event.id),event.event,now())===false)return;
    if(event.kind==='group'&&!isPaused()&&rules.some(r=>r.enabled&&hasConversation(r,event.kind,event.id)))channel.add(event);
    for(const item of [...waiters]){try{guard(item.run);item.accept(event);}catch{item.run.controller.abort();}}
    if(event.type==='message_observed'||String(event.event?.user_id??'')===String(transport.selfId))return;
    if(!['message','poke','recall','group_upload','join_request'].includes(event.type)&&String(event.event?.operator_id??'')===String(transport.selfId))return;
    const trigger=event.type==='poke'?'group_poke':event.type==='recall'?'message_recalled':event.type==='ban'?(Number(event.event?.duration)>0?'member_muted':'member_unmuted'):event.type;if(!specs.get(trigger)?.trigger)return;
    for(const rule of rules)if(rule.enabled&&hasConversation(rule,event.kind,event.id)&&rule.nodes[0].type===trigger)launch(rule,{kind:event.kind,id:event.id,group:event.kind==='group'?event.id:undefined,user:String(event.event?.user_id??event.event?.sender?.user_id??''),event:event.event,source});
  }
  function tick(){for(const run of active.values())try{guard(run);}catch{run.controller.abort();}
    if(!connected()||isPaused()){scheduled.clear();window.clear();channel.clear();recallLedger.clear();return;}for(const rule of rules)if(rule.enabled&&rule.nodes[0].type==='interval'){const due=scheduled.get(rule.id);if(due==null){scheduled.set(rule.id,now()+rule.nodes[0].config.seconds*1000);continue;}if(now()>=due){scheduled.set(rule.id,now()+rule.nodes[0].config.seconds*1000);for(const {kind,id} of ruleConversations(rule))launch(rule,{kind,id,group:kind==='group'?id:undefined,user:kind==='private'?id:''});}}
  }
  return {
    catalog,validate:value=>validateManagement(value,catalog),handleEvent,
    start(){if(running||closed)return;running=true;reload();off=config.onChange?.(reload);offPause=bus?.on('status',()=>{if(isPaused()){scheduled.clear();for(const run of active.values())run.controller.abort();}},{internal:true});timer=setInterval(tick,500);timer.unref?.();},
    async close(){running=false;clearInterval(timer);off?.();offPause?.();for(const run of active.values())run.controller.abort();await Promise.allSettled([...active.values()].map(r=>r.promise));clearTimeout(publishTimer);if(saveTimer)await flushHistory();await saveTail;await graphState.close();channel.close();closed=true;},
    snapshot({summary=false}={}){return {runs:[...[...active.values()].map(r=>r.record),...history].slice(0,Math.max(20,active.size)).map(r=>{if(!summary)return structuredClone(r);const {trace,actions,...meta}=r;return {...meta,traceCount:trace?.length??0};}),active:active.size,selfId:String(transport.selfId??'10000')};},
    getRun(id){const record=active.get(id)?.record??history.find(r=>r.id===id);return record?structuredClone(record):null;},
    dryRun:async(rule,scenario={})=>{
      if(!scenario||typeof scenario!=='object'||Array.isArray(scenario)||['messages','history','members','events'].some(key=>scenario[key]&&(!Array.isArray(scenario[key])||scenario[key].length>(key==='members'?1000:500))))throw Error('模拟样本过多或格式无效');
      if(scenario.random!=null&&(!Number.isFinite(Number(scenario.random))||scenario.random<0||scenario.random>=1))throw Error('概率样本应在 0 到 1 之间');if(scenario.now!=null&&!Number.isFinite(new Date(Number(scenario.now)).getTime()))throw Error('模拟时间无效');
      if(scenario.inspectNodes&&(!Array.isArray(scenario.inspectNodes)||scenario.inspectNodes.length>50||scenario.inspectNodes.some(id=>!rule.nodes.some(n=>n.id===id&&specs.get(n.type)?.pure))))throw Error('数据预览节点无效');
      const kind=scenario.chatKind??(!rule?.groups?.length&&rule?.private?.length?'private':'group');if(!['group','private'].includes(kind))throw Error('会话类型无效');
      const valid=validateManagement({rules:[{...rule,enabled:true,...(kind==='private'?{private:rule?.private?.length?rule.private:[scenario.privateId??scenario.userId??'10002']}:{groups:rule?.groups?.length?rule.groups:[scenario.groupId??'10001']})}]},catalog).rules[0],group=kind==='group'?String(scenario.groupId??valid.groups[0]??'10001'):undefined,chatId=kind==='private'?String(scenario.privateId??valid.private[0]):group,user=String(scenario.userId??(kind==='private'?chatId:valid.nodes[0].type==='interval'?'':'10002'));
      return perform(valid,{kind,id:chatId,group,user,event:{...(kind==='group'?{group_id:group}:{}),user_id:user,message_id:scenario.messageId??1,message:[{type:'text',data:{text:String(scenario.text??'')}}],...(user?{sender:{user_id:user,nickname:scenario.memberInfo?.[user]?.nickname??user,card:scenario.memberInfo?.[user]?.card??'',role:scenario.roles?.[user]??'member'}}:{}),...(valid.nodes[0].type==='join_request'?{post_type:'request',request_type:'group',sub_type:'add',comment:String(scenario.text??''),flag:'simulation-only'}:{}),...(scenario.event??{})},scenario});
    },
  };
}
