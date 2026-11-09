import React from 'react';
import { App, PlcdevIcon } from './App';
import { ConversationReview, NativeToolCard } from './Conversation';
import { createConversationNavigation, reviewTarget } from './conversation-client.mjs';
import { ConversationHeader } from './ConversationHeader';
import { ProjectPane } from './ProjectPane';
import { createConversationContexts } from './conversation-context.mjs';
import { createProjectContexts } from './project-context.mjs';
import { selectionKey } from './model.mjs';

export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs'];
export const name = 'plcdev-workbench';
const PANEL_ID = 'plcdev-workbench';
const REVIEW_ID = 'plcdev-candidate-review';
const PROJECT_ID = 'plcdev-project';

export function apply(ctx:any) {
  const navigation=createConversationNavigation();
  const contexts=createConversationContexts(),projectContexts=createProjectContexts();
  const project=(sessionId:string,projectId:string)=>ctx.sidebarRight.openTabIn(sessionId,PROJECT_ID,{params:{projectId}});
  ctx.effect(()=>()=>{contexts.dispose();projectContexts.dispose();});
  const overview=()=>ctx.layout.selectPanel(PANEL_ID);
  // Presentation-only: select the retained UUID, never bind the chat or start/stop Runtime.
  const retainedProject=(projectId:string)=>{
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(projectId))return;
    try{window.localStorage.setItem(selectionKey,projectId);}catch{}
    overview();window.dispatchEvent(new CustomEvent('plcdev:select-project',{detail:{projectId}}));
  };
  const review=(sessionId:string,value:any)=>{const target=reviewTarget(value);if(target)ctx.sidebarRight.openTabIn(sessionId,REVIEW_ID,{params:target});};
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID,inject:()=>({})},()=> <App/>));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:10,label:()=> 'PLCdev'},PlcdevIcon));
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:REVIEW_ID,kind:REVIEW_ID,title:()=> '更改',keepMounted:false}));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'plcdev-overview',order:40,inject:()=>({contexts,navigation,onProject:project,onReview:review})},(props:any)=><ConversationHeader key={props.sessionId} {...props}/>));
  ctx.slots.inject('conversation.hero.options',()=>ctx.slots.register({name:'conversation.hero.options',id:'plcdev-new-project',order:40,inject:()=>({contexts,navigation,onProject:project,onReview:review})},(props:any)=><ConversationHeader key={props.sessionId} {...props}/>));
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:PROJECT_ID,kind:PROJECT_ID,title:()=> '工程与运行',keepMounted:false}));
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:PROJECT_ID,inject:()=>({contexts,projectContexts,onProject:project,onOverview:overview,onRetainedProject:retainedProject})},ProjectPane));
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:REVIEW_ID,inject:()=>({onOverview:overview,onRetainedProject:retainedProject,onProject:project,contexts})},ConversationReview));
  // Tool view owner props contain the call, not its navigation context. Bind the action
  // to the session-scoped injection, as DSH's own ask_user_question toolview does.
  for(const tool of ['plcdev_project_context','plcdev_propose_joint','plcdev_task_status','plcdev_team_context','plcdev_team_plan','plcdev_team_generate_plan','plcdev_team_assemble','plcdev_team_status','plcdev_team_control','plcdev_plc_analyze','plcdev_hmi_analyze','plcdev_oip_analyze','plcdev_plc_generate','plcdev_hmi_generate','plcdev_oip_generate','plcdev_team_report','plcdev_team_reconcile'])ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:tool,inject:(sessionId:string)=>({onReviewTask:(target:any)=>review(sessionId,target)})},NativeToolCard));
  ctx.effect(()=>{
    // UI intents only. Selecting a global panel never changes a conversation binding.
    const enter=(event:Event)=>{const detail=(event as CustomEvent).detail;if(typeof detail?.projectId!=='string')return;const sessionId=detail.sessionId||contexts.activeSession();if(!sessionId)return;navigation.request({...detail,sessionId});ctx.layout.selectPanel(null);};
    window.addEventListener('plcdev:open-conversation',enter);
    window.addEventListener('plcdev:review-task',enter);
    return ()=>{window.removeEventListener('plcdev:open-conversation',enter);window.removeEventListener('plcdev:review-task',enter);};
  });
}
