export const MAX_BACKGROUND_SOURCE_BYTES=256*1024*1024;
const CHUNK_BYTES=512*1024;
function readDataUrl(blob){return new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));
  reader.onerror=()=>reject(new Error('无法读取背景文件，请重新选择'));reader.readAsDataURL(blob);
});}
async function checkVideo(file){
  const video=document.createElement('video'),url=URL.createObjectURL(file);video.muted=true;video.preload='auto';
  try{await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('无法读取视频，请使用可播放的 MP4 或 WebM')),15000);
    const finish=error=>{clearTimeout(timer);video.onloadeddata=video.onerror=null;error?reject(error):resolve();};
    video.onloadeddata=()=>finish();video.onerror=()=>finish(new Error('当前浏览器无法播放这个视频，请使用 H.264 MP4 或 WebM'));
    video.src=url;
  });}finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
}
export async function uploadBackgroundFile(file,{request,isCurrent=()=>true,onProgress=()=>{}}={}){
  const live=()=>{if(!isCurrent())throw new DOMException('背景选择已取消','AbortError');};
  if(!file.size)throw new Error('背景文件为空，请重新选择');
  if(file.size>MAX_BACKGROUND_SOURCE_BYTES)throw new Error('背景文件不能超过 256MB');
  const video=/^video\//i.test(file.type)||/\.(mp4|webm)$/i.test(file.name);
  live();if(video){onProgress('正在检查视频…');await checkVideo(file);live();}
  if(!video&&file.size<=8*1024*1024){const data=await readDataUrl(file);live();return request('POST','/api/uikit/background',{data});}
  let id;
  try{
    const upload=await request('POST','/api/uikit/background/uploads',{size:file.size});id=upload.id;live();
    for(let offset=0;offset<file.size;offset+=CHUNK_BYTES){
      live();const dataUrl=await readDataUrl(file.slice(offset,offset+CHUNK_BYTES));live();
      await request('POST',`/api/uikit/background/uploads/${id}/chunk`,{offset,data:dataUrl.slice(dataUrl.indexOf(',')+1)});live();
      onProgress(`正在导入${video?'视频':'图片'} · ${Math.round(Math.min(file.size,offset+CHUNK_BYTES)/file.size*100)}%`);
    }
    live();return await request('POST',`/api/uikit/background/uploads/${id}/complete`);
  }catch(error){if(id)try{await request('DELETE',`/api/uikit/background/uploads/${id}`);}catch{/* expiry also removes interrupted uploads */}throw error;}
}
