export const isVideoBackground=url=>/\.(?:mp4|webm)(?:[?#]|$)/i.test(String(url||''));

// Keep one native decoder and preserve its position through theme/crop edits.
export function loopingBackgroundVideo(video,{onError=()=>{}}={}){
  const doc=video.ownerDocument,win=doc.defaultView;let inView=true,closed=false,playing=false;
  video.muted=true;video.defaultMuted=true;video.loop=true;video.autoplay=true;video.playsInline=true;video.preload='metadata';
  video.setAttribute('muted','');video.setAttribute('playsinline','');video.setAttribute('aria-hidden','true');video.tabIndex=-1;
  function sync(){
    if(closed)return;
    const visible=!doc.hidden&&inView&&!video.hidden&&Boolean(video.getAttribute('src'));
    if(!visible){video.pause();return;}
    if(!video.paused||playing)return;
    playing=true;Promise.resolve(video.play()).catch(error=>{if(error.name!=='AbortError'&&error.name!=='NotAllowedError')onError('视频暂时无法播放，请重新选择');}).finally(()=>{playing=false;});
  }
  const error=()=>{if(video.getAttribute('src'))onError('当前浏览器无法播放该视频，请使用 H.264 MP4 或 WebM');};
  const observer=win.IntersectionObserver?new win.IntersectionObserver(entries=>{inView=entries.some(entry=>entry.isIntersecting);sync();}):null;
  observer?.observe(video);doc.addEventListener('visibilitychange',sync);video.addEventListener('loadeddata',sync);video.addEventListener('error',error);
  return{sync,dispose(){closed=true;observer?.disconnect();doc.removeEventListener('visibilitychange',sync);video.removeEventListener('loadeddata',sync);video.removeEventListener('error',error);video.pause();video.removeAttribute('src');video.load();}};
}
const hosts=new WeakMap();
export function syncBackgroundVideo(doc,url){
  if(!doc.querySelector?.('#panel-host'))return;
  let host=hosts.get(doc);
  if(!url){if(host){host.playback.dispose();host.video.remove();hosts.delete(doc);}return;}
  if(!host){
    const video=doc.createElement('video');video.id='background-video';video.className='background-video';video.dataset.visualOwned='true';
    doc.body.prepend(video);host={video,playback:loopingBackgroundVideo(video)};hosts.set(doc,host);
  }
  if(host.video.getAttribute('src')!==url)host.video.src=url;
  host.playback.sync();
}
