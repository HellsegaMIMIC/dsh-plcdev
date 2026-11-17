import React from 'react';
import {brandCss,brandMark,brandName} from './brand-contract.mjs';

export {brandName};
export const recordsLabel = brandName + ' 调整记录';

export function BrandMark({entry=false}: {entry?:boolean}) {
  return <span aria-hidden="true" className={'plcdev-mark'+(entry?' plcdev-scope plcdev-entry-mark':'')}>{brandMark}</span>;
}

export function BrandTitle({children,compact=false}: {children?:React.ReactNode,compact?:boolean}) {
  return <span className={'plcdev-title plcdev-dsh-title'+(compact?' plcdev-title-compact':'')}><span className="plcdev-identity" {...(compact?{role:'img','aria-label':brandName,title:brandName}:{})}><BrandMark/>{!compact&&brandName}</span>{children&&<span>{children}</span>}</span>;
}

// The host owns its tab button and accepts a string label. Mark only its
// existing PLCdev button in this view's local tablist while the view is mounted.
export function markRecordsTab(view:Element|null) {
  for(let group=view?.closest('[data-slot="conversation.view"]')?.parentElement;group;group=group.parentElement){
    const lists=group.querySelectorAll('[data-conversation-tabs]');
    if(lists.length===0)continue;
    if(lists.length!==1)return;
    const tab=Array.from(lists[0].querySelectorAll('[role="tab"]')).find(tab=>tab.textContent?.trim()===recordsLabel);
    tab?.classList.add('plcdev-scope');
    tab?.setAttribute('data-plcdev-records-tab','');
    return ()=>{tab?.classList.remove('plcdev-scope');tab?.removeAttribute('data-plcdev-records-tab');};
  }
}

export function installBrandStyles() {
  if(typeof document==='undefined')return;
  const style=document.createElement('style');
  style.dataset.plcdevBrand='dsh';
  style.textContent=brandCss+`
/* DSH titles align the brand icon and text as one row, independently of native tools. */
.plcdev-title.plcdev-dsh-title { align-items: center; }
.plcdev-title.plcdev-dsh-title > span:last-child { min-inline-size: 0; }
.plcdev-scope button.plcdev-link:not(:disabled):not([aria-disabled=true]),
.plcdev-scope button.plcdev-tab[aria-current=page],
.plcdev-scope button.plcdev-tab[aria-expanded=true],
.plcdev-scope .pc-observation-tabs button[aria-pressed=true],
.plcdev-scope .pc-project-current.plcdev-selected,
.pc-records.plcdev-scope button.plcdev-tab[aria-expanded=true],
:is(.pc-tool-card,.pc-review).plcdev-scope .pc-operation-toggle[aria-expanded=true] {
  text-decoration: none;
}
.pd-root .pd-resource-actions button.plcdev-link[aria-expanded=true] {
  background: transparent;
}
button[aria-label="${brandName}"]:has(.plcdev-entry-mark) { color: var(--plcdev-accent); }
button[aria-label="${brandName}"][aria-current=page]:has(.plcdev-entry-mark) {
  background-color: var(--plcdev-tint);
  text-decoration: none;
}
button[aria-label="${brandName}"]:has(.plcdev-entry-mark):focus-visible {
  outline: 2px solid var(--plcdev-accent);
  outline-offset: -2px;
}
[data-conversation-tabs] [data-plcdev-records-tab][aria-selected=true] {
  background-color: transparent;
  color: var(--plcdev-accent);
  text-decoration: none;
}
[data-conversation-tabs] [data-plcdev-records-tab]:focus-visible {
  outline: 2px solid var(--plcdev-accent);
  outline-offset: -2px;
}
.pc-records.plcdev-scope button.plcdev-tab[aria-expanded=true] {
  background-color: var(--plcdev-tint);
  color: var(--plcdev-accent);
}
.pc-result-popover.plcdev-scope [role=alert], .pc-records.plcdev-scope .pc-records-error {
  color: var(--dsw-alias-state-error-primary, light-dark(#a6383e, #ffb1b5));
}
.pc-project.plcdev-scope .pc-project-name { overflow-wrap: anywhere; }
:is(.pc-tool-card,.pc-review) .pc-operation-toggle[aria-expanded=true] {
  background: var(--plcdev-tint);
  color: var(--plcdev-accent);
}
.pd-workspace.plcdev-scope .pd-workspace-aside.plcdev-rail {
  border-inline-start: var(--plcdev-rail-size) solid var(--plcdev-accent);
}
`;
  document.head.append(style);
  return ()=>style.remove();
}

