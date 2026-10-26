import fs from 'node:fs';
import path from 'node:path';
import {validateLiteralValue} from './ports.js';
export function createGraphState({dataDir,now=Date.now,log=console}={}){
  const file=path.join(dataDir,'graph-state.json'),entries=new Map(),sizes=new WeakMap();let timer=null,tail=Promise.resolve();
  try{if(fs.statSync(file).size<=8*1024*1024)for(const [key,item]of JSON.parse(fs.readFileSync(file,'utf8'))){if(entries.size>=10000)break;if(typeof key==='string'&&key.length<500&&item&&(item.expires===0||item.expires>now()))entries.set(key,{value:validateLiteralValue(item.value),expires:item.expires});}}catch{}
  const size=map=>[...map].reduce((sum,[key,item])=>sum+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(item.value))+40,0);
  sizes.set(entries,size(entries));
  const prune=()=>{for(const [key,item]of entries)if(item.expires&&item.expires<=now())entries.delete(key);sizes.set(entries,size(entries));};
  function flush(){clearTimeout(timer);timer=null;prune();const data=JSON.stringify([...entries]);tail=tail.then(async()=>{await fs.promises.mkdir(dataDir,{recursive:true});await fs.promises.writeFile(file+'.tmp',data);await fs.promises.rename(file+'.tmp',file);}).catch(error=>log.warn?.('节点状态保存失败：'+error.message));return tail;}
  return {apply(type,input,{ruleId,dryMap}={}){const map=dryMap??entries,key=JSON.stringify([input.scope==='account'?'$account':ruleId,input.key]),old=map.get(key),previous=old&&(!old.expires||old.expires>now())?structuredClone(old.value):undefined;let value;
      if(type==='state_read')return {previous,value:previous===undefined?input.fallback:previous};
      if(type==='state_add'){const base=previous===undefined?input.initial:previous;if(typeof base!=='number'||!Number.isFinite(base))throw Error('状态中的原值不是数值');value=base+input.amount;if(!Number.isFinite(value)||Math.abs(value)>1e12)throw Error('累加结果超出数值范围');}else value=validateLiteralValue(input.value);
      if(!map.has(key)&&map.size>=10000)throw Error('状态键超过 10000 个，请设置过期时间');const nextSize=(sizes.get(map)??size(map))-(old?Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(old.value))+40:0)+Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(value))+40;if(nextSize>8*1024*1024)throw Error('状态总大小超过 8 MiB');
      const expires=input.ttl_seconds?now()+input.ttl_seconds*1000:0;map.set(key,{value:structuredClone(value),expires});sizes.set(map,nextSize);if(!dryMap){clearTimeout(timer);timer=setTimeout(()=>void flush(),150);}return {previous,value};
    },async close(){if(timer)await flush();await tail;},};
}
