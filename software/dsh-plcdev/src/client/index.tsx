import {BrandMark,brandName,installBrandStyles,recordsLabel} from './Brand';
import React from 'react';
import { App } from './App';
import { ConversationReview, NativeToolCard, TurnResultCards } from './Conversation';
import { createConversationNavigation, reviewTarget } from './conversation-client.mjs';
import { ConversationHeader } from './ConversationHeader';
import { SessionParticipation } from './SessionParticipation';
import { ProjectPane } from './ProjectPane';
import { createConversationContexts } from './conversation-context.mjs';
import { createProjectContexts } from './project-context.mjs';
import { selectionKey } from './model.mjs';
import { conversationApi } from './conversation-client.mjs';
import { createVerifiedSessionNavigator } from './session-navigation.mjs';
import { createProjectSessionActions,createConversationViews } from './conversation-flow.mjs';
import { createRuntimeActivity } from './runtime-activity.mjs';
import { workspaceLocation } from './workspace-navigation.mjs';
import { ConversationRecords } from './ConversationRecords';
import { conversationStore,createConversationPages,RECORDS_VIEW } from './conversation-pages.mjs';
import { createParticipationRecords } from './participation-records.mjs';

export const inject = ['slots', 'locale', 'layout', 'sidebarRight', 'sidebarRightTabs'];
export const name = 'plcdev-workbench';
const PANEL_ID = 'plcdev-workbench';
const REVIEW_ID = 'plcdev-candidate-review';
const PROJECT_ID = 'plcdev-project';

export function apply(ctx:any) {
  ctx.effect(installBrandStyles);
  let turnResultsAvailable=false;
  const navigation=createConversationNavigation();
  const sessionListeners=new Set<()=>void>();let sessionService:any=null;
  const hostSessions={get:()=>sessionService,subscribe:(fn:()=>void)=>{sessionListeners.add(fn);return()=>sessionListeners.delete(fn);}};
  if(typeof ctx.inject==='function')ctx.inject(['sessions'],(host:any)=>{sessionService=host.sessions;sessionListeners.forEach(fn=>fn());host.effect(()=>()=>{sessionService=null;sessionListeners.forEach(fn=>fn());});});
  let workspaceService:any=null,workspaceRegistry:any=null,conversationService:any=null,uiConversationService:any=null;
  const pages=createConversationPages({sessions:()=>sessionService,uiConversation:()=>uiConversationService});
  if(typeof ctx.inject==='function')ctx.inject(['uiConversation'],(host:any)=>{uiConversationService=host.uiConversation;host.effect(()=>()=>{uiConversationService=null;});});
  if(typeof ctx.inject==='function')ctx.inject(['uiWorkspace'],(host:any)=>{workspaceService=host.uiWorkspace;host.effect(()=>()=>{workspaceService=null;});});
  if(typeof ctx.inject==='function')ctx.inject(['workspaces'],(host:any)=>{workspaceRegistry=host.workspaces;host.effect(()=>()=>{workspaceRegistry=null;});});
  if(typeof ctx.inject==='function')ctx.inject(['conversation'],(host:any)=>{conversationService=host.conversation;host.effect(()=>()=>{conversationService=null;});});
  const services=()=>({sessions:sessionService,workspace:workspaceService,workspaces:workspaceRegistry,conversation:conversationService});
  const openSession=createVerifiedSessionNavigator({services,navigation,api:conversationApi});
  const contexts=createConversationContexts(),projectContexts=createProjectContexts();
  const runtimeActivity=createRuntimeActivity(),conversationViews=createConversationViews();
  const project=(sessionId:string,projectId:string,reference?:any)=>ctx.sidebarRight.openTabIn(sessionId,PROJECT_ID,{params:{projectId,...(reference?{reference}:{})}});
  ctx.effect(()=>()=>{contexts.dispose();projectContexts.dispose();runtimeActivity.dispose();conversationViews.dispose();pages.dispose();});
  let picker:any=null,workspaceIntent:any=null,workspaceOrigin:any=null;
  const getWorkspaceIntent=()=>workspaceIntent;
  const clearWorkspaceIntent=(intent:any)=>{if(workspaceIntent===intent)workspaceIntent=null;};
  const getPicker=()=>picker;
  const closePicker=()=>{picker=null;window.dispatchEvent(new Event('plcdev:picker-changed'));ctx.layout.selectPanel(null);};
  const openPicker=(sessionId:string)=>{picker={sessionId};ctx.layout.selectPanel(PANEL_ID);window.dispatchEvent(new Event('plcdev:picker-changed'));};
  const overview=()=>{picker=null;window.dispatchEvent(new Event('plcdev:picker-changed'));ctx.layout.selectPanel(PANEL_ID);};
  // Presentation-only: select the retained UUID, never bind the chat or start/stop Runtime.
  const openWorkspace=(projectId:string,view='resources',sessionId?:string,location?:any)=>{
    if(!/^[a-z][a-z0-9-]{0,63}$/.test(projectId))return;
    try{window.localStorage.setItem(selectionKey,projectId);}catch{}
    workspaceIntent={projectId,view,...(location?{...location,restore:true}:{}),...(sessionId?{returnTo:{sessionId,projectId:contexts.get(sessionId).snapshot().binding?.projectId}}:{})};
    overview();window.dispatchEvent(new CustomEvent('plcdev:select-project',{detail:workspaceIntent}));
  };
  const retainedProject=(projectId:string,sessionId?:string)=>openWorkspace(projectId,'resources',sessionId);
  const onOpenRuntime=(projectId:string,sessionId?:string)=>openWorkspace(projectId,'runtime',sessionId);
  const onReturnWorkspace=(sessionId:string)=>{const origin=conversationViews.snapshot().origins[sessionId];if(origin)openWorkspace(origin.projectId,origin.view,sessionId,origin);};
  const onOverview=(sessionId?:string,projectId?:string)=>projectId?openWorkspace(projectId,'resources',sessionId):overview();
  const sessionActions=createProjectSessionActions({services,api:conversationApi,openSession,navigation,onPrepared:({projectId,sessionId,reference,label,origin}:any)=>{
    if(origin?.projectId===projectId)conversationViews.rememberOrigin(sessionId,origin);
    if(reference)conversationViews.rememberReference(sessionId,reference,label);
    contexts.get(sessionId).refresh();
  }});
  const recordSessionOutcome=(result:any)=>{if(result.sessionId)conversationViews.rememberNotice(result.sessionId,result.ok?'':result.message||'会话操作结果未确认，请返回工程核对。');return result;};
  const onCreateSession=async(projectId:string)=>recordSessionOutcome(await sessionActions.create(projectId,workspaceOrigin));
  const onCarryReference=async(projectId:string,reference:any,sessionId?:string)=>recordSessionOutcome(await sessionActions.carry(projectId,reference,sessionId,workspaceOrigin));
  const onContinueRetained=async(value:any)=>recordSessionOutcome(await sessionActions.createFromRetained(value,{projectId:value.keptProjectId,view:'resources',selected:null,review:null,scroll:0}));
  const onOpenEditorSession=async(value:any)=>{ctx.layout.selectPanel(null);return recordSessionOutcome(await openSession({projectId:value.targetProjectId,sessionId:value.sessionId}));};
  const onContinueCurrent=async({sessionId}:any)=>{ctx.layout.selectPanel(null);if(!pages.open(sessionId,'chat'))throw new Error('请从顶部“对话”页签继续修改。');};
  const onOpenResultResource=async(request:any)=>{
    const value=await conversationApi('conversations/result-resource-open',request,65000);
    if(value?.ok!==true||['projectId','taskId','candidateDigest','tool','target'].some(key=>value[key]!==request[key]))throw new Error('工具打开结果的归属尚未确认。');
    return value;
  };
  const onReturnToSession=sessionActions.returnToSession;
  const review=(sessionId:string,value:any)=>{const target=reviewTarget(value);if(target&&!pages.open(sessionId,RECORDS_VIEW,target))ctx.sidebarRight.openTabIn(sessionId,REVIEW_ID,{params:target});};
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:PANEL_ID,inject:()=>({})},()=> <App {...{contexts,projectContexts,hostSessions,openSession,getPicker,closePicker,onCreateSession,onCarryReference,onReturnToSession,onContinueRetained,onOpenEditorSession,onOpenResultResource,runtimeActivity,onOpenRuntime,getWorkspaceIntent,clearWorkspaceIntent}}/>));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:PANEL_ID,order:10,label:()=>brandName},()=> <BrandMark entry/>));
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:REVIEW_ID,kind:REVIEW_ID,title:()=>brandName+' 更改',keepMounted:false}));
  const headerProps=(sessionId:string,actions:any)=>{pages.bind(sessionId,actions);return {contexts,navigation,onProject:project,onReview:review,onPicker:openPicker,runtimeActivity,onOpenRuntime,conversationViews,onReturnWorkspace};};
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({name:'conversation.session.header.utilities',id:'plcdev-overview',order:40,store:()=>conversationStore(ctx.slots),inject:headerProps},(props:any)=><ConversationHeader key={props.sessionId} {...props}/>));
  ctx.slots.inject('conversation.hero.options',()=>ctx.slots.register({name:'conversation.hero.options',id:'plcdev-new-project',order:40,store:()=>conversationStore(ctx.slots),inject:headerProps},(props:any)=><SessionParticipation key={props.sessionId} {...props}/>));
  ctx.effect(()=>{
    const records=createParticipationRecords({sessions:hostSessions,contexts,register:()=>ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:RECORDS_VIEW,order:-5,label:()=>recordsLabel,store:()=>conversationStore(ctx.slots),inject:(sessionId:string,actions:any)=>{pages.bind(sessionId,actions);return {contexts,onContinueRetained,onOpenEditorSession,onOpenResultResource};}},ConversationRecords))});
    return()=>records.dispose();
  });
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:PROJECT_ID,kind:PROJECT_ID,title:()=>brandName+' 工程引用',keepMounted:false}));
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:PROJECT_ID,inject:()=>({contexts,projectContexts,onProject:project,onOverview,onRetainedProject:retainedProject,runtimeActivity,onOpenRuntime,onOpenResultResource})},ProjectPane));
  ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:REVIEW_ID,inject:()=>({onOverview,onRetainedProject:retainedProject,onContinueRetained,onOpenEditorSession,onOpenResultResource,onProject:project,contexts})},ConversationReview));
  // Tool view owner props contain the call, not its navigation context. Bind the action
  // to the session-scoped injection, as DSH's own ask_user_question toolview does.
  for(const tool of ['plcdev_project_context','plcdev_propose_joint','plcdev_task_status','plcdev_propose_hmi_view_name','plcdev_propose_hmi_static_text','plcdev_propose_hmi_readonly_value','plcdev_propose_project_edit','plcdev_validate_candidate','plcdev_team_context','plcdev_team_plan','plcdev_team_generate_plan','plcdev_team_assemble','plcdev_team_status','plcdev_team_control','plcdev_plc_analyze','plcdev_hmi_analyze','plcdev_oip_analyze','plcdev_plc_generate','plcdev_hmi_generate','plcdev_oip_generate','plcdev_team_report','plcdev_team_reconcile'])ctx.slots.inject('tool.call.toolview',()=>ctx.slots.register({name:'tool.call.toolview',key:tool,inject:(sessionId:string)=>({resultInTurn:turnResultsAvailable,onReviewTask:(target:any)=>review(sessionId,target)})},NativeToolCard));
  // The turn tail remains visible when DSH folds tool execution. Read only this
  // turn's tool-call projection, so a later task never replaces an old card.
  if(typeof ctx.inject==='function')ctx.inject(['uiConversation','sessions'],(host:any)=>{
    host.slots.inject('conversation.chat.turnTail',()=>{const dispose=host.slots.register({
      name:'conversation.chat.turnTail',id:'plcdev-results',order:30,store:()=>conversationStore(host.slots),
      inject:(sessionId:string,actions:any)=>{
        pages.bind(sessionId,actions);
        const binding=host.sessions.binding(sessionId);
        if(!binding)throw new Error('PLCdev 无法核对当前会话。');
        const chat=host.uiConversation.binding(binding).target('chat');
        return {sessionId,contexts,onReviewTask:(target:any)=>review(sessionId,target),onContinueRetained,onContinueCurrent,onOpenEditorSession,onOpenResultResource,
          keyedHooks:{plcdevTurnTools:(turn:string)=>{
            const snapshot=chat.getSnapshot();
            if(!snapshot)throw new Error('PLCdev 暂时无法读取此轮对话。');
            return snapshot.nodes.turnDataSource(Number(turn),'tool-call');
          }}};
      },
    },TurnResultCards);turnResultsAvailable=true;return()=>{turnResultsAvailable=false;dispose();};});
  });
  ctx.effect(()=>{
    const consumerId=crypto.randomUUID();let stopped=false,timer:any;
    const poll=async()=>{
      let renew:any;
      try{
        if(document.visibilityState==='hidden'||!sessionService||!workspaceService)return;
        const endpoint='conversations/editor-navigation?consumerId='+encodeURIComponent(consumerId);
        const value=await conversationApi(endpoint,undefined,10000),intent=value?.navigation;
        if(stopped||value?.ok!==true||!intent)return;
        if(typeof intent.navigationId!=='string'||typeof intent.sessionId!=='string'||typeof intent.projectId!=='string')return;
        renew=setInterval(()=>{void conversationApi(endpoint,undefined,5000).catch(()=>{});},3000);
        ctx.layout.selectPanel(null);
        const result=await openSession({projectId:intent.projectId,sessionId:intent.sessionId,...(intent.taskId?{taskId:intent.taskId}:{})});
        if(stopped)return;
        if(result.ok)await conversationApi('conversations/editor-navigation',{navigationId:intent.navigationId,consumerId},10000);
        else conversationViews.rememberNotice(intent.sessionId,result.message||'编辑器请求的会话位置尚未确认。');
      }catch{}
      finally{clearInterval(renew);if(!stopped)timer=setTimeout(poll,2000);}
    };
    timer=setTimeout(poll,1000);
    return()=>{stopped=true;clearTimeout(timer);};
  });
  ctx.effect(()=>{
    // UI intents only. Selecting a global panel never changes a conversation binding.
    const enter=(event:Event)=>{const detail=(event as CustomEvent).detail;if(typeof detail?.projectId!=='string')return;const sessionId=detail.sessionId||(event.type==='plcdev:open-conversation'?contexts.activeSession():null);if(!sessionId)return;navigation.request({...detail,sessionId});ctx.layout.selectPanel(null);};
    window.addEventListener('plcdev:open-conversation',enter);
    window.addEventListener('plcdev:review-task',enter);
    const rememberOrigin=(event:Event)=>{const detail=(event as CustomEvent).detail,origin=workspaceLocation(detail);if(!origin)return;workspaceOrigin=origin;if(detail.sessionId)conversationViews.rememberOrigin(detail.sessionId,origin);};
    window.addEventListener('plcdev:workspace-origin',rememberOrigin);
    return ()=>{window.removeEventListener('plcdev:open-conversation',enter);window.removeEventListener('plcdev:review-task',enter);window.removeEventListener('plcdev:workspace-origin',rememberOrigin);};
  });
}
