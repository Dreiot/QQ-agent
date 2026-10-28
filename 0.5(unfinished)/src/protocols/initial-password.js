import fs from 'node:fs';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';

// Only the bootstrap line from the process QQA started is a credential source.
// The on-disk hash is used solely to detect rotation, never as a password.
export function snowInitialPassword(line){
  return /\[WebUI\]\s+initial credentials: user=admin password=([a-f0-9]{16})\s*$/i.exec(stripVTControlCharacters(line))?.[1]||'';
}

export function snowBootstrapIdentity(root){
  let descriptor;
  try{
    let current=root;
    for(const part of ['', 'config', 'webui.json']){
      if(part)current=path.join(current,part);
      const stat=fs.lstatSync(current);
      if(stat.isSymbolicLink()||(part==='webui.json'?!stat.isFile():!stat.isDirectory()))return '';
    }
    descriptor=fs.openSync(current,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    const before=fs.fstatSync(descriptor);
    if(!before.isFile()||before.size>65536)return '';
    const value=JSON.parse(fs.readFileSync(descriptor,'utf8')),after=fs.lstatSync(current);
    if(after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||value?.mustChangePassword!==true)return '';
    if(typeof value.passwordHash!=='string'||typeof value.passwordSalt!=='string')return '';
    return JSON.stringify([value.passwordHash,value.passwordSalt,value.generatedAt]);
  }catch{return '';}
  finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
}
