import {conversationParticipation,validConversationId} from './conversation-client.mjs';

// DSH 0.2.2 builds its view roster globally within each Client. Its public
// mainView retain counts identify that Client's selected conversation; a
// background tool/editor retain must never add an engineering tab to chat.
export function createParticipationRecords({sessions,contexts,register}) {
  let disposed=false,service=null,currentId=null,controller=null;
  let stopList=()=>{},stopContext=()=>{},stopHost=()=>{},removeEntry=null;
  let contextEpoch=0;

  function visible(show) {
    if(show&&!removeEntry) {
      removeEntry=()=>{}; // Guard synchronous registry/list notifications.
      try { removeEntry=register(); }
      catch(error) { removeEntry=null;throw error; }
    } else if(!show&&removeEntry) {
      const remove=removeEntry;removeEntry=null;remove();
    }
  }
  function render() {
    if(disposed||!currentId||!controller)return visible(false);
    const state=controller.snapshot(),binding=state.binding;
    // A successful ordinary binding always wins over a previously enabled
    // one. Read failures retain navigation only, never execution permission.
    const known=binding??((state.bindingReadError||state.error)?state.lastBinding:null);
    visible(known?.conversationId===currentId&&conversationParticipation(known).enabled);
  }
  function select(id) {
    if(currentId===id)return render();
    stopContext();stopContext=()=>{};controller=null;currentId=id;
    const epoch=++contextEpoch;
    if(!id)return visible(false);
    controller=contexts.get(id);
    const owned=controller;
    stopContext=owned.subscribe(()=>{if(!disposed&&epoch===contextEpoch&&controller===owned)render();});
    render();
  }
  function reconcile() {
    if(disposed)return;
    const rows=Object.values(service?.list?.getSnapshot()?.byId||{});
    const mains=rows.filter(row=>validConversationId(row?.id)&&(row.retainedBy?.mainView??0)>0);
    // Keep the known owner through retain-before-release navigation. Without
    // an owner, an ambiguous transition must not select a random conversation.
    const id=mains.some(row=>row.id===currentId)?currentId:mains.length===1?mains[0].id:null;
    select(id);
  }
  function bindService() {
    if(disposed)return;
    const next=sessions.get();
    if(next===service)return reconcile();
    stopList();stopList=()=>{};select(null);service=next;
    if(service?.list?.subscribe)stopList=service.list.subscribe(reconcile);
    reconcile();
  }
  stopHost=sessions.subscribe(bindService);
  bindService();
  return {
    current:()=>currentId,
    dispose() {
      if(disposed)return;
      disposed=true;contextEpoch++;stopHost();stopList();stopContext();
      currentId=null;controller=null;service=null;visible(false);
    },
  };
}
