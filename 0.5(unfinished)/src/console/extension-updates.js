import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {safeFetch} from '../kernel/safe-fetch.js';
import {normalizeUpdateSource,compareVersions,versionParts} from '../kernel/extension-update-source.js';
import {normalizeManifest,pluginFingerprint,assertExtensionDirectory} from '../kernel/plugin-loader.js';
import {extractZipSafely,MARKET_MAX_ZIP_BYTES} from './community-market-adapters.js';
import {serializeSkill} from './serializers.js';

const PERIOD=6*60*60*1000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status,expose:true});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function createExtensionUpdateController({loader,config,managementRoot,safeDirectory,fetchImpl,dnsLookup,lifecycle,bus,publish=()=>{},now=Date.now,autoDelay=15000}={}){
  const records=new Map(),checking=new Map(),updating=new Map(),controller=new AbortController();let closed=false,timer=null;
  const rows=()=>loader?.listEntries?.()||[];
  const target=id=>{const row=rows().find(row=>row.id===id);if(!row)throw fail('扩展已不存在',404);if(!['plugins','skills'].includes(row.root))throw fail('仅用户安装的技能和插件支持独立在线更新',403);return row;};
  const active=()=>{if(closed||lifecycle?.signal.aborted)throw fail('应用已停止，更新已取消',409);};
  const assertMutable=id=>{if(updating.has(id))throw fail('此扩展正在更新，请完成后再操作',409);};
  const sourceFor=row=>normalizeUpdateSource(row.update);
  function state(row){const source=sourceFor(row),cached=records.get(row.id);if(cached&&(updating.has(row.id)||same(cached.source,source)&&cached.fingerprint===row.fingerprint))return cached;
    return {id:row.id,name:row.name,kind:row.kind,currentVersion:row.version,source,status:source?'unchecked':'manual',checkedAt:null};}
  const publicState=record=>{const {downloadUrl,digest,size,fingerprint,...view}=record;return structuredClone(view);};
  function snapshot(){const updates=rows().filter(row=>['plugins','skills'].includes(row.root)).map(row=>publicState(state(row)));return{updates,availableCount:updates.filter(r=>r.status==='available').length,checking:checking.size>0};}
  function announce(){if(!closed){const view=snapshot();publish('status',{extensionUpdates:true,available:view.updates.filter(row=>row.status==='available').map(({id,name,kind,latestVersion})=>({id,name,kind,version:latestVersion}))});}}
  async function readRelease(source,cache){
    const url=`https://api.github.com/repos/${source.repo}/releases/latest`;
    if(!cache.has(url))cache.set(url,(async()=>{const response=await safeFetch(url,{maxBytes:512*1024,timeoutMs:20000,fetchImpl,dnsLookup,signal:controller.signal,headers:{accept:'application/vnd.github+json'}});
      if(response.status!==200)throw fail(response.status===404?'仓库尚无公开的正式发行版':response.status===403||response.status===429?'GitHub 检查暂时受限，请稍后重试':`读取发行版失败（HTTP ${response.status}）`,502);
      if(response.truncated)throw fail('发行信息过大',502);try{return JSON.parse(response.body);}catch{throw fail('发行信息不是有效 JSON',502);}})());
    const release=await cache.get(url);active();
    if(release.draft||release.prerelease||!versionParts(release.tag_name)||versionParts(release.tag_name).pre.length)throw fail('最新正式版的标签需使用 v1.2.0 这样的版本号',502);
    const assets=Array.isArray(release.assets)?release.assets.filter(asset=>asset.name===source.asset&&asset.state==='uploaded'):[];
    if(assets.length!==1)throw fail(`发行版中未找到完整包 ${source.asset}，请作者上传该 ZIP`,502);
    const asset=assets[0];let download;
    try{download=new URL(asset.browser_download_url);}catch{throw fail('发行包地址无效',502);}
    if(download.protocol!=='https:'||download.hostname!=='github.com'||download.username||download.password||download.search||download.hash||!download.pathname.toLowerCase().startsWith(`/${source.repo}/releases/download/`.toLowerCase()))throw fail('发行包地址与声明的 GitHub 仓库不符',502);
    if(!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MARKET_MAX_ZIP_BYTES)throw fail('发行包为空或超过 8MB 上限',502);
    if(asset.digest!=null&&!/^sha256:[a-f0-9]{64}$/i.test(asset.digest))throw fail('发行包 SHA-256 摘要无效',502);
    return {latestVersion:release.tag_name,notes:String(release.body||'').slice(0,8000),releaseUrl:`https://github.com/${source.repo}/releases/tag/${encodeURIComponent(release.tag_name)}`,downloadUrl:download.href,size:asset.size,digest:asset.digest?.slice(7).toLowerCase()||null};
  }
  function check(id,{force=false,cache=new Map()}={}){
    if(checking.has(id))return checking.get(id);if(updating.has(id))return Promise.resolve(publicState(state(target(id))));
    const work=(async()=>{active();const row=target(id),previous=state(row),source=sourceFor(row);if(!source)return publicState(previous);
      if(!force&&previous.checkedAt&&now()-previous.checkedAt<PERIOD)return publicState(previous);
      const base={id,name:row.name,kind:row.kind,currentVersion:row.version,source,fingerprint:row.fingerprint,checkedAt:now()};
      records.set(id,{...base,status:'checking'});announce();
      try{const release=await readRelease(source,cache),current=target(id);active();if(current.fingerprint!==row.fingerprint||!same(sourceFor(current),source))throw fail('本地扩展在检查期间发生变化，请重新检查',409);
        records.set(id,{...base,...release,status:compareVersions(release.latestVersion,row.version)>0?'available':'current',checkId:crypto.randomUUID(),checkedAt:now()});
      }catch(error){if(!closed)records.set(id,{...base,status:'error',error:error.message,checkedAt:now()});}
      announce();return publicState(records.get(id)||base);
    })();checking.set(id,work);work.finally(()=>checking.delete(id)).catch(()=>{});return work;
  }
  async function checkAll({force=false}={}){active();const ids=rows().filter(row=>['plugins','skills'].includes(row.root)&&row.update).map(row=>row.id),cache=new Map();let index=0;
    await Promise.all([0,1].map(async()=>{while(index<ids.length&&!closed)await check(ids[index++],{force,cache}).catch(()=>{});}));return snapshot();}
  function apply(id,{checkId,confirmed}={}){
    if(confirmed!==true)throw fail('请先确认下载并安装此版本');if(updating.has(id))throw fail('此扩展正在更新，请稍候',409);
    const work=performUpdate(id,checkId);updating.set(id,work);work.finally(()=>updating.delete(id)).catch(()=>{});return work;
  }
  async function performUpdate(id,checkId){
    active();const row=target(id),offer=records.get(id);
    if(!offer||offer.status!=='available'||offer.checkId!==checkId||offer.fingerprint!==row.fingerprint||!same(sourceFor(row),offer.source))throw fail('更新信息已过期，请重新检查并确认',409);
    if(typeof loader.withDirectoryUpdate!=='function')throw fail('当前加载器不支持安全替换，请手动更新',501);
    records.set(id,{...offer,status:'updating'});announce();let stage=null;
    try{
      const response=await safeFetch(offer.downloadUrl,{maxBytes:MARKET_MAX_ZIP_BYTES,timeoutMs:120000,expectBinary:true,fetchImpl,dnsLookup,signal:controller.signal});active();
      if(response.status!==200||response.truncated||response.bytes!==offer.size)throw fail('下载失败，或发行包大小发生变化，请重新检查',502);
      if(offer.digest&&crypto.createHash('sha256').update(response.body).digest('hex')!==offer.digest)throw fail('发行包校验失败，原版未替换',502);
      const staging=safeDirectory('staging');stage=extractZipSafely(response.body,staging);assertExtensionDirectory(stage);
      const manifests=['skill.json','plugin.json'].filter(name=>fs.existsSync(path.join(stage,name)));if(manifests.length!==1)throw fail('完整 ZIP 根目录必须包含一个扩展清单');
      let raw;try{raw=JSON.parse(fs.readFileSync(path.join(stage,manifests[0]),'utf8').replace(/^\uFEFF/,''));}catch{throw fail('更新包清单无效');}
      const inferred={...raw,kind:raw?.kind??(manifests[0]==='plugin.json'?'plugin':'skill')},normalized=normalizeManifest(inferred,id);
      if(!raw||raw.id!==id||normalized.manifest.kind!==row.kind||normalized.problems.some(p=>p.level==='error')||compareVersions(raw.version,offer.latestVersion)!==0||!same(normalizeUpdateSource(raw.update),offer.source))throw fail('更新包的身份、类型、版本或更新来源不符，原版未替换');
      const entry=path.resolve(stage,normalized.manifest.entry);if(!entry.startsWith(stage+path.sep)||!fs.existsSync(entry)||!fs.statSync(entry).isFile())throw fail('更新包入口无效');
      if(raw.kind===undefined)fs.writeFileSync(path.join(stage,manifests[0]),JSON.stringify(inferred,null,2)+'\n');pluginFingerprint(stage);
      let backup;
      await loader.withDirectoryUpdate(id,async({entry:old,reload})=>{
        active();const current=target(id),root=path.join(managementRoot,old.rootKind),destination=path.resolve(old.dir);
        if(path.dirname(destination)!==root||assertExtensionDirectory(destination)!==destination||pluginFingerprint(destination)!==offer.fingerprint||current.fingerprint!==offer.fingerprint)throw fail('扩展目录或内容已变化，请重新检查',409);
        const backups=safeDirectory('backups');backup=path.join(backups,`${id}-${now()}-${crypto.randomUUID()}`);
        const saved=config.get().skills?.[id],hadSetting=Object.hasOwn(config.get().skills||{},id);let moved=false,swapped=false;
        try{
          fs.renameSync(destination,backup);moved=true;fs.renameSync(stage,destination);stage=null;swapped=true;
          config.update({skills:{[id]:{enabled:current.enabled}}});await reload();active();
          const loaded=target(id);if(loaded.loadError||(loaded.enabled&&loaded.status!=='active'))throw fail(loaded.loadError||'新版未能成功加载',502);
        }catch(error){
          try{
            if(swapped)fs.renameSync(destination,path.join(backups,`${id}-rejected-${crypto.randomUUID()}`));
            if(moved)fs.renameSync(backup,destination);
            const settings=structuredClone(config.get().skills||{});if(hadSetting)settings[id]=saved;else delete settings[id];config.update({skills:{__replace__:settings}});
            if(!closed&&!lifecycle?.signal.aborted)await reload();
          }catch(rollback){throw fail(`更新失败，恢复未完成：${rollback.message}。原版保留在 ${backup}`,500);}
          throw fail(`更新失败，已恢复原版：${error.message}`,502);
        }
      });
      const updated=target(id);records.set(id,{...offer,currentVersion:updated.version,fingerprint:updated.fingerprint,status:'current',checkedAt:now(),checkId:null});announce();
      return{ok:true,id,version:updated.version,loaded:updated.status==='active',enabled:updated.enabled,needsReauthorize:updated.enabled&&Boolean(updated.permissions?.length),skill:serializeSkill(updated),backup:path.relative(managementRoot,backup)};
    }catch(error){if(!closed){records.set(id,{...offer,status:'error',error:error.message,checkedAt:now()});announce();}throw error;}
    finally{if(stage){const parent=path.resolve(safeDirectory('staging'));if(path.dirname(path.resolve(stage))!==parent)throw Error('拒绝清理越界的更新暂存目录');assertExtensionDirectory(stage);fs.rmSync(stage,{recursive:true,force:true});}}
  }
  function schedule(delay=PERIOD){if(closed||!lifecycle)return;clearTimeout(timer);timer=setTimeout(()=>{timer=null;void checkAll().catch(()=>{}).finally(()=>schedule());},delay);timer.unref?.();}
  const off=bus?.on?.('plugin.loaded',()=>schedule(3000),{internal:true});
  async function close(){closed=true;clearTimeout(timer);controller.abort(Error('应用已停止'));off?.();await Promise.allSettled([...updating.values(),...checking.values()]);}
  lifecycle?.onStop(close);schedule(autoDelay);
  return {snapshot,check,checkAll,apply,assertMutable,close};
}
