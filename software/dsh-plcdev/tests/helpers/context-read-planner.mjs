// Scripted model helper: hydrate references by requesting REAL native tool
// calls in the host loop. Never inspect backend data or bypass tool authority.
export class ContextReadPlanner {
 constructor(){this.value=null;this.pending=null;}
 accept(result){
  if(!this.value)this.value=result;
  else if(this.pending){
   const p=this.pending;
   if(Object.hasOwn(result,'value'))p.value=result.value;
   else if(Object.hasOwn(result,'text'))p.value=(p.value??'')+result.text;
   else{
    p.value??=result.type==='array'?[]:{};
    for(const entry of result.entries){
     if(typeof entry.key!=='string')throw Error('Fixture requires ordinary catalog keys');
     Object.defineProperty(p.value,entry.key,{value:entry._plcdevRead?{_plcdevRead:entry._plcdevRead,...(entry.index?{index:entry.index}:{})}:entry.value,enumerable:true,writable:true,configurable:true});
    }
   }
   if(result.nextOffset!=null){p.offset=result.nextOffset;return this.call();}
   p.parent[p.key]=p.value;this.pending=null;
  }
  const find=(value,parent,key)=>{
   if(!value||typeof value!=='object')return null;
   if(value._plcdevRead)return {parent,key,path:value._plcdevRead.path,offset:0};
   for(const [k,v] of Object.entries(value)){const found=find(v,value,k);if(found)return found;}
   return null;
  };
  this.pending=find(this.value,null,null);return this.pending?this.call():null;
 }
 call(){return {name:'plcdev_project_read',args:{contextToken:this.value.contextToken,path:this.pending.path,offset:this.pending.offset}};}
}
