import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BACKGROUND_BYTES=256*1024*1024;
export const BACKGROUND_CHUNK_BYTES=512*1024;
const TTL=30*60*1000;
function fail(message,status=400){throw Object.assign(new Error(message),{status,expose:true});}
export function backgroundFileType(bytes){
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{ext:'png',mime:'image/png'};
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return{ext:'jpg',mime:'image/jpeg'};
  if(/^GIF8[79]a/.test(bytes.toString('ascii',0,6)))return{ext:'gif',mime:'image/gif'};
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return{ext:'webp',mime:'image/webp'};
  if(bytes.length>=16&&bytes.toString('ascii',4,8)==='ftyp'){
    const length=bytes.readUInt32BE(0),brands=bytes.toString('ascii',8,Math.min(length,bytes.length));
    if(length>=16&&length<=bytes.length&&/(?:isom|iso[2-9]|mp4[12]|avc1|M4V |dash|MSNV)/.test(brands))return{ext:'mp4',mime:'video/mp4'};
  }
  if(bytes.length>=7&&bytes.readUInt32BE(0)===0x1a45dfa3&&bytes.includes(Buffer.from([0x42,0x82,0x84,0x77,0x65,0x62,0x6d])))return{ext:'webm',mime:'video/webm'};
  return null;
}
export function registerBackgroundUploads(http,{dataDir,publicPrefix='',lifecycle}={}){
  const pending=new Map(),root=dataDir?path.join(dataDir,'ui','background-uploads'):null,target=dataDir?path.join(dataDir,'ui','backgrounds'):null;let initialized=false;
  const discard=id=>{const upload=pending.get(id);if(upload){pending.delete(id);try{fs.unlinkSync(upload.file);}catch(error){if(error.code!=='ENOENT')throw error;}}};
  function cleanup(){for(const[id,item]of pending)if(Date.now()-item.touched>TTL)discard(id);}
  function get(id){cleanup();const item=pending.get(id);if(!item)fail('背景导入已过期，请重新选择文件',404);item.touched=Date.now();return item;}
  // Pending data is outside the public media directory. Reclaim only stale
  // files created by this importer, including after an interrupted app exit.
  function initialize(){
    if(!root)fail('背景文件目录不可用',503);if(initialized)return;
    fs.mkdirSync(root,{recursive:true});
    for(const name of fs.readdirSync(root))if(/^upload-[a-f0-9]{32}\.part$/.test(name)){
      const file=path.join(root,name);if(Date.now()-fs.statSync(file).mtimeMs>TTL)fs.unlinkSync(file);
    }
    initialized=true;
  }
  lifecycle?.onStop?.(()=>{for(const id of [...pending.keys()])discard(id);});
  http.route('POST','/api/uikit/background/uploads',({body})=>{
    cleanup();const size=body?.size;
    if(!Number.isSafeInteger(size)||size<1||size>MAX_BACKGROUND_BYTES)fail('背景文件需在 1 字节至 256MB 之间');
    if(pending.size>=3)fail('有背景文件正在导入，请稍后再试',409);
    initialize();
    const id=crypto.randomBytes(16).toString('hex'),file=path.join(root,`upload-${id}.part`);
    fs.writeFileSync(file,Buffer.alloc(0),{flag:'wx'});pending.set(id,{file,size,received:0,touched:Date.now()});return{id,chunkBytes:BACKGROUND_CHUNK_BYTES};
  });
  http.route('POST',/^\/api\/uikit\/background\/uploads\/(?<id>[a-f0-9]{32})\/chunk$/,({params,body})=>{
    const item=get(params.id);
    if(body?.offset!==item.received)fail('文件传输位置不一致，请重新选择',409);
    if(typeof body.data!=='string'||body.data.length>Math.ceil(BACKGROUND_CHUNK_BYTES/3)*4||!body.data.length||body.data.length%4||/[^A-Za-z0-9+/=]/.test(body.data))fail('文件片段无效');
    const bytes=Buffer.from(body.data,'base64');
    if(bytes.toString('base64')!==body.data)fail('文件片段无效');
    if(!bytes.length||bytes.length>BACKGROUND_CHUNK_BYTES||item.received+bytes.length>item.size)fail('文件片段大小无效');
    fs.appendFileSync(item.file,bytes);item.received+=bytes.length;return{received:item.received};
  });
  http.route('POST',/^\/api\/uikit\/background\/uploads\/(?<id>[a-f0-9]{32})\/complete$/,({params})=>{
    const item=get(params.id);if(item.received!==item.size)fail('文件尚未传输完成',409);
    const descriptor=fs.openSync(item.file,'r'),header=Buffer.alloc(Math.min(item.size,65536));
    try{fs.readSync(descriptor,header,0,header.length,0);}finally{fs.closeSync(descriptor);}
    const type=header.length>=12?backgroundFileType(header):null;
    if(!type){discard(params.id);fail('请选择 PNG、JPG、GIF、WebP 图片或 MP4、WebM 视频');}
    fs.mkdirSync(target,{recursive:true});const name=`bg-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
    fs.renameSync(item.file,path.join(target,name));pending.delete(params.id);
    const prefix=/^\/accounts\/[a-f0-9-]{36}$/i.test(publicPrefix)?publicPrefix:'';
    return{ok:true,url:`${prefix}/ui/backgrounds/${name}`,bytes:item.size,mime:type.mime};
  });
  http.route('DELETE',/^\/api\/uikit\/background\/uploads\/(?<id>[a-f0-9]{32})$/,({params})=>{discard(params.id);return{ok:true};});
}
