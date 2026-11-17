import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

const toolKeys=['editor','runtime','msys','node','python','pythonEnvironment','dshCli','fuxaPackage','oipExecutable'];
const definitions=[
  {id:'openplc',key:'editor'},
  {id:'fuxa',key:'fuxaPackage',entries:['main.js']},
  {id:'oip',key:'oipExecutable'},
  {id:'runtime',key:'runtime',entries:['VERSION','CMakeLists.txt','core/src/CMakeLists.txt','scripts/compile.sh','scripts/Makefile.strucpp']},
  {id:'msys',key:'msys',entries:['usr/bin/bash.exe','usr/bin/g++.exe','usr/bin/cmake.exe','usr/bin/make.exe']},
];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function validate(value){
  if(!record(value)||value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','tools','state'].includes(key)))throw new Error('Invalid configuration');
  for(const [group,keys] of [['tools',toolKeys],['state',['runtimeOwnerDirectory']]]){
    const entries=Object.hasOwn(value,group)?value[group]:{};
    if(!record(entries)||Object.keys(entries).some(key=>!keys.includes(key)))throw new Error('Invalid configuration');
    for(const [key,item] of Object.entries(entries)){
      if(group==='tools'&&['node','python'].includes(key)&&item===null)continue;
      if(typeof item!=='string'||!item.trim()||/[\x00-\x1f]/.test(item)||item.length>32767)throw new Error('Invalid path');
    }
  }
  return value.tools??{};
}

/** Fixed, local, read-only installation probes. Never starts or installs tools. */
export function createToolEnvironment({projectRoot},{environment=process.env,platform=process.platform,read=readFile,inspect=stat}={}){
  const root=path.resolve(projectRoot),env=Object.fromEntries(Object.entries(environment).map(([key,value])=>[platform==='win32'?key.toLowerCase():key,value]));
  const envValue=key=>env[platform==='win32'?key.toLowerCase():key];
  const explicitConfig=envValue('PLCDEV_ENVIRONMENT_CONFIG');
  const configPath=path.resolve(root,explicitConfig||'outputs/local/environment.json');
  async function check(){
    let tools;
    try{
      tools=validate(JSON.parse((await read(path.join(root,'config/environment.defaults.json'),'utf8')).replace(/^\uFEFF/,'')));
      try{tools={...tools,...validate(JSON.parse((await read(configPath,'utf8')).replace(/^\uFEFF/,'')))};}
      catch(error){if(explicitConfig||error.code!=='ENOENT')throw error;}
    }catch{
      return {schemaVersion:1,checkedAt:new Date().toISOString(),configPath,configError:'本机工具配置无法读取，请按安装说明检查配置文件。',tools:definitions.map(({id,key})=>({id,key,state:'unchecked'}))};
    }
    const entries=await Promise.all(definitions.map(async({id,key,entries:required})=>{
      if(typeof tools[key]!=='string')return {id,key,state:'unchecked',reason:'尚未配置安装位置'};
      const expanded=tools[key].replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([^%]+)%/g,(match,a,b,c)=>envValue(a||b||c)??match);
      if(/\$\{|%[^%]+%|\$[A-Za-z_]/.test(expanded))return {id,key,state:'unchecked',reason:'安装位置包含未定义的环境变量'};
      const configured=path.resolve(root,expanded);
      const checks=await Promise.all((required||['']).map(async entry=>{
        try{const info=await inspect(entry?path.join(configured,entry):configured);return {entry:entry||path.basename(configured),state:info.isFile()?'found':'missing',size:info.size};}
        catch(error){return {entry:entry||path.basename(configured),state:['ENOENT','ENOTDIR'].includes(error.code)?'missing':'unchecked'};}
      }));
      const state=checks.some(item=>item.state==='missing')?'missing':checks.some(item=>item.state==='unchecked')?'unchecked':'found';
      const result={id,key,state,path:configured,checks:checks.map(({entry,state})=>({entry,state})),...(state==='missing'?{reason:'部分安装入口未找到'}:state==='unchecked'?{reason:'无法读取部分安装入口'}:{})};
      // Read only the small, fixed version file. Presence is not build/runtime acceptance.
      if(id==='runtime'&&checks[0].state==='found'&&Number.isInteger(checks[0].size)&&checks[0].size>0&&checks[0].size<=256){
        try{const version=String(await read(path.join(configured,'VERSION'),'utf8')).trim();if(/^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]{1,40})?$/.test(version))result.version=version;}
        catch{/* Version text is optional; file probe remains the only installation claim. */}
      }
      return result;
    }));
    return {schemaVersion:1,checkedAt:new Date().toISOString(),configPath,tools:entries};
  }
  return {async handle(method,rawUrl){
    const url=new URL(rawUrl,'http://127.0.0.1');
    if(method!=='GET'||url.pathname!=='/api/plcdev/tool-environment'||url.search)return {status:400,body:{ok:false,error:'工具检测只接受无参数的读取请求。'}};
    return {status:200,body:{ok:true,...await check()}};
  }};
}
