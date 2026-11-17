// GPL-3.0: directly reuse OpenPLC's graph and semantic diff; no editable tool layer.
import React from 'react';
import {GraphicalDiffViewer} from '../../../../openplc-editor-zh/src/frontend/components/_features/[workspace]/editor/diff-viewer/graphical-diff-viewer';
import {computeGraphicalDiff} from '../../../../openplc-editor-zh/src/backend/shared/utils/graphical-diff';
import {PreviewOptions} from './provider';
export {computeGraphicalDiff};
export function NativeLadderView({before,after,path,beforeLabel='修改前',afterLabel='修改后',isDark=false,rung}:any){
  return <PreviewOptions.Provider value={{rung}}><GraphicalDiffViewer originalContent={before} currentContent={after} filePath={path} originalLabel={beforeLabel} currentLabel={afterLabel} isDark={isDark}/></PreviewOptions.Provider>;
}

