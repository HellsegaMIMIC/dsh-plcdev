'use strict';
(() => {
  const root=document.getElementById('plcdev-workbench-refined');
  if(!root||root.dataset.panelLayout==='ready')return;
  const explorer=document.getElementById('p-explorer'),dock=document.getElementById('p-info-dock');
  const explorerHandle=document.getElementById('p-explorer-resizer'),infoHandle=document.getElementById('p-info-resizer');
  const explorerToggle=document.getElementById('p-explorer-toggle'),explorerRestore=document.getElementById('p-explorer-restore'),infoToggle=document.getElementById('p-info-toggle');
  if(!explorer||!dock||!explorerHandle||!infoHandle||!explorerToggle||!explorerRestore||!infoToggle)return;
  const shell=root.querySelector('.p-shell'),center=root.querySelector('.p-center'),tabs=document.getElementById('p-info-tabs');
  if(!shell||!center||!tabs)return;
  const storageKey='plcdev.workbench.panel-layout.v1';
  const clamp=(value,min,max)=>Math.round(Math.max(min,Math.min(max,value)));
  const preferences={version:1,explorerWidth:248,infoHeight:null,explorerCollapsed:false,infoCollapsed:false};
  try {
    const saved=JSON.parse(localStorage.getItem(storageKey));
    if(saved?.version===1){
      for(const key of ['explorerWidth','infoHeight'])if(typeof saved[key]==='number'&&Number.isFinite(saved[key])&&saved[key]>0&&saved[key]<=4096)preferences[key]=saved[key];
      for(const key of ['explorerCollapsed','infoCollapsed'])if(typeof saved[key]==='boolean')preferences[key]=saved[key];
    }
  } catch { /* A denied or malformed UI preference never blocks the workbench. */ }
  let activeDrag=null,resizeFrame=null,limits=null;
  const measure=(element,axis,fallback)=>element.getBoundingClientRect()[axis]||element[axis==='width'?'clientWidth':'clientHeight']||fallback;
  const persist=()=>{try{localStorage.setItem(storageKey,JSON.stringify(preferences));}catch{}};
  function bounds(){
    const width=measure(shell,'width',window.innerWidth),height=measure(center,'height',window.innerHeight);
    let reserved=0;
    for(const child of center.children){if(child===dock||child===infoHandle||child.classList.contains('p-work')||child.hidden)continue;reserved+=child.getBoundingClientRect().height||0;}
    const maxWidth=Math.max(120,Math.min(440,width-486)),maxHeight=Math.max(64,Math.min(500,height-reserved-226));
    return {minWidth:Math.min(180,maxWidth),maxWidth,minHeight:Math.min(110,maxHeight),maxHeight,height};
  }
  function separator(element,axis,value,min,max,collapsed){
    element.setAttribute('role','separator');element.tabIndex=0;
    element.setAttribute('aria-orientation',axis==='explorer'?'vertical':'horizontal');
    element.setAttribute('aria-controls',axis==='explorer'?'p-explorer':'p-info-dock');
    element.setAttribute('aria-label',axis==='explorer'?'调整工程浏览器宽度':'调整信息区高度');
    element.setAttribute('aria-valuemin',String(min));element.setAttribute('aria-valuemax',String(max));element.setAttribute('aria-valuenow',String(value));
    element.setAttribute('aria-valuetext',value+' 像素');element.setAttribute('aria-expanded',String(!collapsed));
    element.title=axis==='explorer'?'拖动调整宽度；左右方向键调整，Enter 折叠':'拖动调整高度；上下方向键调整，Enter 折叠';
  }
  function apply(){
    limits=bounds();
    const width=clamp(preferences.explorerWidth,limits.minWidth,limits.maxWidth);
    const requestedHeight=preferences.infoHeight??clamp(limits.height*.27,155,240);
    const height=clamp(requestedHeight,limits.minHeight,limits.maxHeight);
    root.style.setProperty('--explorer-width',width+'px');root.style.setProperty('--info-height',height+'px');
    root.style.setProperty('--info-collapsed-height',Math.ceil(measure(tabs,'height',34)+1)+'px');
    root.dataset.explorerCollapsed=String(preferences.explorerCollapsed);root.dataset.infoCollapsed=String(preferences.infoCollapsed);
    explorerRestore.hidden=!preferences.explorerCollapsed;
    for(const button of [explorerToggle,explorerRestore]){button.setAttribute('aria-controls','p-explorer');button.setAttribute('aria-expanded',String(!preferences.explorerCollapsed));}
    explorerToggle.title='折叠工程浏览器';explorerToggle.setAttribute('aria-label','折叠工程浏览器');
    explorerRestore.title='展开工程浏览器';explorerRestore.setAttribute('aria-label','展开工程浏览器');
    infoToggle.setAttribute('aria-controls','p-info-dock');infoToggle.setAttribute('aria-expanded',String(!preferences.infoCollapsed));infoToggle.title=preferences.infoCollapsed?'展开信息区':'折叠信息区';infoToggle.setAttribute('aria-label',infoToggle.title);
    separator(explorerHandle,'explorer',width,limits.minWidth,limits.maxWidth,preferences.explorerCollapsed);
    separator(infoHandle,'info',height,limits.minHeight,limits.maxHeight,preferences.infoCollapsed);
  }
  function queueApply(){if(resizeFrame!==null)return;resizeFrame=requestAnimationFrame(()=>{resizeFrame=null;apply();});}
  function stopDrag(commit){
    if(!activeDrag)return;
    const drag=activeDrag;activeDrag=null;
    for(const [name,handler] of drag.listeners)window.removeEventListener(name,handler,true);
    if(!commit){preferences.explorerWidth=drag.previousWidth;preferences.infoHeight=drag.previousHeight;}
    try{if(drag.capture&&drag.element.hasPointerCapture?.(drag.pointerId))drag.element.releasePointerCapture(drag.pointerId);}catch{}
    delete root.dataset.panelResizing;apply();if(commit)persist();
  }
  function setCollapsed(axis,value,moveFocus=false){
    stopDrag(false);preferences[axis==='explorer'?'explorerCollapsed':'infoCollapsed']=value;apply();persist();
    if(moveFocus)(axis==='explorer'?(value?explorerRestore:explorerToggle):infoToggle).focus();
  }
  function beginDrag(event,axis,element,mouse=false){
    if(activeDrag||event.button!==0||event.isPrimary===false||(axis==='explorer'?preferences.explorerCollapsed:preferences.infoCollapsed)||element.hidden)return;
    event.preventDefault();apply();element.focus();
    const coordinate=axis==='explorer'?'clientX':'clientY';
    const drag={axis,element,pointerId:event.pointerId,start:event[coordinate],size:Number.parseFloat(root.style.getPropertyValue(axis==='explorer'?'--explorer-width':'--info-height')),previousWidth:preferences.explorerWidth,previousHeight:preferences.infoHeight,listeners:[],capture:false};
    activeDrag=drag;root.dataset.panelResizing=axis;
    if(!mouse){try{element.setPointerCapture(event.pointerId);drag.capture=true;}catch{ /* Window listeners also support browsers without pointer capture. */ }}
    const matches=e=>mouse||e.pointerId===drag.pointerId;
    const move=e=>{if(activeDrag!==drag||!matches(e))return;e.preventDefault();const delta=e[coordinate]-drag.start;limits=bounds();if(axis==='explorer')preferences.explorerWidth=clamp(drag.size+delta,limits.minWidth,limits.maxWidth);else preferences.infoHeight=clamp(drag.size-delta,limits.minHeight,limits.maxHeight);apply();};
    const up=e=>{if(activeDrag===drag&&matches(e))stopDrag(true);};
    const cancel=e=>{if(activeDrag===drag&&(!e||e.type==='blur'||matches(e)))stopDrag(false);};
    drag.listeners=mouse?[['mousemove',move],['mouseup',up],['blur',cancel]]:[['pointermove',move],['pointerup',up],['pointercancel',cancel],['blur',cancel]];
    for(const [name,handler] of drag.listeners)window.addEventListener(name,handler,{capture:true,passive:false});
  }
  function bindHandle(element,axis){
    element.addEventListener('pointerdown',event=>beginDrag(event,axis,element));
    if(!window.PointerEvent)element.addEventListener('mousedown',event=>beginDrag(event,axis,element,true));
    element.addEventListener('lostpointercapture',event=>{if(activeDrag?.element===element&&event.pointerId===activeDrag.pointerId)stopDrag(false);});
    element.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();setCollapsed(axis,true,true);return;}
      if(event.key==='Escape'&&activeDrag){event.preventDefault();stopDrag(false);return;}
      const step=event.shiftKey?40:12,explorerAxis=axis==='explorer',increase=event.key===(explorerAxis?'ArrowRight':'ArrowUp'),decrease=event.key===(explorerAxis?'ArrowLeft':'ArrowDown');
      if(!increase&&!decrease&&!['Home','End'].includes(event.key))return;
      event.preventDefault();stopDrag(false);apply();
      const key=explorerAxis?'explorerWidth':'infoHeight',min=explorerAxis?limits.minWidth:limits.minHeight,max=explorerAxis?limits.maxWidth:limits.maxHeight;
      const current=Number.parseFloat(root.style.getPropertyValue(explorerAxis?'--explorer-width':'--info-height'));
      preferences[key]=event.key==='Home'?min:event.key==='End'?max:clamp(current+(increase?step:-step),min,max);apply();persist();
    });
  }
  explorerToggle.addEventListener('click',()=>setCollapsed('explorer',true,true));
  explorerRestore.addEventListener('click',()=>setCollapsed('explorer',false,true));
  infoToggle.addEventListener('click',()=>setCollapsed('info',!preferences.infoCollapsed));
  // This listener changes presentation only. Existing handlers own all project and runtime actions.
  root.addEventListener('click',event=>{const choice=event.target.closest('[data-info-tab],[data-select]');if(choice&&!choice.disabled&&preferences.infoCollapsed)setCollapsed('info',false);},true);
  root.addEventListener('keydown',event=>{if(preferences.infoCollapsed&&event.target.closest('[data-info-tab]')&&['ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key))setCollapsed('info',false);});
  bindHandle(explorerHandle,'explorer');bindHandle(infoHandle,'info');
  window.addEventListener('resize',queueApply);
  // Re-clamp when the workbench adds/removes a banner or the connection panel.
  if(window.ResizeObserver){const observer=new ResizeObserver(queueApply);observer.observe(shell);observer.observe(center);for(const child of center.children)if(child!==dock&&child!==infoHandle&&!child.classList.contains('p-work'))observer.observe(child);}
  root.dataset.panelLayout='ready';apply();
})();
