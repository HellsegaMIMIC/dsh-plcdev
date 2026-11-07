'use strict';
// Verification only: execute the installed FUXA functions unchanged, without
// starting its server, devices, scripts, timers, users or network connections.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
const FUXA=path.join(ROOT,'.tools/fuxa/runtime/node_modules/@frangoteam/fuxa');
const ts=require(path.join(ROOT,'software/openplc-editor-zh/node_modules/typescript'));
const utils=require(path.join(FUXA,'runtime/utils.js'));
const {JSDOM}=require(path.join(ROOT,'software/openplc-editor-zh/node_modules/jsdom'));
const files={server:'runtime/index.js',scripts:'runtime/scripts/index.js',project:'runtime/project/index.js'};
const evidence=[];
function source(relative){const filename=path.join(FUXA,relative),text=fs.readFileSync(filename,'utf8');evidence.push({file:relative,sha256:crypto.createHash('sha256').update(text).digest('hex')});return ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);}
function find(ast,predicate){const found=[];function visit(node){if(predicate(node))found.push(node);ts.forEachChild(node,visit);}visit(ast);if(found.length!==1)throw Error('Installed FUXA function is absent/ambiguous');return found[0].getText(ast);}
const serverAst=source(files.server),projectAst=source(files.project),scriptsAst=source(files.scripts);
const server=find(serverAst,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='checkPermission');
const filter=find(projectAst,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='_filterProjectPermission');
find(scriptsAst,n=>ts.isBinaryExpression(n)&&n.left.getText(scriptsAst)==='this.isAuthorised');
let scriptFn;
function rhs(node){if(ts.isBinaryExpression(node)&&node.left.getText(scriptsAst)==='this.isAuthorised')scriptFn=node.right.getText(scriptsAst);ts.forEachChild(node,rhs);}rhs(scriptsAst);
const main=fs.readdirSync(path.join(FUXA,'dist')).filter(x=>/^main\..*\.js$/.test(x));if(main.length!==1)throw Error('Installed FUXA client bundle ambiguous');
const clientAst=source('dist/'+main[0]);
const client=find(clientAst,n=>ts.isMethodDeclaration(n)&&n.name?.getText(clientAst)==='checkPermission');
const nullHelper=find(clientAst,n=>ts.isMethodDeclaration(n)&&n.name?.getText(clientAst)==='isNullOrUndefined');
const alias=client.match(/([\w$]+)\.([\w$]+)\.isNullOrUndefined\(/);if(!alias)throw Error('Unknown client null helper reference');
const nullFn=vm.runInNewContext('({'+nullHelper.replace(/^static\s+/,'')+'}).isNullOrUndefined');

function domRows(view, cache){
 const key=JSON.stringify([view.svgcontent,Object.keys(view.items)]);
 if(cache?.has(key))return cache.get(key);
 const dom=new JSDOM('<!doctype html><body>'+view.svgcontent+'</body>');
 const rows=[];
 for(const item of Object.values(view.items)){
  const element=dom.window.document.getElementById(item.id);
  if(!element)throw Error('Native filtered control missing in DOM');
  let hidden=false;
  for(let p=element;p;p=p.parentElement)if(p.getAttribute('visibility')==='hidden'||p.getAttribute('visibility')==='collapse'||p.style?.visibility==='hidden'||p.style?.display==='none'||p.hidden)hidden=true;
  rows.push({view:view.id,id:item.id,matchingElements:[...dom.window.document.querySelectorAll('[id]')].filter(e=>e.id===item.id).length,
   visibility:element.getAttribute('visibility'),visible:!hidden,
   controls:[...element.querySelectorAll('input,button,select')].map(e=>({id:e.id,tag:e.localName,type:e.type,
    disabled:e.disabled===true||e.hasAttribute('disabled'),readonly:e.readOnly===true||e.hasAttribute('readonly'),
    min:e.getAttribute('min'),max:e.getAttribute('max'),step:e.getAttribute('step')}))});
 }
 dom.window.close();
 if(cache){if(cache.size>=128)cache.delete(cache.keys().next().value);cache.set(key,rows);}
 return rows;
}

function evaluate(project,user,settings,cache){
 const sandbox={settings,utils,data:project,logger:{error:err=>{throw err;}},scriptModule:{getScript:s=>project.scripts.find(x=>x.id===s.id)}};
 sandbox.runtime={settings};vm.createContext(sandbox);
 sandbox.runtime.checkPermission=vm.runInContext('('+server+')',sandbox);
 sandbox.runtime.scriptsMgr={isAuthorised:vm.runInContext('('+scriptFn+')',sandbox)};
 const projectPermission=sandbox.runtime.checkPermission(user,false);
 const permissionFilterApplied=!projectPermission.show||!projectPermission.enabled;
 const filtered=vm.runInContext('('+filter+')',sandbox)(user);
 const checkClient=vm.runInNewContext('({'+client+'}).checkPermission',{[alias[1]]:{[alias[2]]:{isNullOrUndefined:nullFn}}});
 const clientContext={currentUser:typeof user==='object'&&user!==null?{groups:user.groups,infoRoles:user.info?.roles}:{groups:user},settings:{getSettings:()=>settings}};
 const records=[];
 for(const script of project.scripts)records.push({kind:'script',id:script.id,server:sandbox.runtime.scriptsMgr.isAuthorised(script,user),client:checkClient.call(clientContext,script,true)});
 for(const view of project.hmi.views)for(const item of Object.values(view.items))records.push({kind:'control',view:view.id,id:item.id,server:sandbox.runtime.checkPermission(user,item.property,false,true),client:checkClient.call(clientContext,item.property)});
 const ui=[];
 for(const view of filtered.hmi.views){
  // FUXA adds HTML boolean 'disabled' attributes; parse as the browser does,
  // not strict XML, which would reject the native filter's output.
  for(const row of domRows(view,cache))ui.push({...row,events:view.items[row.id].property.events});
 }
 return {records,filtered,ui,permissionFilterApplied};
}
module.exports={evaluate,domRows,evidence,FUXA};
if(require.main===module){const input=JSON.parse(fs.readFileSync(0,'utf8'));const results=input.cases.map(c=>evaluate(c.project,c.user,c.settings));process.stdout.write(JSON.stringify({version:JSON.parse(fs.readFileSync(path.join(FUXA,'package.json'),'utf8')).version,evidence,results}));}
