import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticatedDesktopRequest} from '../src/desktop-auth.mjs';
test('desktop bridge requires live Host-authenticated owner, marker alone is never authority',()=>{
 const request={headers:{'x-plcdev-desktop':'1'}};let calls=0;
 const connection={admit(req){calls++;assert.equal(req,request);return {peer:{principal:{kind:'owner'},signal:{aborted:false}}};}};
 assert.equal(authenticatedDesktopRequest(request,connection),true);assert.equal(calls,1);
 for(const c of [undefined,{admit:()=>({rejection:401})},{admit:()=>({peer:{principal:{kind:'guest'}}})},{admit:()=>({peer:{principal:{kind:'owner'},signal:{aborted:true}}})},{admit(){throw Error('offline');}}])assert.equal(authenticatedDesktopRequest(request,c),false);
 for(const headers of [{},{'x-plcdev-desktop':'1',origin:'https://evil.example'},{'x-plcdev-desktop':'1','sec-fetch-site':'cross-site'},{'x-plcdev-desktop':'0'}])assert.equal(authenticatedDesktopRequest({headers},connection),false);
});
