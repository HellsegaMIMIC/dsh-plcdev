// A test-only sender process. It hangs after the mock upstream received the
// request, leaving the real SQLite outbox and sender marker on disk.
import {createConversationRoutes} from '../../src/conversations.mjs';
const [controllerFile,projectId]=process.argv.slice(2);
const revision='e'.repeat(64);
const bridge={async handle(method,url){
 if(method==='POST'&&url==='/api/plcdev/tasks'){
  process.send({kind:'upstream-received'});
  return new Promise(()=>{});
 }
 return {status:200,body:{project:{id:projectId},projects:[{id:projectId}]}};
},async taskReceipt(){process.send({kind:'receipt-started'});return new Promise(()=>{});}};
const routes=createConversationRoutes({controllerFile,bridge});
process.on('message',message=>{
 if(message==='submit')routes.handle('POST','/api/plcdev/conversations/tasks',{conversationId:'chat-a',projectId,expectedVersion:1,request:'isolated request',expectedRevision:revision,executionScope:'proposal',sourceBasis:'saved_revision',clientRequestId:'fixed-request'}).then(result=>process.send({kind:'unexpected-completion',status:result.status}));
 if(message==='receipt')routes.handle('POST','/api/plcdev/conversations/receipt',{conversationId:'chat-a',clientRequestId:'fixed-request'}).then(result=>process.send({kind:'unexpected-completion',status:result.status}));
});
