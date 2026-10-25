import {normalizeAccountId} from '../panels/account-scope.js';

const PANEL_ID=/^[A-Za-z0-9_-]{1,64}$/;
const validPanel=id=>typeof id==='string'&&PANEL_ID.test(id);

// Carry only the page name between accounts. Conversation selections, filters
// and editor drafts belong to their original account and never enter this URL.
export function accountNavigationUrl(accountId,panelId){
  const account=normalizeAccountId(accountId);if(!account)throw Error('账号地址无效');
  const query=new URLSearchParams({account});
  if(validPanel(panelId))query.set('panel',panelId);
  return '/?'+query;
}

export function readPanelTarget(search,panels){
  const query=new URLSearchParams(search),ids=query.getAll('panel');
  if(ids.length!==1||!validPanel(ids[0])||!Array.isArray(panels)||!panels.some(panel=>panel.id===ids[0]))return null;
  return {id:ids[0]};
}

export function panelLocationUrl(locationLike,panelId){
  const query=new URLSearchParams(locationLike.search);
  if(validPanel(panelId))query.set('panel',panelId);
  const search=query.toString();
  return (locationLike.pathname||'/')+(search?'?'+search:'')+(locationLike.hash||'');
}
