import React from 'react';
import {BrandMark} from './Brand';
import {ConversationHeader} from './ConversationHeader';
import {useConversationContext} from './useConversationContext';
import {conversationParticipation} from './conversation-client.mjs';

const css=`
.pc-participation{display:inline-flex;align-items:center;gap:0;max-width:300px;min-width:0;border:1px solid var(--dsw-alias-border-l2,#e2e6ed);border-radius:9px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#667085);font:500 13px/1.4 var(--dsw-font-family,system-ui,sans-serif)}
.pc-participation[data-enabled=true]{color:var(--plcdev-accent);border-color:color-mix(in srgb,var(--plcdev-accent) 30%,var(--dsw-alias-border-l2,#e2e6ed));background:var(--plcdev-tint)}
.pc-participation button{display:inline-flex;align-items:center;gap:7px;min-height:34px;min-width:0;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;padding:6px 9px;cursor:pointer}.pc-participation button:disabled{cursor:default;opacity:.5}.pc-participation button:focus-visible{outline:2px solid var(--plcdev-accent);outline-offset:3px}.pc-participation button:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,#f5f6f8)}
.pc-participation-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pc-participation .pc-participation-toggle{flex:none;padding-left:2px}.pc-participation-track{display:inline-flex;align-items:center;box-sizing:border-box;width:27px;height:16px;border-radius:12px;padding:2px;background:var(--dsw-alias-border-l2,#c9ced8)}.pc-participation-track:before{content:'';width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0002}.pc-participation [aria-checked=true] .pc-participation-track{background:var(--plcdev-accent)}.pc-participation [aria-checked=true] .pc-participation-track:before{transform:translateX(11px)}
@media(max-width:480px){.pc-participation{max-width:220px}}
`;

/** Start-of-conversation choice. A project is selected before enabling tools;
 * opening or canceling the picker does not itself change participation. */
export function SessionParticipation(props:any){
  const {sessionId,contexts,onPicker}=props,state=useConversationContext(contexts,sessionId);
  const mode=conversationParticipation(state.binding||state.lastBinding);
  if(mode.locked)return <ConversationHeader {...props}/>;
  const known=!!state.binding,blocked=!known||state.busy||!!state.storageError||!!state.error;
  const project=state.projects.find((p:any)=>p.id===state.binding?.projectId);
  const title=mode.enabled?'关闭 PLCdev，继续普通对话':'开启 PLCdev 并选择工程';
  return <div className="pc-participation plcdev-scope" data-enabled={mode.enabled}>
    <style>{css}</style>
    <button type="button" title={state.error||(!known?'正在读取会话':mode.enabled?'切换当前工程':title)} disabled={state.busy||!known&&!state.error}
      onClick={()=>state.error?state.controller.refresh():onPicker?.(sessionId)}>
      <BrandMark/><span className="pc-participation-name">{state.error?'PLCdev · 重新读取':mode.enabled?'PLCdev · '+(project?.name||'当前工程'):'PLCdev'}</span>
    </button>
    <button type="button" className="pc-participation-toggle" role="switch" aria-label="在此会话使用 PLCdev" aria-checked={mode.enabled} disabled={blocked} title={title}
      onClick={()=>mode.enabled?void state.controller.bind(null):onPicker?.(sessionId)}><span className="pc-participation-track" aria-hidden="true"/></button>
  </div>;
}
