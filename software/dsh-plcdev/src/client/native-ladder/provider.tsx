// Read-only port adapter. It never imports editor stores, IPC, or disk services.
import {createContext,useContext,useMemo} from 'react';
import {computeGraphicalDiff} from '../../../../openplc-editor-zh/src/backend/shared/utils/graphical-diff';
export const PreviewOptions=createContext<{rung?:number}>({});
export function useVersionControl(){
  const {rung}=useContext(PreviewOptions);
  return useMemo(()=>({computeGraphicalDiff(before:string,after:string,path:string){
    const result=computeGraphicalDiff(before,after,path);
    if(rung!==undefined)result.changedIndexes=result.changedIndexes.filter(index=>index===rung);
    return result;
  }}),[rung]);
}

