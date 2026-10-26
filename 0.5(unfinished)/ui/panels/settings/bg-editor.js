import {accountResourceUrl} from '../account-scope.js';
import {isVideoBackground,loopingBackgroundVideo} from '../background-media.js';
// The media plane and selection share the host viewport's live aspect ratio.
// Only normalized crop parameters are saved; resizing the window never writes
// configuration, reuploads media or restarts a running video.

import { normalizeBackgroundCrop, backgroundPaint, safeBgUrl } from '../theme.js';
import { bindDestructiveAction } from '../destructive-action.js';

const MIN_SCALE = 0.2;  // 选框最小占舞台比例，再小就没法看了
const MAX_SCALE = 1;

/**
 * 把背景图地址归一到静态别名路径。
 * 历史配置里存的是 /api/uikit/background/xxx，而 <img> 带不了 x-console-token，
 * 直接用会 401 裂图；新上传的已经是 /ui/backgrounds/xxx。
 */
function normalizeSrc(url) {
  const v = String(url ?? '').trim();
  if (!v) return '';
  return accountResourceUrl(v);
}

/**
 * 创建背景图编辑器。
 * @param {object} options
 * @param {() => string} options.getImage   读当前背景图地址
 * @param {() => object} options.getValues 读当前 { bgRotate, bgZoom, bgOffsetX, bgOffsetY, bgFit }
 * @param {() => {width:number,height:number}} options.getViewport 当前宿主窗口尺寸
 * @param {(patch: object) => void} options.onChange 值变化回调（写 form +推送主题）
 * @param {() => void} options.onUpload    触发文件选择
 * @param {() => void} options.onClear     清除背景图
 * @returns {{ element: HTMLElement, refresh: () => void }}
 */
export function createBackgroundEditor({ getImage, getValues, onChange, onUpload, onClear,getViewport=()=>({width:window.innerWidth,height:window.innerHeight}) }) {
  const element = document.createElement('div');
  element.className = 'bg-editor';

  // ---- 预览台 ----
  const stage = document.createElement('div');
  stage.className = 'bg-stage';

  const img = document.createElement('img');
  img.className = 'bg-stage-img';
  img.alt = '';
  img.draggable = false;
  const video=document.createElement('video');video.className='bg-stage-video';video.hidden=true;
  const playback=loopingBackgroundVideo(video,{onError:message=>setUploadStatus(message,true)});

  // A tiled background needs its own paint layer; keep the img for decoding
  // and for cover/contain so animated formats retain native browser behavior.
  const repeated = document.createElement('div');
  repeated.className = 'bg-stage-repeat';
  repeated.setAttribute('aria-hidden', 'true');

  const mask = document.createElement('div');
  mask.className = 'bg-stage-mask';

  // Selection geometry is normalized within the viewport-shaped media plane.
  const crop = document.createElement('div');
  crop.className = 'bg-crop';
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('span');
    handle.className = 'bg-crop-handle';
    handle.dataset.corner = corner;
    crop.append(handle);
  }
  const cropSize = document.createElement('span');
  cropSize.className = 'bg-crop-size';
  crop.append(cropSize);

  // 旋转旋钮（放在舞台右上角，跟随选框角度）
  const dial = document.createElement('div');
  dial.className = 'bg-rotate-dial';
  dial.title = '拖动旋转背景图';
  const needle = document.createElement('span');
  needle.className = 'needle';
  dial.append(needle);

  const emptyHint = document.createElement('div');
  emptyHint.className = 'bg-crop-size';
  emptyHint.style.cssText = 'position:static;display:block;text-align:center';
  emptyHint.textContent = '尚未选择背景';

  stage.append(img,video, repeated, mask, crop, dial, emptyHint);

  // ---- 参数栏 ----
  const panel = document.createElement('div');
  panel.className = 'bg-editor-panel';

  const makeRow = (label, valueNode) => {
    const row = document.createElement('label');
    row.className = 'bg-editor-row';
    const title = document.createElement('span');
    title.className = 'field-title';
    const name = document.createElement('span');
    name.textContent = label;
    title.append(name, valueNode);
    row.append(title);
    return { row, valueNode };
  };

  const rotateValue = document.createElement('em');
  const rotateRow = makeRow('旋转', rotateValue);
  const rotateInput = document.createElement('input');
  rotateInput.type = 'range';
  rotateInput.min = '0'; rotateInput.max = '359'; rotateInput.step = '1';
  rotateInput.id = 'bg-rotate';
  rotateRow.row.append(rotateInput);

  const zoomValue = document.createElement('em');
  const zoomRow = makeRow('范围大小', zoomValue);
  const zoomInput = document.createElement('input');
  zoomInput.type = 'range';
  zoomInput.min = String(MIN_SCALE * 100); zoomInput.max = '100'; zoomInput.step = '1';
  zoomInput.id = 'bg-zoom';
  zoomRow.row.append(zoomInput);

  const offsetXValue = document.createElement('em');
  const offsetXRow = makeRow('水平位置', offsetXValue);
  const offsetXInput = document.createElement('input');
  offsetXInput.type = 'range';
  offsetXInput.min = '-50'; offsetXInput.max = '50'; offsetXInput.step = '1';
  offsetXInput.id = 'bg-offset-x';
  offsetXRow.row.append(offsetXInput);

  const offsetYValue = document.createElement('em');
  const offsetYRow = makeRow('垂直位置', offsetYValue);
  const offsetYInput = document.createElement('input');
  // ⚠️ type='range' 不能漏：漏了会渲染成默认文本框（显示 "0" 而不是滑条）。
  offsetYInput.type = 'range';
  offsetYInput.min = '-50'; offsetYInput.max = '50'; offsetYInput.step = '1';
  offsetYInput.id = 'bg-offset-y';
  offsetYRow.row.append(offsetYInput);

  // 快捷角度：90 的倍数 + 微调，覆盖绝大多数"摆正"需求
  const presets = document.createElement('div');
  presets.className = 'bg-angle-presets';
  const angles = [0, 90, 180, 270, 45, 135, 225, 315];
  const presetButtons = angles.map((deg) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = `${deg}°`;
    b.addEventListener('click', () => commit({ bgRotate: deg }));
    presets.append(b);
    return { deg, b };
  });

  const actions = document.createElement('div');
  actions.className = 'bg-editor-actions';
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'primary';
  uploadBtn.textContent = '选择图片或视频';
  uploadBtn.addEventListener('click', () => onUpload());
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = '清除';
  const clearAction = bindDestructiveAction(clearBtn, {
    action: () => onClear(), target: () => stage, clicks: 2, key: () => getImage(),
    canActivate: () => Boolean(getImage()),
    impact: '将清除当前方案的背景设置，界面会恢复为纯色背景。',
  });
  const uploadStatus=document.createElement('p');uploadStatus.className='bg-upload-status field-hint';
  uploadStatus.setAttribute('role','status');uploadStatus.setAttribute('aria-live','polite');uploadStatus.hidden=true;
  actions.append(uploadBtn, clearBtn,uploadStatus);

  const hint = document.createElement('p');
  hint.className = 'bg-editor-hint';
  hint.textContent = '取景比例跟随当前窗口。拖动选框移动取景，拖动四角缩放，右上角旋转；调整不会改变原文件。';

  panel.append(rotateRow.row, zoomRow.row, offsetXRow.row, offsetYRow.row, presets, actions, hint);
  element.append(stage, panel);

  // ---- 状态与渲染 ----
  // scale: 选框宽度占舞台宽度的比例（0.2~1）
  // offsetX/offsetY: 选框中心相对舞台中心的偏移（百分比，-50~50）
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let rotate = 0;
  let dragging = null;

  function commit(patch) {
    const next = normalizeBackgroundCrop({ ...getValues(), ...patch });
    onChange({ ...patch, bgZoom: next.scale, bgOffsetX: next.offsetX, bgOffsetY: next.offsetY,
      ...(Object.hasOwn(patch, 'bgRotate') ? { bgRotate: next.rotate } : {}) });
    syncFromValues();
    render();
  }

  function syncFromValues() {
    const crop = normalizeBackgroundCrop(getValues());
    rotate = crop.rotate; scale = crop.scale; offsetX = crop.offsetX; offsetY = crop.offsetY;
  }

  function render() {
    const viewport=getViewport(),ratio=viewport.width>0&&viewport.height>0?viewport.width/viewport.height:1;
    stage.style.setProperty('--bg-stage-ratio',String(ratio));
    const url = normalizeSrc(getImage());
    const has = Boolean(url);
    const isVideo=isVideoBackground(url);
    const paint = backgroundPaint(getValues().bgFit);
    const tiled = !isVideo&&paint.repeat === 'repeat';
    if (has&&!isVideo && img.getAttribute('src') !== url) img.src = url;
    if (!has||isVideo) img.removeAttribute('src');
    img.style.display = has&&!isVideo ? '' : 'none';
    video.hidden=!isVideo;
    if(isVideo&&video.getAttribute('src')!==url)video.src=url;
    if(!isVideo&&video.getAttribute('src')){video.pause();video.removeAttribute('src');video.load();}
    playback.sync();
    img.style.visibility = tiled ? 'hidden' : 'visible';
    repeated.style.display = has && tiled ? '' : 'none';
    const tileUrl = isVideo?'':safeBgUrl(url);
    repeated.style.backgroundImage = tileUrl ? `url(${JSON.stringify(tileUrl)})` : 'none';
    repeated.style.backgroundRepeat = paint.repeat;
    repeated.style.backgroundSize = paint.size;
    repeated.style.backgroundPosition = paint.position;
    mask.style.display = has ? '' : 'none';
    crop.style.display = has ? '' : 'none';
    dial.style.display = has ? '' : 'none';
    emptyHint.style.display = has ? 'none' : '';
    stage.classList.toggle('is-empty', !has);

    // The same fraction of both axes keeps preview, mask and host in sync.
    const wPct = scale * 100;
    crop.style.width = `${wPct}%`;
    crop.style.height = `${wPct}%`;
    crop.style.aspectRatio = String(ratio);
    const stageBox = stage.getBoundingClientRect();
    const cropH = stage.clientHeight * scale;
    crop.style.left = `${50 + offsetX - wPct / 2}%`;
    crop.style.top = `${50 + offsetY - wPct / 2}%`;

    // The mask uses exactly the selection's normalized rectangle.
    mask.style.inset = 'auto';
    mask.style.left = crop.style.left;
    mask.style.top = crop.style.top;
    mask.style.width = `${wPct}%`;
    mask.style.height = `${wPct}%`;
    mask.style.aspectRatio = String(ratio);

    // 选框独立缩放/移动；源图保持原尺寸，只旋转。
    stage.style.setProperty('--bg-stage-rotate', `${rotate}deg`);
    stage.style.setProperty('--bg-stage-zoom', '1');
    stage.style.setProperty('--bg-stage-fit', getValues().bgFit === 'contain' ? 'contain' : 'cover');
    needle.style.setProperty('--bg-dial-angle', `${rotate}deg`);
    // 旋钮贴在选框右上角外侧，并夹在舞台内，别跑到框外看不见。
    // Keep the dial inside the preview even for narrow or tall windows.
    dial.style.left = `calc(${Math.min(50 + offsetX + wPct / 2, 82)}% + 6px)`;
    dial.style.top = `calc(${Math.max(4, 50 + offsetY)}% - ${Math.min(cropH / 2, Math.max(0, stageBox.height * (50 + offsetY) / 100 - 6))}px)`;

    cropSize.textContent = has ? `跟随窗口 · ${Math.round(wPct)}%` : '';
    cropSize.title=`当前窗口 ${Math.round(viewport.width)} × ${Math.round(viewport.height)}`;

    // 数值回显
    rotateValue.textContent = `${Math.round(rotate)}°`;
    zoomValue.textContent = `${Math.round(scale * 100)}%`;
    offsetXValue.textContent = `${Math.round(offsetX)}%`;
    offsetYValue.textContent = `${Math.round(offsetY)}%`;
    rotateInput.value = String(Math.round(rotate));
    zoomInput.value = String(Math.round(scale * 100));
    offsetXInput.value = String(Math.round(offsetX));
    offsetYInput.value = String(Math.round(offsetY));
    for (const { deg, b } of presetButtons) {
      b.classList.toggle('is-on', ((Math.round(rotate) % 360) + 360) % 360 === deg);
    }
  }

  // ---- 拖动交互 ----
  function stagePoint(event) {
    const rect = stage.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left - stage.clientLeft) / stage.clientWidth) * 100,
      y: ((event.clientY - rect.top - stage.clientTop) / stage.clientHeight) * 100,
    };
  }

  // 统一在 stage 上处理 move/up，不用 setPointerCapture。
  // 原因：面板跑在 sandbox=allow-scripts 的 opaque-origin iframe 里，
  // setPointerCapture 在跨文档场景不可靠——实测拖角时pointermove 不再送达，
  // 导致"拖角没反应"。改成"在 stage 上持续监听 + window 兜底收尾"更稳。
  const startDrag = (mode,event) => {
    const point=stagePoint(event);dragging = { mode,grabX:point.x-50-offsetX,grabY:point.y-50-offsetY };
    stage.classList.add('is-dragging');
    // 拖动期间禁用图片的原生拖拽，否则浏览器会拖走 <img>
    if (img.getAttribute('draggable') !== 'false') img.setAttribute('draggable', 'false');
  };

  crop.addEventListener('pointerdown', (event) => {
    if (event.target.dataset?.corner) return;   // 角把手单独处理
    startDrag('move',event);
    event.preventDefault();
  });

  for (const handle of crop.querySelectorAll('.bg-crop-handle')) {
    handle.addEventListener('pointerdown', (event) => {
      startDrag('resize',event);
      event.preventDefault();
      event.stopPropagation();     // 别冒泡到 crop 的 move 分支
    });
  }

  dial.addEventListener('pointerdown', (event) => {
    startDrag('rotate',event);
    event.preventDefault();
  });

  stage.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const p = stagePoint(event);
    if (dragging.mode === 'move') {
      // Preserve the grab point; normalizeBackgroundCrop keeps the frame inside.
      offsetX = Math.min(50, Math.max(-50, p.x - 50-dragging.grabX));
      offsetY = Math.min(50, Math.max(-50, p.y - 50-dragging.grabY));
      commit({ bgOffsetX: offsetX, bgOffsetY: offsetY });
      return;
    }
    if (dragging.mode === 'resize') {
      // Scale both axes around the selection center without changing its ratio.
      const centerXpct = 50 + offsetX;
      const centerYpct = 50 + offsetY;
      const wPct = Math.abs(p.x - centerXpct) * 2;
      const hPct = Math.abs(p.y - centerYpct) * 2;
      const byWidth = wPct / 100;
      const byHeight = hPct / 100;
      scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(byWidth, byHeight)));
      commit({ bgZoom: scale });
      return;
    }
    if (dragging.mode === 'rotate') {
      // 以舞台中心为原点算角度
      const deg = Math.atan2((p.x - 50)*stage.clientWidth, -(p.y - 50)*stage.clientHeight) * (180 / Math.PI);
      rotate = ((Math.round(deg) % 360) + 360) % 360;
      commit({ bgRotate: rotate });
    }
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  // 不用 pointerleave 收尾：拖动时指针可能短暂离开舞台（尤其拖角到边界），
  // 一 leave 就中断会导致垂直方向只动一点点（实测 top 纹丝不动）。
  // 改由 window 的 pointerup / pointercancel 统一收尾，覆盖"在舞台外松手"。
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---- 滑条精细微调 ----
  rotateInput.addEventListener('input', () => { commit({ bgRotate: Number(rotateInput.value) }); });
  zoomInput.addEventListener('input', () => { commit({ bgZoom: Number(zoomInput.value) / 100 }); });
  offsetXInput.addEventListener('input', () => { commit({ bgOffsetX: Number(offsetXInput.value) }); });
  offsetYInput.addEventListener('input', () => { commit({ bgOffsetY: Number(offsetYInput.value) }); });

  // ---- 对外 ----
  function refresh() {
    syncFromValues();
    render();
  }
  let resizeFrame=0;
  const onResize = () => { if(resizeFrame)return;resizeFrame=window.requestAnimationFrame(()=>{resizeFrame=0;if(element.isConnected)render();}); };
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(stage);
  window.addEventListener('resize', onResize);
  function dispose() {
    playback.dispose();
    clearAction.dispose();
    endDrag();
    resizeObserver?.disconnect();
    if(resizeFrame)window.cancelAnimationFrame(resizeFrame);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }
  refresh();
  function setUploadStatus(message,failed=false){uploadStatus.textContent=message;uploadStatus.hidden=!message;uploadStatus.classList.toggle('field-error',failed);}
  return { element, refresh, dispose,setUploadStatus,resize:onResize };
}
