const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
const bounded=(value,max)=>typeof value==='string'&&value.length<=max;
const color=value=>bounded(value,32)&&/^(?:|transparent|#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i.test(value);

/** The server supplies only bounded, static drawing data, never a FUXA project. */
export function validHmiSnapshot(value){
  if(value===null)return true;
  if(!object(value)||!keys(value,['views','partial'])||!Array.isArray(value.views)||value.views.length>16||
    value.partial!==undefined&&typeof value.partial!=='boolean')return false;
  const ids=new Set();
  for(const view of value.views){
    if(!object(view)||!keys(view,['id','name','width','height','background','svg','partial'])||
      !bounded(view.id,256)||!view.id||ids.has(view.id)||!bounded(view.name,256)||
      ![view.width,view.height].every(size=>Number.isFinite(size)&&size>=1&&size<=16384)||
      !color(view.background)||!bounded(view.svg,262144)||typeof view.partial!=='boolean'||
      view.svg&&!/^<svg(?:\s|>)/.test(view.svg)||/<!DOCTYPE|<!ENTITY/i.test(view.svg))return false;
    ids.add(view.id);
  }
  return true;
}

function viewFingerprint(view){
  return view?JSON.stringify([view.name,view.width,view.height,view.background,view.svg,view.partial]):null;
}

/** Pair stable native view IDs; array order is not a version relationship. */
export function hmiViewPairs(file){
  const before=file.beforeHmi?.views||[],after=file.afterHmi?.views||[];
  const old=new Map(before.map(view=>[view.id,view])),next=new Map(after.map(view=>[view.id,view]));
  const ids=[...next.keys(),...old.keys()].filter((id,index,all)=>all.indexOf(id)===index);
  return ids.map(id=>{
    const previous=old.get(id)||null,current=next.get(id)||null;
    return {id,before:previous,after:current,name:current?.name||previous?.name||'未命名画面',
      changed:viewFingerprint(previous)!==viewFingerprint(current)};
  }).sort((a,b)=>Number(b.changed)-Number(a.changed));
}

/** SVG is decoded by the image subsystem, never inserted as document markup. */
export function svgImageUrl(svg){
  try{return 'data:image/svg+xml;base64,'+btoa(encodeURIComponent(svg).replace(/%([0-9A-F]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16))));}
  catch{return '';}
}
