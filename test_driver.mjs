// CDP 驱动：无头 chromium 验证 CasioEmuWeb/index.html
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const PAGE = 'file:///home/user/Doubao/chats/38445468844642306/CasioEmuWeb/index.html';
const chrome = spawn('/usr/local/bin/chromium', [
  '--headless=new','--disable-gpu','--no-sandbox','--disable-dev-shm-usage',
  '--remote-debugging-port=9333','--user-data-dir=/tmp/cromo-prof',
  PAGE
], {stdio:'ignore'});

const sleep = ms => new Promise(r=>setTimeout(r,ms));
const results = [];
let curTest='boot';
function check(name, ok, extra=''){
  curTest=name;
  results.push({name, ok:!!ok, extra, test:curTest});
  console.log((ok?'PASS ':'FAIL ')+name+(extra?'  — '+extra:''));
}

async function main(){
  // 等调试端口
  let wsUrl=null;
  for(let i=0;i<60;i++){
    try{
      const r=await fetch('http://127.0.0.1:9333/json');
      const list=await r.json();
      const page=list.find(x=>x.type==='page');
      if(page){wsUrl=page.webSocketDebuggerUrl;break}
    }catch(e){}
    await sleep(500);
  }
  if(!wsUrl){check('chrome devtools',false,'无法连接 9333');process.exit(1)}
  const ws=new WebSocket(wsUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej});
  let msgId=0;const pend=new Map();const consoleErrs=[];
  ws.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id)}
    if(m.method==='Runtime.consoleAPICalled'){
      const t=m.params.type;
      if(t==='error'||t==='warning')consoleErrs.push('['+curTest+'] '+t+': '+m.params.args.map(a=>a.value||a.description||'').join(' '));
    }
    if(m.method==='Runtime.exceptionThrown'){
      const det=m.params.exceptionDetails||{};
      const frames=(det.stackTrace?.callFrames||[]).map(f=>(f.functionName||'?')+'@'+f.url.split('/').pop()+':'+f.lineNumber).slice(0,14);
      consoleErrs.push('['+curTest+'] EXC: '+JSON.stringify(det.exception?.description||det.text||'')+' || '+(frames.join(' <- ')));
    }
  };
  const send=(method,params={})=>new Promise(res=>{const id=++msgId;pend.set(id,res);ws.send(JSON.stringify({id,method,params}))});
  const evalJs=async(expr,awaitPromise=true)=>{
    const r=await send('Runtime.evaluate',{expression:expr,awaitPromise,returnByValue:true});
    if(r.result?.exceptionDetails){
      throw new Error('页面异常: '+JSON.stringify(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text));
    }
    return r.result?.result?.value;
  };
  await send('Runtime.enable');

  // 等待核心就绪
  let ready=false;
  for(let i=0;i<120;i++){
    try{ if(await evalJs('coreReady===true')){ready=true;break} }catch(e){}
    await sleep(500);
  }
  check('核心加载 (wasm 实例化)', ready);

  // 1) 导入 config.bin 模块包（CLASSWIZ）
  const cfgB64=readFileSync('/home/user/Doubao/chats/38445468844642306/CasioEmuWeb/testpkg/config.bin').toString('base64');
  const romB64=readFileSync('/home/user/Doubao/chats/38445468844642306/CasioEmuWeb/testpkg/rom.bin').toString('base64');
  const imp1=await evalJs(`(async()=>{
    const b64=(s)=>{const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
    await importModelPackage({'config.bin':new File([b64('${cfgB64}')],'config.bin'),'rom.bin':new File([b64('${romB64}')],'rom.bin')});
    return {ok:true,model:currentModel?currentModel.name:null,coreReady};
  })()`);
  check('导入 config.bin 并启动', imp1?.ok && imp1.model==='TestClasswiz', 'model='+imp1.model);

  // 2) 帧尺寸与帧内容
  const fr=await evalJs(`(()=>({w:core('casioemu_core_frame_width'),h:core('casioemu_core_frame_height'),ptr:core('casioemu_core_frame_ptr'),running:core('casioemu_core_is_running')}))()`);
  check('CLASSWIZ 帧尺寸 192x63（核心丢弃状态行）', fr.w===192&&fr.h===63, JSON.stringify(fr));
  check('帧指针有效', !!fr.ptr);
  check('核心运行中', fr.running===1, 'running='+fr.running);

  // 3) 按键事件
  const kb=await evalJs(`(()=>{core('casioemu_core_button_event',['number','number'],[0x11,1],'number');core('casioemu_core_button_event',['number','number'],[0x11,0],'number');return true})()`);
  check('按键事件', kb===true);

  // 4) CPU 时间推进
  await sleep(1200);
  const ct=await evalJs(`core('casioemu_core_cpu_time')`);
  check('CPU 时间推进', ct>1000, 'cpu_time='+ct);

  // 5) LCD canvas 有内容且已绘制
  const lcd=await evalJs(`(()=>{const c=document.getElementById('lcdCanvas');return {w:c.width,h:c.height,img:!!lcdImgData,model:currentModel.name}})()`);
  check('LCD canvas 尺寸', lcd.w>0&&lcd.h>0, JSON.stringify(lcd));

  // 6) GUI 调试器
  const g=await evalJs(`(async()=>{attachGui();await new Promise(r=>setTimeout(r,300));const rc=core('casioemu_core_gui_frame');return {attached:core('casioemu_core_gui_is_attached'),rc,len:core('casioemu_core_gui_frame_len'),w:core('casioemu_core_gui_width'),h:core('casioemu_core_gui_height')}})()`);
  check('GUI 附加成功', g.attached===1, JSON.stringify(g));
  check('GUI 帧可用', g.rc===0&&g.len>0, 'len='+g.len);

  // 7) 快照
  const sn=await evalJs(`(()=>{core('casioemu_core_save_snapshot');const len=core('casioemu_core_snapshot_len');const p=core('casioemu_core_snapshot_ptr');const bytes=len>0?Array.from(Module.HEAPU8.slice(p,p+Math.min(len,64))):[];const ok=core('casioemu_core_load_snapshot',['number','number'],[p,len],'number')===0;return {len,ok,head:bytes.slice(0,8)}})()`);
  check('快照保存/加载', sn.ok&&sn.len>0, 'len='+sn.len+' head='+sn.head.join(','));

  // 8) RAM 持久化
  const ram=await evalJs(`(()=>{const sz=core('casioemu_core_persistent_ram_size');
    const p=Module._malloc(Math.max(sz,1));
    const rc=core('casioemu_core_save_persistent_ram',['number','number'],[p,sz],'number');
    const bytes=rc===0?Array.from(Module.HEAPU8.slice(p,p+Math.min(sz,16))):[];
    const ok=core('casioemu_core_load_persistent_ram',['number','number'],[p,sz],'number')===0;
    Module._free(p);return {sz,rc,ok,head:bytes.slice(0,4)}})()`);
  check('RAM 保存/加载', ram.ok&&ram.sz>0, 'size='+ram.sz);

  // 9) 裸 ROM 导入（MakeWebModel 路径，模拟模式）
  const bare=await evalJs(`(async()=>{
    const b64=(s)=>{const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
    await importBare(new File([b64('${romB64}')],'rom.bin'));
    return {ok:true,model:currentModel?currentModel.name:null,sim:core('casioemu_core_is_running')};
  })()`);
  check('裸 ROM 导入（模拟模式）', bare?.ok && bare.model, 'model='+bare.model);

  // 10) EPS6800 导入（宽 96、16 行 KO）
  const cfg2B64=readFileSync('/home/user/Doubao/chats/38445468844642306/CasioEmuWeb/testpkg/eps6800/config.bin').toString('base64');
  const imp2=await evalJs(`(async()=>{
    const b64=(s)=>{const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
    await importModelPackage({'config.bin':new File([b64('${cfg2B64}')],'config.bin'),'rom.bin':new File([b64('${romB64}')],'rom.bin')});
    return {model:currentModel?currentModel.name:null,w:core('casioemu_core_frame_width'),h:core('casioemu_core_frame_height')};
  })()`);
  check('EPS6800 导入并帧宽 96', imp2?.model==='TestEPS6800'&&imp2.w===96&&imp2.h>0, JSON.stringify(imp2));

  // 11) 设置/语言
  const setv=await evalJs(`(()=>{core('casioemu_core_set_display_color',['number','number','number'],[0,0,0],'number');core('casioemu_core_set_screen_shadow',['number','double'],[1,1.0],'number');core('casioemu_core_set_battery_voltage',['double'],[1.5],'number');core('casioemu_core_set_solar_voltage',['double'],[1.5],'number');setLang('en');return T('run')})()`);
  check('设置接口 + 语言切换', setv==='▶ Run', 'T(run)='+setv);

  // 12) QR
  const qr=await evalJs(`(()=>{core('casioemu_core_qr_update');const a=core('casioemu_core_qr_active');const d=core('casioemu_core_qr_data',[],[] ,'string');return {a,d:!!d}})()`);
  check('QR 接口可调', qr.a===0||qr.a===1, JSON.stringify(qr));

  // 13) 模型库弹窗 + 导入方式切换
  const lib=await evalJs(`(()=>{
    $('btnImport').click();
    const open=$('libModal').classList.contains('open');
    const folderBtn=!!document.getElementById('btnPickFolder');
    const dz=!!document.getElementById('dropZone');
    const cards=document.querySelectorAll('.lib-card').length;
    document.querySelector('input[name=impMode][value=zip]').checked=true;
    renderImpArea();
    const zipBtn=!!document.getElementById('btnPickZip');
    document.querySelector('input[name=impMode][value=dir]').checked=true;
    renderImpArea();
    const dirBtn=!!document.getElementById('btnPickDir');
    document.querySelector('input[name=impMode][value=folder]').checked=true;
    renderImpArea();
    $('libClose').click();
    return {open,folderBtn,dz,zipBtn,dirBtn,cards,closed:!$('libModal').classList.contains('open')};
  })()`);
  check('模型库弹窗 + 四种导入方式', lib.open&&lib.folderBtn&&lib.dz&&lib.zipBtn&&lib.dirBtn&&lib.closed&&lib.cards>=1, JSON.stringify(lib));

  // 14) 逐个文件清单（例子模式：标签 + 预勾 rom）
  const fl=await evalJs(`(async()=>{
    setLang('zh');
    await new Promise(r=>setTimeout(r,30));
    const mk=(name,size)=>new File([new Uint8Array(size||4)],name);
    setPendingFiles([mk('_disas.txt',1200),mk('config.bin',374),mk('interface.png',3000),mk('ram.dmp',8192),mk('rom.bin',65536)]);
    $('btnImport').click();
    const rows=[...document.querySelectorAll('.file-row')];
    const tags={};rows.forEach(r=>{const n=r.querySelector('.fn').textContent;tags[n]=r.querySelector('.tag').textContent});
    const romChecked=rows.find(r=>r.querySelector('.fn').textContent==='rom.bin').querySelector('input').checked;
    const nRows=rows.length;
    $('libClose').click();
    return {nRows,tags,romChecked,selHasRom:selSet.has('rom.bin')};
  })()`);
  check('文件清单：标签与预勾选', fl.nRows===5&&fl.tags['rom.bin']==='必选'&&fl.tags['config.bin']==='推荐'&&fl.tags['_disas.txt']==='可选'&&fl.romChecked&&fl.selHasRom, JSON.stringify(fl));

  // 15) 按清单导入选中文件（config+rom+iface → 模块包）
  const ifcB64=readFileSync('/home/user/Doubao/chats/38445468844642306/CasioEmuWeb/testpkg/iface/config.bin').toString('base64');
  const ifcPngB64=readFileSync('/home/user/Doubao/chats/38445468844642306/CasioEmuWeb/testpkg/iface/face.png').toString('base64');
  const impSel=await evalJs(`(async()=>{
    const b64=(s)=>{const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
    pendingFiles=[
      {name:'config.bin',size:1,file:new File([b64('${ifcB64}')],'config.bin')},
      {name:'interface.png',size:2,file:new File([b64('${ifcPngB64}')],'interface.png')},
      {name:'rom.bin',size:3,file:new File([b64('${romB64}')],'rom.bin')},
    ];
    selSet.clear();selSet.add('config.bin');selSet.add('interface.png');selSet.add('rom.bin');
    await importSelectedFiles();
    return {model:currentModel&&currentModel.name,iface:!!(currentModel&&currentModel.iface)};
  })()`);
  check('清单导入选中文件（模块包+界面图）', impSel?.model==='IfaceClasswiz'&&impSel.iface, JSON.stringify(impSel));

  // 16) 多文件直接导入（smartImport：config+rom）
  const impMulti=await evalJs(`(async()=>{
    const b64=(s)=>{const b=atob(s);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u};
    const files=[new File([b64('${cfgB64}')],'config.bin'),new File([b64('${romB64}')],'rom.bin')];
    await smartImport(files);
    return {model:currentModel&&currentModel.name};
  })()`);
  check('多文件直接导入', impMulti?.model==='TestClasswiz', JSON.stringify(impMulti));

  // 17) 刷新间隔设置生效
  const rf=await evalJs(`(()=>{
    const inp=document.getElementById('setRefresh');
    inp.value='200';inp.dispatchEvent(new Event('change'));
    const v1=refreshMs;
    inp.value='3';inp.dispatchEvent(new Event('change'));
    const v2=refreshMs; // 应被 clamp 到 5
    inp.value='16';inp.dispatchEvent(new Event('change'));
    return {v1,v2,v3:refreshMs};
  })()`);
  check('刷新间隔设置（clamp 5-2000）', rf.v1===200&&rf.v2===5&&rf.v3===16, JSON.stringify(rf));

  // 18) models 目录：无句柄时 restore 不崩溃 + dir 模式提示
  const dir=await evalJs(`(()=>{
    const before=document.getElementById('dirStatus');
    let crashed=false;
    try{restoreModelsDir()}catch(e){crashed=String(e)}
    return {crashed};
  })()`);
  check('models 目录句柄恢复无异常', dir.crashed===false, JSON.stringify(dir));

  // console 错误汇总
  check('无 console 错误', consoleErrs.length===0, consoleErrs.slice(0,5).join(' | '));

  const failed=results.filter(r=>!r.ok);
  console.log('\n===== 汇总 ===== 通过 '+results.filter(r=>r.ok).length+'/'+results.length+(failed.length?' 失败: '+failed.map(f=>f.name).join(', '):''));
  ws.close();chrome.kill();
  process.exit(failed.length?1:0);
}
main().catch(e=>{console.error('driver error',e);chrome.kill();process.exit(1)});
