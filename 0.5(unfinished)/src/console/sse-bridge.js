const EVENT_MAP = Object.freeze({ 'session.start':'session-start','session.update':'session-update','session.delta':'session-delta','session.end':'session-end','chat.update':'chat-update','memory.update':'memory-update','onebot.status':'onebot-status','local-protocols':'local-protocols','protocol-login':'protocol-login','accounts':'accounts','plugin.loaded':'plugin-loaded','plugin.unloaded':'plugin-unloaded','plugin.error':'plugin-error','server.ready':'status','status':'status','vision.scan':'vision-scan','permission.ask':'permission-ask','permission.decision':'permission-decision','feedback':'feedback','log':'log','price-update':'price-update','blocklist-sync':'blocklist-sync','management.update':'management-update' });
function safe(value) { try { return structuredClone(value ?? {}); } catch { return { value: String(value) }; } }
export class SseBridge {
  constructor({ bus, http }) { this.bus=bus; this.http=http; this.off=[]; }
  subscribe() { for (const [name,event] of Object.entries(EVENT_MAP)) this.off.push(this.bus.on(name, (payload)=>this.broadcast(event,payload), { internal:true })); return this; }
  broadcast(event,payload) { if(this.http.sseCount?.()===0)return;this.http.broadcast(event, safe(payload)); }
  snapshot() { return { subscribed: this.off.length, events: Object.values(EVENT_MAP) }; }
  close() { for (const off of this.off) off?.(); this.off=[]; }
}
export function createSseBridge(opts) { return new SseBridge(opts).subscribe(); }
