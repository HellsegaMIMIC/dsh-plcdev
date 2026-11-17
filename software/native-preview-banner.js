/* BEGIN GENERATED PLCDEV BRAND */
const plcdevNativeBrand = {"brandName":"PLCdev","brandMark":"-()-","brandCss":"\n/* Lucide parentheses — ISC License\nCopyright (c) 2026 Lucide Icons and Contributors\nPermission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.\nTHE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES\nWITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF\nMERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR\nANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES\nWHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN\nACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF\nOR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.\n*/\n.plcdev-scope, button[aria-label=\"PLCdev\"]:has(.plcdev-entry-mark) {\n  --plcdev-accent: #7250B8;\n  --plcdev-tint: #F1EBFA;\n  --plcdev-on-accent: #fff;\n  --plcdev-mark-size: 19px;\n  --plcdev-rail-size: 3px;\n}\n@supports (color: light-dark(white, black)) {\n  .plcdev-scope, button[aria-label=\"PLCdev\"]:has(.plcdev-entry-mark) {\n    --plcdev-accent: light-dark(#7250B8, #C9AEFF);\n    --plcdev-tint: light-dark(#F1EBFA, #31263E);\n    --plcdev-on-accent: light-dark(#fff, #231831);\n  }\n}\n.plcdev-scope.plcdev-rail {\n  box-sizing: border-box;\n  border-inline-start: var(--plcdev-rail-size) solid var(--plcdev-accent);\n}\n.plcdev-title {\n  display: inline-flex;\n  flex-wrap: wrap;\n  align-items: baseline;\n  gap: .15em .5em;\n  min-inline-size: 0;\n  max-inline-size: 100%;\n  overflow-wrap: anywhere;\n}\n.plcdev-identity {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  flex: none;\n  color: var(--plcdev-accent);\n  white-space: nowrap;\n  font-weight: 600;\n}\n.plcdev-title-compact { flex-wrap: nowrap; align-items: center; }\n.plcdev-title-compact > span:last-child { min-inline-size: 0; }\n.plcdev-mark {\n  display: inline-grid;\n  place-items: center;\n  flex: none;\n  inline-size: var(--plcdev-mark-size);\n  block-size: var(--plcdev-mark-size);\n  color: var(--plcdev-accent);\n  background: transparent;\n  border-radius: 0;\n  font: 700 8px/1 ui-monospace, monospace;\n}\n@supports (mask-image: url(\"\")) {\n  .plcdev-mark { position: relative; font-size: 0; }\n  .plcdev-mark::before {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    inline-size: 100%;\n    block-size: 100%;\n    background: currentColor;\n    mask: url(\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%223.35%22%20stroke-linecap%3D%22butt%22%20stroke-linejoin%3D%22miter%22%3E%3Cg%20transform%3D%22translate(.96%20.96)%20scale(.92)%22%20stroke-width%3D%223.641304347826087%22%3E%3Cpath%20transform%3D%22translate(.75%200)%22%20d%3D%22M8%2021s-4-3-4-9%204-9%204-9%22%2F%3E%3Cpath%20transform%3D%22translate(-.75%200)%22%20d%3D%22M16%203s4%203%204%209-4%209-4%209%22%2F%3E%3C%2Fg%3E%3Cpath%20d%3D%22M1.49%2012H5.33M18.67%2012h3.84%22%2F%3E%3C%2Fsvg%3E\") center / contain no-repeat;\n    pointer-events: none;\n    forced-color-adjust: none;\n  }\n}\n.plcdev-scope :is(button, a, select, input, textarea, summary):focus-visible,\n.plcdev-scope:is(button, [role=tab]):focus-visible {\n  outline: 2px solid var(--plcdev-accent);\n  outline-offset: 2px;\n}\n.plcdev-scope .plcdev-link:not(:disabled):not([aria-disabled=true]) {\n  color: var(--plcdev-accent);\n  text-decoration: underline;\n  text-underline-offset: .16em;\n}\n.plcdev-scope .plcdev-action {\n  background: var(--plcdev-accent);\n  border-color: var(--plcdev-accent);\n  color: var(--plcdev-on-accent);\n}\n.plcdev-scope .plcdev-action:hover:not(:disabled) { filter: brightness(.95); }\n.plcdev-scope .plcdev-selected.plcdev-selected,\n.plcdev-scope .plcdev-tab[aria-current=page],\n.plcdev-scope .plcdev-tab[aria-expanded=true],\n.plcdev-scope[role=tab][aria-selected=true] {\n  background-color: var(--plcdev-tint);\n  color: var(--plcdev-accent);\n  text-decoration: underline;\n  text-underline-offset: .24em;\n}\n@media (forced-colors: active) {\n  .plcdev-scope, button[aria-label=\"PLCdev\"]:has(.plcdev-entry-mark) {\n    --plcdev-accent: LinkText;\n    --plcdev-tint: Canvas;\n    --plcdev-on-accent: Canvas;\n  }\n  .plcdev-mark { color: CanvasText; }\n}\n"};
/* END GENERATED PLCDEV BRAND */
/* Compact, persistent lifecycle strip shared by native FUXA and OIP previews. */
function installPlcdevNativeBrand(){
 if(document.querySelector('style[data-plcdev-brand=native]'))return;
 const style=document.createElement('style');
 style.dataset.plcdevBrand='native';
 style.textContent=plcdevNativeBrand.brandCss+'\n#plcdev-native-preview-status:not([hidden]){display:flex}';
 document.head.append(style);
}
function plcdevNativeTitle(title){
 const wrapper=document.createElement('span');wrapper.className='plcdev-title';
 const identity=document.createElement('span');identity.className='plcdev-identity';
 const mark=document.createElement('span');mark.className='plcdev-mark';mark.setAttribute('aria-hidden','true');mark.textContent=plcdevNativeBrand.brandMark;
 const name=document.createTextNode(plcdevNativeBrand.brandName);
 const feature=document.createElement('span');feature.textContent=title;
 identity.append(mark,name);wrapper.append(identity,feature);return wrapper;
}
function installPlcdevPreviewBanner(request,onResize){
 let bar=null,label=null,button=null,last=null,busy=false,stopped=false,inflight=false;
 function ensure(){
  if(bar)return;
  installPlcdevNativeBrand();
  bar=document.createElement('aside');bar.id='plcdev-native-preview-status';bar.className='plcdev-scope plcdev-rail';
  bar.setAttribute('aria-label',plcdevNativeBrand.brandName+' 工程预览');
  // Keep the native tool's entire layout intact; this small strip sits at the
  // bottom rather than covering its toolbar, project tree or editor canvas.
  bar.style.cssText='position:fixed;bottom:8px;left:50%;transform:translateX(-50%);z-index:2147483600;align-items:center;flex-wrap:wrap;gap:5px 12px;width:max-content;max-width:calc(100vw - 24px);padding:7px 12px;border:1px solid light-dark(#b3beca,#505664);border-inline-start:var(--plcdev-rail-size) solid var(--plcdev-accent);border-radius:8px;background:#f5f8fc;background:light-dark(#f5f8fc,#22252d);color:#26364b;color:light-dark(#26364b,#e4e8f0);box-shadow:0 2px 12px #0002;font:13px/1.4 system-ui,sans-serif;';
  const heading=document.createElement('strong');heading.append(plcdevNativeTitle('工程预览'));
  label=document.createElement('span');label.className='plcdev-preview-label';label.setAttribute('role','status');label.style.cssText='min-width:0;overflow-wrap:anywhere';
  label.title='此窗口的手工修改只留在预览中。打开当前工程不会覆盖此窗口。';
  button=document.createElement('button');button.type='button';button.textContent='打开当前工程';
  button.className='plcdev-link';
  button.style.cssText='border:0;background:transparent;white-space:nowrap;font:inherit;cursor:pointer;padding:2px 0';
  button.addEventListener('click',async()=>{
   if(busy||!last?.canOpenCurrent)return;busy=true;button.disabled=true;label.textContent='正在打开当前工程…';
   try{const value=await request('current',last.currentRevision);render(value);if(value.message)label.textContent=value.message;}
   catch{last=null;label.textContent='无法打开当前工程 · 请回 DSH 核对';}
   finally{busy=false;button.disabled=!last?.canOpenCurrent;}
  });
  bar.append(heading,label,button);document.body.append(bar);
  if(onResize&&typeof ResizeObserver==='function'){
   const layout=new ResizeObserver(()=>onResize(bar.offsetHeight?bar.offsetHeight+8:0));
   layout.observe(bar);
  }
 }
 function render(value){
  if(value?.active===false){if(bar)bar.hidden=true;last=null;return;}
  ensure();bar.hidden=false;last=value;bar.dataset.previewState=value?.state||'unknown';
  label.textContent=value?.label||'预览状态无法核对';button.disabled=busy||!value?.canOpenCurrent;
  button.style.opacity=button.disabled?'.5':'1';
 }
 async function poll(){
  if(stopped||inflight||busy)return;inflight=true;
  try{render(await request('status'));}catch{render({active:true,state:'unknown',label:'预览状态无法核对',canOpenCurrent:false});}
  finally{inflight=false;}
 }
 const start=()=>{poll();setInterval(poll,2500);};
 window.addEventListener('pagehide',()=>stopped=true);
 window.addEventListener('pageshow',()=>{stopped=false;poll();});window.addEventListener('focus',poll);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
 return {poll};
}
