import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {DATA_DIR} from './config.js';import {safeFetchBinary} from './safe-fetch.js';import {wechatMediaRoot,trustedWechatMedia} from './wechat-db-receiver.js';
export async function stageWechatImage(image){
  let bytes;if(/^base64:\/\//.test(image.dataUrl||''))bytes=Buffer.from(image.dataUrl.slice(9),'base64');
  else if(image.url){const result=await safeFetchBinary(image.url,8*1024*1024);bytes=result.buffer;}
  else if(/^data:image\/(png|jpeg);base64,/i.test(image.dataUrl||''))bytes=Buffer.from(image.dataUrl.split(',')[1],'base64');
  else throw Error('微信发图需公开图片URL或已生成PNG/JPEG数据，不读取任意本地路径');
  if(!bytes?.length||bytes.length>8*1024*1024)throw Error('图片为空或超过8MiB');
  const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':bytes[0]===255&&bytes[1]===216?'jpg':'';if(!ext)throw Error('微信原生发图暂只接PNG/JPEG');
  const dir=path.join(DATA_DIR,'desktop-wechat/outbox');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,randomUUID()+'.'+ext);fs.writeFileSync(file,bytes,{flag:'wx'});return file;
}
export function receivedWechatImage(entry){const image=trustedWechatMedia(entry?.media)[0];if(!image)throw Error('当前消息没有可读取的本机微信图片');
  const real=fs.realpathSync(image.localFile),root=fs.realpathSync(wechatMediaRoot),rel=path.relative(root,real);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('图片路径不在微信缓存内');
  return{content:[{type:'text',text:JSON.stringify({messageId:entry.mid,quality:image.quality,width:image.width,height:image.height})},{type:'image_url',image_url:{url:'data:'+image.mime+';base64,'+fs.readFileSync(real).toString('base64')}}]};
}
