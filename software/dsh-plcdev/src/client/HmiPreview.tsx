import React,{useMemo,useState} from 'react';
import {hmiViewPairs,svgImageUrl} from './hmi-preview.mjs';

const hmiCss=`
.pc-hmi-preview{min-width:0;padding:6px 0 10px}.pc-hmi-toolbar{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:9px}.pc-hmi-toolbar>strong{min-width:0;flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:500}.pc-hmi-toolbar>select{min-width:0;max-width:calc(100% - 70px);flex:1;border:1px solid var(--pc-line);border-radius:6px;padding:4px 6px;background:var(--pc-surface);color:inherit;font:inherit}.pc-hmi-static{margin-left:auto;flex:none;font-size:11px;color:var(--pc-sub)}
.pc-hmi-pair{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0}.pc-hmi-side{margin:0;min-width:0}.pc-hmi-side>figcaption{display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--pc-sub);margin-bottom:5px}.pc-hmi-frame{border:1px solid var(--pc-line);border-radius:7px;min-width:0;overflow:hidden;background:#fff}.pc-hmi-frame img{display:block;width:100%;height:auto;max-width:100%;pointer-events:none;user-select:none}.pc-hmi-empty{display:grid;place-items:center;min-height:88px;padding:14px;color:var(--pc-sub);font-size:12px;text-align:center;background:var(--pc-canvas)}.pc-hmi-preview .pc-hmi-notice{margin:8px 0 0;font-size:11px;color:var(--pc-sub)}
.pc-result-overlay .pc-hmi-pair{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}@media(max-width:600px){.pc-result-overlay .pc-hmi-pair{grid-template-columns:minmax(0,1fr)}}
`;

function HmiSide({view,label,empty}:any){
  const [failedImage,setFailedImage]=useState('');
  const image=useMemo(()=>view?.svg?svgImageUrl(view.svg):'', [view?.svg]);
  // Keep failure attached to its source: a passive reset can otherwise erase
  // a decoding error that arrives immediately after this image is mounted.
  const failed=!!image&&failedImage===image;
  return <figure className="pc-hmi-side"><figcaption><span>{label}</span>{view?.partial&&<span>部分元素未展示</span>}</figcaption>
    <div className="pc-hmi-frame" style={view?{background:view.background||'#fff'}:undefined}>
      {image&&!failed?<img src={image} alt={label+' · '+(view.name||'HMI 画面')} width={view.width} height={view.height} draggable={false} onError={()=>setFailedImage(image)}/>:<div className="pc-hmi-empty">{failed?'画面未能显示，请在 FUXA 查看。':view?'此画面暂不能静态展示。':empty}</div>}
    </div></figure>;
}

export function HmiPreview({file,afterLabel='修改后'}:any){
  const pairs=useMemo(()=>hmiViewPairs(file),[file]),[selected,setSelected]=useState('');
  const pair=pairs.find((item:any)=>item.id===selected)||pairs[0];
  const beforeMissing=file.beforeUnavailable?'旧基线不可用':file.beforeHmi?.partial?'此画面未提供预览':file.beforeSha256===null?'此前没有此画面':'此版本没有这幅画面';
  const afterMissing=file.afterUnavailable?'此版本暂不能预览':file.afterHmi?.partial?'此画面未提供预览':file.afterSha256===null?'此文件已移除':'此画面已移除';
  if(file.truncated)return <p>画面超出预览范围，请在 FUXA 查看。</p>;
  if(!pair)return <p>{file.unavailableReason||'没有可静态展示的画面，请在 FUXA 查看。'}</p>;
  return <section className="pc-hmi-preview" aria-label="HMI 画面前后对比"><style>{hmiCss}</style>
    <div className="pc-hmi-toolbar">{pairs.length>1?<select aria-label="选择 HMI 画面" value={pair.id} onChange={event=>setSelected(event.target.value)}>{pairs.map((item:any)=><option key={item.id} value={item.id}>{item.name}{!item.before&&!file.beforeUnavailable&&!file.beforeHmi?.partial?' · 新增':!item.after&&!file.afterUnavailable&&!file.afterHmi?.partial?' · 移除':''}</option>)}</select>:<strong title={pair.name}>{pair.name}</strong>}<span className="pc-hmi-static">静态画面</span></div>
    <div className="pc-hmi-pair">
      <HmiSide key={'before:'+pair.id} view={pair.before} label="修改前" empty={beforeMissing}/>
      <HmiSide key={'after:'+pair.id} view={pair.after} label={afterLabel} empty={afterMissing}/>
    </div>
    {file.unavailableReason?<p className="pc-hmi-notice">{file.unavailableReason}</p>:(file.beforeHmi?.partial||file.afterHmi?.partial)&&!pair.before?.partial&&!pair.after?.partial?<p className="pc-hmi-notice">部分画面未展示。</p>:!pair.changed?<p className="pc-hmi-notice">画面外观未变化。</p>:null}
  </section>;
}
