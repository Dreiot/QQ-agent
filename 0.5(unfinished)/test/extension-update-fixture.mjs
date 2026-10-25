import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createKernel} from '../src/kernel/kernel.js';
import {createExtensionUpdateController} from '../src/console/extension-updates.js';
import {createStoredZip} from '../bundled/market/client.js';
export const source={type:'github',repo:'sample/qqa-extensions',asset:'online-one.zip'};
export function packageFiles({id='online-one',kind='skill',version='1.1.0',update={...source,asset:id+'.zip'},permissions=[],broken=false,code}={}){
  return {[kind==='plugin'?'plugin.json':'skill.json']:JSON.stringify({id,name:id,kind,version,apiVersion:1,entry:'index.js',enabledByDefault:false,update,permissions,configSchema:{greeting:{type:'string'},apiKey:{type:'string',secret:true}}}),
    'index.js':code??`import {value} from './helper.js';export default {setup(ctx){${broken?"throw Error('synthetic setup failure');":''}ctx.registerTool({id:'value',name:'Value',execute:async()=>value});}};`,
    'helper.js':`export const value=${JSON.stringify(version)};`};
}
export const pack=files=>createStoredZip(Object.entries(files).map(([name,data])=>({name,data:Buffer.from(data)})));
export async function extensionUpdateFixture({autoDelay=3600000,watch=false,ui=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qqa-extension-updates-')),dataDir=path.join(root,'data'),calls=[],offers=new Map(),events=[];
  for(const name of ['bundled','skills','plugins'])fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');if(ui)fs.cpSync(path.resolve('ui'),path.join(root,'ui'),{recursive:true});
  let releaseError=0,downloadError=0,downloadGate=null,controller;
  const upstream=async(url,init)=>{const headers=new Headers(init.headers);if(headers.has('authorization')||headers.has('x-console-token'))throw Error('Credential leaked');calls.push({url:String(url),method:init.method});
    if(String(url)==='https://api.github.com/repos/sample/qqa-extensions/releases/latest')return new Response(JSON.stringify({tag_name:[...offers.values()][0]?.version||'v1.1.0',body:'合成更新说明 <script>不得执行</script>',draft:false,prerelease:false,assets:[...offers].map(([id,o])=>({name:id+'.zip',state:'uploaded',size:o.bytes.length,digest:o.digest??'sha256:'+crypto.createHash('sha256').update(o.bytes).digest('hex'),browser_download_url:`https://github.com/sample/qqa-extensions/releases/download/${o.version}/${id}.zip`}))}),{status:releaseError||200});
    const id=path.basename(new URL(url).pathname,'.zip'),offer=offers.get(id);if(!offer)throw Error('Unexpected peer '+url);if(downloadGate)await downloadGate;
    return new Response(offer.bytes,{status:downloadError||200});};
  const kernel=createKernel({appRoot:root,env:{QQ_AGENT_DATA_DIR:dataDir,QQ_AGENT_PORT:'0',QQ_AGENT_MIGRATE_FROM:path.join(root,'absent')},headless:true,
    transport:{id:'inert-updates',start(){},stop(){},status:()=>({connected:false}),actions:{}},priceUpdates:{refresh:async()=>({ok:true})},communityMarket:{syncGlobalBlocklist:async()=>({ok:true,ids:[]})},
    components:{'console.extensionUpdates':args=>controller=createExtensionUpdateController({...args,fetchImpl:upstream,dnsLookup:async()=>[{address:'203.0.113.4',family:4}],autoDelay})}});
  kernel.log.setLevel('error');kernel.config.update({server:{port:0,token:'synthetic-extension-update-console'},skills:{watch},extensions:{hotReload:watch},telemetry:{enabled:false},proactive:{enabled:false}});
  kernel.bus.on('status',e=>{if(e.extensionUpdates)events.push(e);},{internal:true});
  const install=async(options={})=>{const id=options.id||'online-one',kind=options.kind||'skill',dir=path.join(root,kind==='skill'?'skills':'plugins',id);fs.mkdirSync(dir,{recursive:true});for(const [name,data]of Object.entries(packageFiles({version:'1.0.0',...options})))fs.writeFileSync(path.join(dir,name),data);
    kernel.config.update({skills:{[id]:{enabled:options.enabled!==false,settings:{greeting:'preserved',apiKey:'synthetic-own-secret'}}}});await kernel.loader.loadDir(kind==='skill'?'skills':'plugins',dir,{hot:true});return dir;};
  const port=await kernel.start(),base=`http://127.0.0.1:${port}`;
  async function api(route,body){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'x-console-token':'synthetic-extension-update-console',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
  return {root,dataDir,kernel,controller,api,base,calls,events,install,offers,
    offer(id='online-one',options={}){const bytes=options.bytes||pack(packageFiles({id,...options}));offers.set(id,{bytes,version:options.version||'v1.1.0',digest:options.digest});return bytes;},
    errors({release=0,download=0}={}){releaseError=release;downloadError=download;},holdDownload(promise){downloadGate=promise;},
    async close(){await kernel.stop();assertRoot();fs.rmSync(root,{recursive:true,force:true});}};
  function assertRoot(){if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('qqa-extension-updates-'))throw Error('Unsafe test cleanup');}
}
