// Move existing controls so visual grouping follows the setting's purpose.
export function organizeSecurity(entry,field,doc=entry.card.ownerDocument){
  function group(key,title,items){
    const box=doc.createElement('section'),heading=doc.createElement('h4'),body=doc.createElement('div');
    box.className='settings-preference-group full';box.dataset.preferenceGroup=key;heading.textContent=title;body.className='settings-fields';
    body.append(...items.filter(Boolean));box.append(heading,body);entry.fields.append(box);return body;
  }
  const risky=entry.card.querySelector('.zone-danger');
  const browser=group('browsing','网页访问',[field('security.browseLock.enabled'),field('security.browseLock.hosts')]);
  for(const item of browser.children)item.classList.add('full');
  // This legacy key has no default runtime consumer. Preserve its bound value
  // for existing configuration/layers without advertising an inactive feature.
  const reserved=field('security.browseLock.siteSearchUrl');reserved.hidden=true;reserved.dataset.settingsSearchExclude='true';entry.fields.append(reserved);
  group('images','网络图片',[field('security.imageSend.requirePreview'),field('security.imageSend.maxPerRun'),field('security.imageSend.maxPreviewsPerRun'),field('security.imageSend.maxBytesMB')]).classList.add('settings-image-limits');
  group('privacy','使用统计',[field('telemetry.enabled')]);
  if(risky){risky.querySelector('.field-group-head').textContent='网络例外';entry.fields.append(risky);}
  field('security.allowPrivateImageHosts').title='允许读取局域网与本机地址中的图片，仅用于可信环境。';
}
