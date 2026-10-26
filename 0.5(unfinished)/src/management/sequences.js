const streams=new WeakSet();
export function sequence(iterator,meta={}){const value={meta,[Symbol.asyncIterator]:iterator};streams.add(value);return value;}
export const isSequence=value=>value!==null&&typeof value==='object'&&streams.has(value);

export function createEventChannel({now=Date.now,maxEvents=2000,maxBytes=4*1024*1024}={}){
  const buffer=[],listeners=new Set(),observed=new WeakSet(),losses=new Map();let bytes=0;
  function cloneItem(record){const value=structuredClone(record.event);observed.add(value);return value;}
  function lost(record){losses.set(record.group,Math.max(losses.get(record.group)??0,Number(record.event.time)*1000||record.at));if(losses.size>256)losses.delete(losses.keys().next().value);}
  return {
    add(envelope){const group=String(envelope.id),type=envelope.type==='message_observed'?'message':envelope.type;let text;try{text=JSON.stringify(envelope.event);}catch{return;}if(text.length>128000){lost({group,event:envelope.event,at:now()});return;}
      const record={group,type,event:JSON.parse(text),at:now(),bytes:text.length};buffer.push(record);bytes+=record.bytes;
      while(buffer.length>maxEvents||bytes>maxBytes||buffer[0]?.at<now()-3600000){const old=buffer.shift();bytes-=old.bytes;lost(old);}
      for(const listener of listeners)listener.accept(record);
    },
    source({group,type,since,signal}){const meta={group,hasLoss:start=>(losses.get(group)??-Infinity)>=start};return sequence(()=>{
      let closed=false,error=null,pending=null,queuedBytes=0;const queue=[];
      const stop=reason=>{if(closed)return;closed=true;error=reason;listeners.delete(listener);signal?.removeEventListener('abort',abort);if(pending){const p=pending;pending=null;error?p.reject(error):p.resolve({done:true});}};
      const abort=()=>stop(Object.assign(Error('事件流已取消'),{name:'AbortError'}));
      const listener={stop,accept(record){if(closed||record.group!==group||record.type!==type||record.at<since)return;const value=cloneItem(record);if(pending){const p=pending;pending=null;p.resolve({value,done:false});}else{queue.push({value,bytes:record.bytes});queuedBytes+=record.bytes;if(queue.length>maxEvents||queuedBytes>maxBytes)stop(Error('事件流缓冲已满，请减少处理量'));}}};
      listeners.add(listener);for(const record of buffer)listener.accept(record);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      return {next(){if(error)return Promise.reject(error);if(closed)return Promise.resolve({done:true});if(queue.length){const item=queue.shift();queuedBytes-=item.bytes;return Promise.resolve({value:item.value,done:false});}return new Promise((resolve,reject)=>{pending={resolve,reject};});},return(){stop();return Promise.resolve({done:true});}};
    },meta);},
    owns(item,group,id){return observed.has(item)&&String(item.group_id)===String(group)&&String(item.message_id)===String(id);},
    clear(){buffer.length=0;bytes=0;losses.clear();},
    close(){for(const listener of [...listeners])listener.stop(Object.assign(Error('事件源已关闭'),{name:'AbortError'}));listeners.clear();buffer.length=0;bytes=0;},
    get subscriptions(){return listeners.size;},
  };
}

export function windowSequence(source,start,end,{now=Date.now,signal,dry=false,startedAt=now()}={}){
  if(!isSequence(source))throw Error('时间窗需要连接事件流');if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>3600)throw Error('时间窗应为有效且不超过 3600 秒的范围');
  if(!dry&&start*1000>now()+2000)throw Error('时间窗起点晚于当前时间');if(source.meta?.hasLoss?.(start*1000))throw Error('时间窗数据已超出事件缓存');
  const meta={endTime:end,currentTime:start};return sequence(()=>{
    const iterator=source[Symbol.asyncIterator](),queue=[];let intakeClosed=false,returned=false,error=null,timer,pending=null,bytes=0;
    const settle=()=>{if(!pending)return;const waiting=pending;pending=null;if(error)waiting.reject(error);else if(queue.length){const item=queue.shift();bytes-=item.bytes;meta.currentTime=item.value.time;waiting.resolve({value:item.value,done:false});}else if(intakeClosed)waiting.resolve({done:true});else pending=waiting;};
    const finish=reason=>{if(intakeClosed)return;intakeClosed=true;error=reason;clearTimeout(timer);signal?.removeEventListener('abort',abort);void iterator.return?.();settle();};
    const abort=()=>finish(Object.assign(Error('时间窗已取消'),{name:'AbortError'}));
    if(!dry)timer=setTimeout(()=>finish(),Math.max(0,end*1000-now()));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    // Intake is independent of downstream work: expiry stops new arrivals,
    // while already observed items remain available until the consumer drains.
    void(async()=>{try{while(!intakeClosed){const item=await iterator.next();if(intakeClosed)return;if(item.done){finish();return;}const time=item.value?.time;if(!Number.isFinite(time))throw Error('时间窗事件缺少时间字段');if(time>=start&&time<end){const size=JSON.stringify(item.value).length;queue.push({value:item.value,bytes:size});bytes+=size;if(queue.length>2000||bytes>4*1024*1024)throw Error('时间窗缓冲已满，无法保证完整处理');settle();}else if(dry&&time>=end){finish();return;}}}catch(reason){finish(reason);}})();
    return {next(){if(returned)return Promise.resolve({done:true});if(signal?.aborted)return Promise.reject(Object.assign(Error('时间窗已取消'),{name:'AbortError'}));return new Promise((resolve,reject)=>{pending={resolve,reject};settle();});},return(){returned=true;queue.length=0;bytes=0;finish();settle();return Promise.resolve({done:true});}};
  },meta);
}

export function simulatedEvents(run,type,group,since=-Infinity){
  const currentType={group_poke:'poke',message_recalled:'recall',member_muted:'ban',member_unmuted:'ban'}[run.rule.nodes[0].type]??run.rule.nodes[0].type,current={...run.event,group_id:run.group,time:run.event.time??run.startedAt/1000};
  const messages=[...(run.scenario.history??[]),...(run.scenario.messages??[])].map((item,index)=>({group_id:String(item.groupId??run.group),user_id:String(item.userId),message_id:item.messageId??100001+index,time:item.time??(run.startedAt/1000+Number(item.afterSeconds)),message:[{type:'text',data:{text:String(item.text??'')}}]}));
  const supplied=(run.scenario.events??[]).filter(item=>item.type===type).map(item=>({...item.event,group_id:String(item.groupId??run.group),time:item.event?.time??run.startedAt/1000+Number(item.afterSeconds??0)}));
  return sequence(()=>{const items=[...(currentType===type?[current]:[]),...(type==='message'?messages:[]),...supplied].filter(item=>String(item.group_id)===String(group)&&item.time*1000>=since).sort((a,b)=>a.time-b.time);let index=0;return {next:async()=>index<items.length?{value:items[index++],done:false}:{done:true},return:async()=>({done:true})};});
}
