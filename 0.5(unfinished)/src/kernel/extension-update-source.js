// Public distribution metadata only. Never carry credentials or execute code.
export function normalizeUpdateSource(value) {
  if(value==null)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('更新来源必须是对象');
  if(value.type==='github'){
    if(typeof value.repo!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value.repo))throw Error('GitHub 更新仓库应为 owner/repo');
    if(typeof value.asset!=='string'||!value.asset.endsWith('.zip')||value.asset.length>180||/[\\/\x00-\x1f]/.test(value.asset))throw Error('更新发行包应为固定 ZIP 文件名');
    return {type:'github',repo:value.repo,asset:value.asset};
  }
  throw Error('当前在线更新支持 GitHub Releases，请声明 type: github');
}
export function versionParts(value){
  if(typeof value!=='string'||value.length>128)return null;
  const m=/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if(!m||m.slice(1,4).some(n=>!Number.isSafeInteger(Number(n))))return null;
  const pre=m[4]?.split('.')||[];if(pre.some(n=>/^\d+$/.test(n)&&n.length>1&&n[0]==='0'))return null;
  return {core:m.slice(1,4).map(Number),pre};
}
export function compareVersions(a,b){
  const x=versionParts(a),y=versionParts(b);if(!x||!y)throw Error('版本应使用 x.y.z 格式，例如 1.2.0');
  for(let i=0;i<3;i++)if(x.core[i]!==y.core[i])return x.core[i]>y.core[i]?1:-1;
  if(!x.pre.length||!y.pre.length)return x.pre.length===y.pre.length?0:x.pre.length?-1:1;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++){
    const l=x.pre[i],r=y.pre[i];if(l===r)continue;if(l===undefined)return -1;if(r===undefined)return 1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r);
    if(ln&&rn)return BigInt(l)>BigInt(r)?1:-1;if(ln!==rn)return ln?-1:1;return l>r?1:-1;
  }return 0;
}
