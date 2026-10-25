import assert from 'node:assert/strict';
import http from 'node:http';
import {createHttpServer} from '../src/kernel/http.js';
import {createAccountGateway} from '../src/accounts/gateway.js';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
const listeners=new Map(),bus={on(name,fn){listeners.set(name,fn);return()=>listeners.delete(name);}};
let parentToken='fixture-parent',change;const config={get:()=>({server:{port:0,token:parentToken}}),onChange:fn=>{change=fn;return()=>{};}};
const records=new Map(),hits=[];const servers=[];
for(const [index,id] of ids.entries()){
  const token='fixture-child-'+index;let model='model-'+index;
  const server=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/api/')&&req.headers['x-console-token']!==token){res.writeHead(401);res.end('{}');return;}
    hits.push({id,url:req.url,origin:req.headers.origin});
    if(req.url==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: hello\ndata: '+JSON.stringify({account:id})+'\n\n');return;}
    if(req.url==='/api/export'){res.writeHead(206,{'content-type':'application/octet-stream','content-range':'bytes 0-2/3'});res.end(Buffer.from([0,1,255]));return;}
    if(req.url.startsWith('/panels/')){res.writeHead(200,{'content-type':'text/javascript','access-control-allow-origin':req.headers.origin==='null'?'null':''});res.end('export default '+JSON.stringify(id));return;}
    if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;model=JSON.parse(body).model;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id,model}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);records.set(id,{port:server.address().port,token,generation:'generation-'+index});
}
const accounts={backend:id=>records.get(id)};
const gateway=createAccountGateway({accounts,bus,config,getPrimaryBackend:()=>null});
const root=createHttpServer({config,log:{error(){}},accountGateway:args=>gateway.handle(args)});const port=await root.listen(),base='http://127.0.0.1:'+port;
const request=(id,path,options={})=>fetch(base+'/accounts/'+id+path,{...options,headers:{'x-console-token':parentToken,...options.headers}});
try{
  for(const [i,id] of ids.entries()){const value=await(await request(id,'/api/config')).json();assert.equal(value.id,id);assert.equal(value.model,'model-'+i);assert.equal(JSON.stringify(value).includes('fixture-'),false);}
  await request(ids[0],'/api/config',{method:'POST',body:JSON.stringify({model:'only-A'})});
  assert.equal((await(await request(ids[0],'/api/config')).json()).model,'only-A');assert.equal((await(await request(ids[1],'/api/config')).json()).model,'model-1');
  assert.equal((await fetch(base+'/accounts/'+ids[0]+'/api/config',{headers:{'x-console-token':'wrong'}})).status,401);
  assert.equal((await request(ids[0],'/api/config',{headers:{origin:'https://evil.test'}})).status,403);
  assert.equal((await request('unknown','/api/config')).status,404);
  assert.equal((await request(ids[0],'/api/console/bootstrap',{method:'POST'})).status,403);
  const binary=await request(ids[1],'/api/export');assert.equal(binary.status,206);assert.equal(binary.headers.get('content-range'),'bytes 0-2/3');assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())],[0,1,255]);
  const asset=await request(ids[0],'/panels/u/example/generation/main.js',{headers:{origin:'null'}});assert.equal(asset.headers.get('access-control-allow-origin'),'null');assert.match(await asset.text(),new RegExp(ids[0]));
  const before=hits.length;const oversize=await request(ids[0],'/api/config',{method:'POST',body:'x'.repeat(2*1024**2+1)});assert.equal(oversize.status,413);assert.equal(hits.length,before);
  const abortA=new AbortController(),abortB=new AbortController();const [streamA,streamB]=await Promise.all([request(ids[0],'/api/events',{signal:abortA.signal}),request(ids[1],'/api/events',{signal:abortB.signal})]);
  const readA=streamA.body.getReader(),readB=streamB.body.getReader();assert.match(new TextDecoder().decode((await readA.read()).value),new RegExp(ids[0]));assert.match(new TextDecoder().decode((await readB.read()).value),new RegExp(ids[1]));
  abortA.abort();await readA.cancel().catch(()=>{});abortB.abort();await readB.cancel().catch(()=>{});
  assert.equal(hits.filter(hit=>hit.url.startsWith('/api/')).some(hit=>hit.origin),false);
  parentToken='rotated-parent';change();listeners.get('accounts')?.({id:ids[0]});
  records.delete(ids[1]);assert.equal((await request(ids[1],'/api/config')).status,409);
  console.log('Account gateway: fixed account routing, token/origin guards, isolated writes/SSE/assets, raw binary and body limits passed.');
}finally{gateway.close();await root.close();await Promise.all(servers.map(server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})))}
