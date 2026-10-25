// SPEC §6.10 / §16 R-24: OneBot group/private sends may take 90s.
// Only this exact console action receives overhead for provider dispatch and the
// archive/HTTP acknowledgment. The host computes its budget from the allowlisted
// route; an iframe cannot supply or increase it. Market installs also need a
// bounded window for verification, the 120s package download and safe unpacking.
const TEST_SEND=/^\/api\/chats\/(group|private)_\d+\/test-send$/;
const DEFAULT_TIMEOUT_MS=15000;
const SEND_HOST_TIMEOUT_MS=100000;
const SEND_PANEL_TIMEOUT_MS=105000; // Let the host return its error before the panel waiter expires.

function isSlowSend(method,path){return String(method).toUpperCase()==='POST'&&typeof path==='string'&&TEST_SEND.test(path);}
const isMarketInstall=(method,path)=>String(method).toUpperCase()==='POST'&&path==='/api/market/install';
const isExtensionUpdate=(method,path)=>String(method).toUpperCase()==='POST'&&/^\/api\/extensions\/[^/]+\/update$/.test(path);
const isLocalProtocolStart=(method,path)=>String(method).toUpperCase()==='POST'&&path==='/api/local-protocols/start';
const loginBudget=(method,path)=>String(method).toUpperCase()!=='POST'?0:['/api/local-protocols/login/inject','/api/accounts/start'].includes(path)?90000:['/api/accounts/stop','/api/accounts/remove'].includes(path)?30000:['/api/local-protocols/login/connect','/api/local-protocols/login/refresh'].includes(path)?35000:0;
export function hostApiRequestTimeout(method,path,fallback=DEFAULT_TIMEOUT_MS){return isSlowSend(method,path)?SEND_HOST_TIMEOUT_MS:isMarketInstall(method,path)||isLocalProtocolStart(method,path)||isExtensionUpdate(method,path)?180000:path==='/api/extensions/updates/check'?60000:loginBudget(method,path)||fallback;}
export function panelApiRequestTimeout(method,path){const login=loginBudget(method,path);return isSlowSend(method,path)?SEND_PANEL_TIMEOUT_MS:isMarketInstall(method,path)||isLocalProtocolStart(method,path)||isExtensionUpdate(method,path)?185000:path==='/api/extensions/updates/check'?65000:login?login+5000:DEFAULT_TIMEOUT_MS;}
