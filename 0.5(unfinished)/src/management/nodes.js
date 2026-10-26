import crypto from 'node:crypto';
import {ids,validId} from './catalog.js';
export const messageText=event=>Array.isArray(event?.message)?event.message.filter(s=>s.type==='text').map(s=>s.data?.text??s.text??'').join(''):String(event?.raw_message??event?.message??event?.comment??'');
export const textMatches=(text,value,match='contains')=>match==='equals'?text===value:match==='prefix'?text.startsWith(value):match==='suffix'?text.endsWith(value):text.includes(value);
export const messageFingerprint=event=>crypto.createHash('sha256').update(messageText(event)).update(JSON.stringify((Array.isArray(event?.message)?event.message:[]).filter(s=>s.type!=='text').map(s=>({type:s.type,file:s.data?.file??s.file,id:s.data?.id??s.id})))).digest('hex');
export const mentionedUsers=event=>[...new Set((Array.isArray(event?.message)?event.message:[]).filter(s=>s.type==='at').map(s=>String(s.data?.qq??s.id??s.qq??'')).filter(validId))];
export function createMessageWindow(){
  const groups=new Map(),losses=new Map();let total=0;
  const lost=(group,time)=>{const previous=losses.get(group)??0;losses.delete(group);losses.set(group,Math.max(previous,time));if(losses.size>256)losses.delete(losses.keys().next().value);};
  const drop=(state)=>{const old=state.events.shift();if(old){lost(state.group,old.sentAt??old.at);state.mids.delete(old.mid);total--;}};
  return {
    add(group,event,at){let state=groups.get(group);if(!state){state={group,events:[],mids:new Set()};groups.set(group,state);}else {groups.delete(group);groups.set(group,state);}
      const mid=event.message_id==null?null:String(event.message_id);if(mid&&state.mids.has(mid))return false;
      state.events.push({at,sentAt:Number.isFinite(event.time)?event.time*1000:undefined,user:String(event.user_id??event.sender?.user_id??''),hash:messageFingerprint(event),mid});if(mid)state.mids.add(mid);total++;
      while(state.events.length>2000||state.events[0]?.at<at-3600000)drop(state);
      while(total>10000){const [key,old]=groups.entries().next().value;drop(old);if(!old.events.length)groups.delete(key);}
      while(groups.size>128){const [key,old]=groups.entries().next().value;for(const item of old.events)lost(key,item.sentAt??item.at);total-=old.events.length;groups.delete(key);}
      return true;
    },
    recent(group,since){return (groups.get(String(group))?.events??[]).filter(item=>item.at>=since);},
    hasLossSince(group,since){return (losses.get(String(group))??-Infinity)>=since;},
    clear(){groups.clear();losses.clear();total=0;},get size(){return total;},
  };
}
export function renderManagementText(template,run,at){
  const date=new Date(at),values={user:run.user,group:run.group,nickname:run.event.sender?.nickname??run.user,card:run.event.sender?.card??'',count:String(run.count??0),date:`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,time:`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`};
  return String(template??'').replace(/\{\{(user|group|nickname|card|count|date|time)\}\}/g,(_all,key)=>String(values[key]));
}

// Return null for a default/extension handler. Every registered built-in either
// has explicit semantics here or is handled by the main execution loop.
export async function evaluateExtendedNode(run,node,ctx){
  const c=node.config,type=node.type,text=messageText(run.event),at=ctx.at(),date=new Date(at),random=()=>ctx.random();
  const result=(pass=true,detail='')=>({pass,detail});
  if(type==='text_match')return result(textMatches(text,c.text,c.match));
  if(type==='message_equals'){const message=run.event.message;return result((typeof message==='string'?!/\[CQ:/.test(message):Array.isArray(message)&&message.length>0&&message.every(s=>s.type==='text'))&&text===c.text);}
  if(type==='has_link')return result(/https?:\/\//i.test(text));
  if(type==='message_kind')return result(c.kind==='file'&&run.event.notice_type==='group_upload'||(Array.isArray(run.event.message)?run.event.message:typeof run.event.message==='string'?[{type:'text'}]:[]).some(s=>s.type===c.kind));
  if(type==='fork')return result(true,'同时分发至后续路径');
  if(type==='text_length'){const length=[...text].length;return result(length>=c.min&&length<=c.max,`${length} 字符`);}
  if(type==='contains_any'||type==='contains_all'){const words=c.text.split('\n').map(s=>s.trim()).filter(Boolean);return result(words.length>0&&(type==='contains_any'?words.some(w=>text.includes(w)):words.every(w=>text.includes(w))));}
  if(type==='mentions_bot')return result(mentionedUsers(run.event).includes(run.self));
  if(type==='mentions_users')return result(mentionedUsers(run.event).some(id=>ids(c.users).includes(id)));
  if(type==='message_frequency'||type==='repeated_message'){
    const recent=ctx.recent(at-c.seconds*1000).filter(item=>(type==='message_frequency'&&c.scope==='group'||item.user===run.user)&&(type!=='repeated_message'||item.hash===messageFingerprint(run.event)));
    return result(recent.length>=c.count,`${recent.length} 条`);
  }
  if(type==='weekday')return result(ids(c.days).includes(String(date.getDay()||7)));
  if(type==='date_range'){const day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;return result(day>=c.start&&day<=c.end);}
  if(['joined_recently','card_matches','nickname_matches','has_card'].includes(type)){
    const member=await ctx.member(run.user);
    if(type==='joined_recently')return result(Number(member?.joinTime)>0&&at/1000>=Number(member.joinTime)&&at/1000-Number(member.joinTime)<c.seconds);
    if(type==='has_card')return result(!!member?.card?.trim());return result(textMatches(String(type==='card_matches'?member?.card??'':member?.nickname??''),c.text,c.match));
  }
  if(type==='bot_owner')return result((await ctx.member(run.self))?.role==='owner');
  if(type==='target_count')return result(run.targets.length>=c.min&&run.targets.length<=c.max,`${run.targets.length} 位用户`);
  if(type==='group_is')return result(ids(c.groups).includes(run.group));
  if(type==='chance')return result(random()<c.percent/100);
  if(type==='switch_text'||type==='switch_user'||type==='switch_role'){
    const role=type==='switch_role'?(await ctx.member(run.user))?.role:null;
    const route=node.routes.find(route=>type==='switch_text'?textMatches(text,route.value,route.match):type==='switch_user'?ids(route.value).includes(run.user):route.value===role);
    return {...result(!!route,route?.label??'其他'),edge:route?.next??node.otherwise??'$end',port:route?`route:${route.id}`:'otherwise'};
  }
  if(type==='target_union')run.targets=[...new Set([...run.targets,...ids(c.users)])];
  else if(type==='target_clear')run.targets=[];
  else if(type==='target_mentions')run.targets=mentionedUsers(run.event).filter(id=>id!==run.self);
  else if(type==='target_exclude')run.targets=run.targets.filter(id=>!ids(c.users).includes(id));
  else if(type==='target_intersect')run.targets=run.targets.filter(id=>ids(c.users).includes(id));
  else if(type==='target_except_sender')run.targets=run.targets.filter(id=>id!==run.user);
  else if(type==='target_recent')run.targets=[...new Set(ctx.recent(at-c.seconds*1000).map(m=>m.user))].filter(id=>id&&id!==run.self);
  else if(type==='target_random'){
    const pool=[...run.targets];for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}run.targets=pool.slice(0,c.count);
  }else if(type==='target_role'||type==='target_by_card'||type==='target_by_nickname'){
    const members=await ctx.members();run.targets=members.filter(m=>String(m.userId)!==run.self&&(type==='target_role'?m.role===c.role:textMatches(String(type==='target_by_nickname'?m.nickname??'':m.card??''),c.text,c.match))).map(m=>String(m.userId));
  }else if(type==='wait_until'){
    const [h,m]=c.time.split(':').map(Number),target=new Date(at);target.setHours(h,m,0,0);if(target.getTime()<=at)target.setDate(target.getDate()+1);await ctx.wait((target-at)/1000);
  }else if(type==='random_delay')await ctx.wait(c.min+random()*(c.max-c.min));
  else if(type==='cooldown_gate'){
    const key=JSON.stringify([run.rule.id,run.scopeId??run.group,run.user,node.id]),due=ctx.gates.get(key)??0;
    if(at<due)return result(false,`剩余 ${Math.ceil((due-at)/1000)} 秒`);ctx.gates.delete(key);ctx.gates.set(key,at+c.seconds*1000);if(ctx.gates.size>10000)ctx.gates.delete(ctx.gates.keys().next().value);return result(true);
  }else if(['counter_add','counter_check','counter_reset','counter_daily'].includes(type)){
    if(c.scope==='user'&&!run.user)throw Error('按用户计次需要一个触发用户');
    const countAt=type==='counter_daily'?ctx.input('at')*1000:at,day=new Date(countAt),dayKey=`${day.getFullYear()}-${day.getMonth()+1}-${day.getDate()}`,key=JSON.stringify([run.rule.id,run.scopeId??run.group,c.scope==='group'?'$group':run.user,c.key,...(type==='counter_daily'?['$day',dayKey]:[])]),entry=ctx.state.get(key),value=entry?.expires>countAt?entry.value:0;
    if(type==='counter_add'||type==='counter_daily'){run.count=Math.min(1000000,value+c.amount);const expires=type==='counter_daily'?new Date(day.getFullYear(),day.getMonth(),day.getDate()+2).getTime():at+c.seconds*1000;ctx.state.delete(key);ctx.state.set(key,{value:run.count,expires});if(ctx.state.size>10000)ctx.state.delete(ctx.state.keys().next().value);ctx.persist();}
    else if(type==='counter_reset'){run.count=0;ctx.state.delete(key);ctx.persist();}
    else {run.count=value;return result(value>=c.count,`${value} 次`);}return result(true,`${run.count} 次`);
  }else if(type==='note')return result(true,node.bindings?.text?c.text:renderManagementText(c.text,run,at));
  else if(type==='join')return result(true,'继续共同的后续步骤');
  else return null;
  if(run.targets.length>1000)throw Error('所选用户超过 1000 人，请拆分规则');
  return result(true,run.targets.length?`${run.targets.length} 位用户`:'');
}
