import assert from 'node:assert/strict';
import {Bus} from '../src/kernel/bus.js';
import {createHttpServer} from '../src/kernel/http.js';
import {registerAccountRoutes} from '../src/accounts/routes.js';
let token='metadata-fixture-token';const changes=new Set(),config={get:()=>({server:{token,port:0}}),onChange:fn=>{changes.add(fn);return()=>changes.delete(fn);}};
const bus=new Bus({warn(){},error(){}}),actions=[],accounts={snapshot:async()=>({accounts:[{id:'primary',accountId:'12345678'}]}),start:async id=>actions.push(['start',id]),stop:async id=>actions.push(['stop',id])};
const server=createHttpServer({config,log:{error(){}}});registerAccountRoutes(server,{accounts,bus,config});const port=await server.listen(),base='http://127.0.0.1:'+port;
const auth=()=>({'x-console-token':token,'content-type':'application/json'});
try{
  assert.equal((await fetch(base+'/api/accounts')).status,401);
  const wrongOrigin=await fetch(base+'/api/accounts',{headers:{...auth(),origin:'https://evil.test'}});assert.equal(wrongOrigin.status,403);
  await fetch(base+'/api/accounts/start',{method:'POST',headers:auth(),body:'{"id":"B"}'});assert.deepEqual(actions,[['start','B']]);
  const response=await fetch(base+'/api/accounts/events',{headers:auth()}),reader=response.body.getReader(),decoder=new TextDecoder();
  const first=decoder.decode((await reader.read()).value);assert.match(first,/event: accounts/);assert.equal(first.includes('12345678'),false);
  bus.emit('log',{message:'SENSITIVE_LOG_FIXTURE'});bus.emit('session.delta',{delta:{content:'SENSITIVE_CHAT_FIXTURE'}});bus.emit('accounts',{id:'B',status:'running',private:'NOT_A_DTO'});
  const update=decoder.decode((await reader.read()).value);assert.match(update,/event: accounts/);for(const secret of ['SENSITIVE_LOG_FIXTURE','SENSITIVE_CHAT_FIXTURE','NOT_A_DTO'])assert.equal(update.includes(secret),false);
  token='new-metadata-token';for(const fn of [...changes])fn();
  assert.equal((await reader.read()).done,true);await reader.cancel();
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(bus.listenerCount('accounts'),0);assert.equal(bus.listenerCount('onebot.status'),0);assert.equal(bus.listenerCount('status'),0);
  console.log('Account metadata stream: authenticated controls, no conversation/log payload, token revocation and subscription cleanup passed.');
}finally{await server.close();}
