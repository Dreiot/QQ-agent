import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);

export async function installedFonts({platform=process.platform,execute=run}={}) {
  let names=[];
  if(platform==='win32') {
    const command="[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; Add-Type -AssemblyName System.Drawing; $fonts = New-Object System.Drawing.Text.InstalledFontCollection; try { ConvertTo-Json -Compress -InputObject @($fonts.Families | ForEach-Object { $_.Name }) } finally { $fonts.Dispose() }";
    const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'});
    names=JSON.parse(stdout.replace(/^\uFEFF/,''));
  } else {
    const {stdout}=await execute('fc-list',['--format=%{family}\n'],{timeout:15000,maxBuffer:2*1024*1024,encoding:'utf8'});
    names=stdout.split(/[\n,]/);
  }
  return [...new Set([].concat(names).filter(n=>typeof n==='string'&&n.trim()&&n.length<=160&&!/[\x00-\x1f\x7f]/.test(n)).map(n=>n.trim()))].sort((a,b)=>a.localeCompare(b,'zh-CN')).slice(0,5000);
}

export function registerLocalFontRoutes(http,{enumerate=installedFonts}={}) {
  let cached=null,pending=null,updated=0;
  const read=async(force=false)=>{
    if(!pending&&(!cached||Date.now()-updated>300000||force)) {
      pending=enumerate().then(families=>{cached={families,available:true};updated=Date.now();return cached;}).catch(()=>({families:[],available:false,error:'暂时无法读取字体，仍可输入字体名称。'})).finally(()=>{pending=null;});
    }
    return pending||cached;
  };
  http.route('GET','/api/ui/fonts',({query})=>read(query?.refresh==='1'));
  http.route('GET','/api/ui/fonts/refresh',()=>read(true));
}
