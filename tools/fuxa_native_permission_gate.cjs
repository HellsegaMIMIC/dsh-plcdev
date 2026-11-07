'use strict';
// Local, mandatory proof over the pinned native filter/client and actual DOM.
// No server initialization, script execution, event dispatch, login or network.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..'),PIN=path.join(__dirname,'fuxa_permission_engine.json');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const pinBytes=fs.readFileSync(PIN),pin=JSON.parse(pinBytes),engineDigest=hash(pinBytes);
for(const [name,expected] of Object.entries(pin.files))if(hash(fs.readFileSync(path.join(ROOT,name)))!==expected)throw Error('Unpinned native engine: '+name);
const {evaluate,domRows}=require('./fuxa_native_permission_oracle.cjs');
const {JSDOM}=require(path.join(ROOT,'software/openplc-editor-zh/node_modules/jsdom'));
const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
function requireTrue(value,message){if(!value)throw Error(message);}

function parseProof(svg){
 const xml=new JSDOM(svg,{contentType:'image/svg+xml'}),html=new JSDOM('<!doctype html><body>'+svg+'</body>');
 const signature=node=>({tag:node.localName,ns:node.namespaceURI,attrs:[...node.attributes].map(a=>[a.name,a.value]).sort(),
  children:[...node.childNodes].map(n=>n.nodeType===1?signature(n):n.nodeType===3?{text:n.textContent}: {unsupported:n.nodeType})});
 const original=xml.window.document.documentElement,parsed=html.window.document.querySelector('svg');
 requireTrue(parsed&&stable(signature(original))===stable(signature(parsed)),'XML/HTML DOM interpretations differ');
 const ids=[...parsed.querySelectorAll('[id]')].map(n=>n.id);
 requireTrue(new Set(ids).size===ids.length,'Duplicate parsed DOM IDs');
 const proof=hash(stable(signature(parsed)));xml.window.close();html.window.close();return proof;
}

function roleUniverse(project){
 const names=new Set();
 function visit(value){if(!value||typeof value!=='object')return;
  if(Object.hasOwn(value,'permissionRoles')&&value.permissionRoles)for(const key of ['show','enabled']){
   const roles=value.permissionRoles[key];if(Array.isArray(roles))for(const role of roles)names.add(role);
  }
  for(const child of Object.values(value))visit(child);
 }
 visit(project);requireTrue(names.size<=pin.maxDistinctRoles,'Role state space exceeds supported four-role bound');return [...names].sort();
}

function principals(roles){
 const result=[];
 for(const secureEnabled of [false,true]){
  // Include non-admin low8=255 (511), truthy high bits (256), and a truthy
  // number whose JS ToInt32 is zero (2**32). -1/255 are exact admin values.
  // Script permissions/code stay identical independently of these classes.
  for(const user of [...Array(256).keys(),256,511,2**32,-1,null])result.push({label:'mask:'+secureEnabled+':'+user,user,settings:{secureEnabled,userRole:false}});
  const arrays=Array.from({length:2**roles.length},(_,bits)=>roles.filter((_,i)=>bits&(1<<i)));
  let other='__unlisted_role__';while(roles.includes(other))other+='_';arrays.push([other]);
  for(const r of arrays)for(const groups of [0,1,255,-1])result.push({label:'roles:'+secureEnabled+':'+groups+':'+stable(r),user:{groups,info:{roles:r}},settings:{secureEnabled,userRole:true}});
  for(const user of [null,-1,255,{groups:1},{groups:1,info:{}},{groups:1,info:{roles:null}}])result.push({label:'missing:'+secureEnabled+':'+stable(user),user,settings:{secureEnabled,userRole:true}});
 }
 return result;
}

function gate(input){
 const {source,candidate,pairs}=input;
 requireTrue(source.hmi.views.length===1&&candidate.hmi.views.length===1,'Single bounded view required');
 const a=source.hmi.views[0],b=candidate.hmi.views[0];
 requireTrue(/^[\x00-\x7f]*$/.test(b.svgcontent)&&b.svgcontent.toLowerCase().length===b.svgcontent.length,'Final SVG must preserve every JS UTF-16/lowercase offset');
 const scriptMap=p=>Object.fromEntries(p.scripts.map(s=>[s.id,s]));
 requireTrue(stable(scriptMap(source))===stable(scriptMap(candidate)),'Script identity, code or authorization changed');
 requireTrue(stable(source.hmi.layout)===stable(candidate.hmi.layout),'Layout authorization changed');
 requireTrue(pairs.length===Object.keys(a.items).length&&pairs.length===Object.keys(b.items).length,'Incomplete interaction map');
 requireTrue(new Set(pairs.map(p=>p.source)).size===pairs.length&&new Set(pairs.map(p=>p.candidate)).size===pairs.length,'Ambiguous interaction map');
 const parseProofs={source:parseProof(a.svgcontent),candidate:parseProof(b.svgcontent)};
 const roles=roleUniverse(source);requireTrue(stable(roles)===stable(roleUniverse(candidate)),'Role identities changed');
 const profiles=principals(roles),cache=new Map(),vectors=crypto.createHash('sha256');
 let controlsChecked=0;
 function compare(oldRows,newRows,label,oldRecords,newRecords,filterApplied){
  for(const pair of pairs){
   const old=oldRows.find(r=>r.id===pair.source),next=newRows.find(r=>r.id===pair.candidate);
   requireTrue(old&&next&&old.matchingElements===1&&next.matchingElements===1,label+': missing/ambiguous DOM');
   requireTrue(!next.visible||old.visible,label+': visibility expanded '+pair.key);
   requireTrue(old.controls.length===next.controls.length,label+': HTML interaction count changed');
   const state={key:pair.key,sourceVisible:old.visible,candidateVisible:next.visible,html:[]};
   for(let i=0;i<old.controls.length;i++){
    const x=old.controls[i],y=next.controls[i];
    requireTrue(x.tag===y.tag&&x.type===y.type,label+': interaction type changed');
    requireTrue(!x.readonly||y.readonly,label+': HTML readonly lost '+pair.key);
    requireTrue(!x.disabled||y.disabled,label+': HTML disabled lost '+pair.key);
    // Native number inputs do not apply options.readonly during initElement.
    // Compare the actual HTML property; metadata is preserved independently.
    const capabilities=(row,c)=>({editable:c.tag==='input'&&row.visible&&!c.disabled&&!c.readonly,
      enterDispatchable:c.tag==='input'&&row.visible&&!c.disabled,clickable:c.tag==='button'&&row.visible&&!c.disabled});
    const oldCaps=capabilities(old,x),newCaps=capabilities(next,y);
    for(const key of Object.keys(oldCaps))requireTrue(!newCaps[key]||oldCaps[key],label+': '+key+' expanded '+pair.key);
    if(x.tag==='input'){
     requireTrue(x.type==='number'&&y.type==='number'&&x.step===y.step&&x.step==='1','Only fixed number/step=1 input semantics supported');
     requireTrue(Number.isFinite(Number(x.min))&&Number.isFinite(Number(x.max))&&Number(y.min)>=Number(x.min)&&Number(y.max)<=Number(x.max),'HTML input range expanded');
    }
    state.html.push({source:x,candidate:y,sourceCapabilities:oldCaps,candidateCapabilities:newCaps});
   }
   if(oldRecords){
    const before=oldRecords.find(r=>r.id===pair.source&&r.kind==='control'),after=newRecords.find(r=>r.id===pair.candidate&&r.kind==='control');
    for(const side of ['server','client'])for(const cap of ['show','enabled'])requireTrue(!after[side][cap]||before[side][cap],label+': native authorization expanded');
    const oldEvents=(old.events||[]).map(stable),newEvents=(next.events||[]).map(stable);
    requireTrue(newEvents.every(e=>oldEvents.includes(e)),label+': filtered events expanded');
    if(filterApplied&&!after.server.show)requireTrue(!next.visible,label+': native hidden permission not applied');
    else if(filterApplied&&!after.server.enabled){
     requireTrue(!newEvents.length&&next.controls.every(c=>c.disabled),label+': native disabled permission not applied');
    }
    state.sourceEvents=oldEvents;state.candidateEvents=newEvents;
   }
   vectors.update(stable([label,state]));controlsChecked++;
  }
 }
 compare(domRows(a,cache),domRows(b,cache),'unfiltered');
 for(const profile of profiles){
  const old=evaluate(source,profile.user,profile.settings,cache),next=evaluate(candidate,profile.user,profile.settings,cache);
  requireTrue(old.permissionFilterApplied===next.permissionFilterApplied,'Native filtering mode changed');
  compare(old.ui,next.ui,profile.label,old.records,next.records,next.permissionFilterApplied);
  for(const script of old.records.filter(r=>r.kind==='script')){
   const after=next.records.find(r=>r.kind==='script'&&r.id===script.id);
   requireTrue(after&&(!after.server||script.server)&&(!after.client.enabled||script.client.enabled)&&(!after.client.show||script.client.show),profile.label+': script authorization expanded');
  }
  requireTrue(next.filtered.scripts.every(s=>old.filtered.scripts.some(o=>s.id===o.id)),profile.label+': script exposure expanded');
 }
 return {ok:true,policy:pin.policy,engineDigest,allNonexpanding:true,profileCount:profiles.length,roles,
  controlsChecked,sourceDigest:hash(stable(source)),candidateDigest:hash(stable(candidate)),parseProofs,outcomeDigest:vectors.digest('hex'),
  invariant:['ASCII raw SVG preserves JavaScript UTF-16 lowercase offsets','XML and HTML DOM equality','no increased visible/editable/Enter/click/event/script capabilities','readonly and disabled never removed','native hidden/disabled decisions actually applied'],
  scope:'bounded native DOM and pinned native authorization; no real browser events or runtime commands'};
}
module.exports={gate,principals};
if(require.main===module){try{
 const raw=fs.readFileSync(0,'utf8'),wire=JSON.parse(raw);
 requireTrue(wire.receiptVersion===2&&typeof wire.source==='string'&&typeof wire.candidate==='string','Unsupported receipt wire version');
 const result=gate({source:JSON.parse(wire.source),candidate:JSON.parse(wire.candidate),pairs:wire.pairs});
 process.stdout.write(JSON.stringify({...result,receiptVersion:2,inputDigest:hash(raw),
  sourceDigest:hash(wire.source),candidateDigest:hash(wire.candidate)}));
}catch(error){process.stderr.write(error.message);process.exitCode=1;}}
