import {useSyncExternalStore} from 'react';
export function useConversationContext(contexts:any,sessionId:string){
  const controller=contexts.get(sessionId);
  return {...useSyncExternalStore(controller.subscribe,controller.snapshot),controller};
}
