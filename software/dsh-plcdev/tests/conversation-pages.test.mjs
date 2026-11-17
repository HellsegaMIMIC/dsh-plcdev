import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationStore,createConversationPages,RECORDS_VIEW} from '../src/client/conversation-pages.mjs';

test('record and return navigation share the host conversation store and scoped identity',()=>{
  const handle={create(){throw Error('must reuse the host handle');}},calls=[];
  assert.equal(conversationStore({entries:key=>key==='conversation.session'?[{options:{name:key},store:handle}]:[]}),handle);
  assert.throws(()=>conversationStore({entries:()=>[{options:{store:handle}}]}),/尚未就绪/);
  let binding={key:'chat-a'};
  const pages=createConversationPages({sessions:()=>({binding:()=>binding}),uiConversation:()=>({binding:value=>{assert.equal(value,binding);return {activate:view=>calls.push(['activate',view])};}})});
  const focus={projectId:'user-a',taskId:'task-a'};
  pages.bind('chat-a',{openView:(...args)=>calls.push(['open',...args])});
  assert.equal(pages.open('chat-a',RECORDS_VIEW,focus),true);
  assert.equal(pages.open('chat-a','chat'),true);
  assert.deepEqual(calls,[['activate',RECORDS_VIEW],['open',RECORDS_VIEW,focus],['activate','chat'],['open','chat',undefined]]);
  binding={key:'chat-a'};
  assert.equal(pages.open('chat-a',RECORDS_VIEW),false,'replaced session bindings cannot use old actions');
  assert.equal(pages.open('chat-a','arbitrary-view'),false);
  assert.equal(calls.length,4);
});

test('unavailable host or disposed plugin leaves navigation untouched',()=>{
  const binding={},actions={openView(){throw Error('must not select stale host');}};
  let ui=null;
  const pages=createConversationPages({sessions:()=>({binding:()=>binding}),uiConversation:()=>ui});
  pages.bind('chat',actions);assert.equal(pages.open('chat',RECORDS_VIEW),false);
  ui={};pages.dispose();assert.equal(pages.open('chat',RECORDS_VIEW),false);
});
