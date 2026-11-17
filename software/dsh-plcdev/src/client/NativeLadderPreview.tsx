import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {NativeLadderView,computeGraphicalDiff} from './native-ladder/generated.cjs';
import {nativeLadderCss} from './native-ladder/generated-css.mjs';
import {graphicalPreview} from './ladder-preview.mjs';

const layoutCss=`
.pc-graph{min-width:0}.pc-graph-nav{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px;font-size:11px;color:var(--pc-sub)}.pc-graph-nav button{padding:2px 8px!important;min-height:24px!important}.pc-native-ladder{width:var(--pc-graph-width);zoom:var(--pc-graph-scale);max-width:none}
.pc-native-ladder>div{height:auto;max-height:none}
.pc-native-ladder :is(.overflow-auto,.overflow-x-auto,.overflow-y-auto){overflow:visible;overflow-x:visible;overflow-y:visible}
.pc-graph-error{padding:14px;margin:0;font-size:12px;line-height:1.6;color:var(--pc-sub)}
`;
class GraphBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<p className="pc-graph-error" role="status">图形暂未能显示，请在 OpenPLC 查看。</p>:this.props.children;}
}
export function NativeLadderPreview({file,afterLabel='修改后'}:any){
 const outer=useRef<HTMLDivElement>(null);
 const [width,setWidth]=useState(560),[index,setIndex]=useState(0),[dark,setDark]=useState(false);
 const prepared=useMemo(()=>{
  const source=graphicalPreview(file);if(source.error)return source;
  try{return {...source,result:computeGraphicalDiff(source.before,source.after,source.path)};}
  catch{return {error:'图形差异未能读取，请在 OpenPLC 查看。'};}
 },[file]);
 useEffect(()=>setIndex(0),[file]);
 useLayoutEffect(()=>{
  const element=outer.current;if(!element)return;
  const update=()=>{
   setWidth(Math.max(1,element.clientWidth||element.getBoundingClientRect().width||560));
   const color=getComputedStyle(element).color.match(/\d+/g);
   setDark(!!color&&Number(color[0])+Number(color[1])+Number(color[2])>450);
  };
  update();const resize=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update);resize?.observe(element);
  const theme=new MutationObserver(update);theme.observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
  window.addEventListener('resize',update);
  return()=>{resize?.disconnect();theme.disconnect();window.removeEventListener('resize',update);};
 },[file.path,prepared.error]);
 if(prepared.error)return <p className="pc-graph-error" role="status">{prepared.error}</p>;
 const {result}=prepared,changed=result.changedIndexes,selected=changed[Math.min(index,Math.max(0,changed.length-1))];
 const flow=result.flows[selected],natural=Math.max(480,flow?.originalWidth||0,flow?.currentWidth||0);
 return <div className="pc-graph" ref={outer} data-source="OpenPLC GraphicalDiffViewer"><style>{nativeLadderCss+layoutCss}</style>
  <GraphBoundary key={file.path+file.beforeSha256+file.afterSha256}><div className={'pc-native-ladder'+(dark?' dark':'')} style={{'--pc-graph-width':natural+'px','--pc-graph-scale':Math.min(1,width/natural)} as React.CSSProperties}>
   <NativeLadderView before={prepared.before} after={prepared.after} path={prepared.path} rung={selected} isDark={dark} beforeLabel="修改前" afterLabel={afterLabel}/>
  </div></GraphBoundary>
  {changed.length>1&&<div className="pc-graph-nav"><button disabled={index===0} onClick={()=>setIndex(i=>i-1)} aria-label="上一个改动网络">‹</button><span>{index+1} / {changed.length}</span><button disabled={index>=changed.length-1} onClick={()=>setIndex(i=>i+1)} aria-label="下一个改动网络">›</button></div>}
 </div>;
}

