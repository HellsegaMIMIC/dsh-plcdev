import test from 'node:test';import assert from 'node:assert/strict';
import {parseHmiIntent,matchesHmiIntent} from '../src/hmi-intent.mjs';
const target={viewId:'v_a',elementId:'PLCD_tOpTitle',text:'操作区',ambiguousText:false},plan={viewId:'v_a',elementId:'PLCD_tOpTitle',text:'设备操作区'};
test('single intent matches entire old and new values and rejects duplicate targets',()=>{
 assert.equal(parseHmiIntent('hmi-static-text-v1','把文字“操作区”改为“设备操作区”'),null);
 assert.equal(parseHmiIntent('hmi-static-text-v1','把画面 ID“v_a”的文字“操作区”改为“设备操作区”'),null);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把静态文字“操作区”改为“设备操作区”',plan,[target]),true);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把文字 ID“PLCD_tOpTitle”改为“设备操作区”',plan,[target]),true);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把画面 ID“v_a”的文字 ID“PLCD_tOpTitle”改为“设备操作区”',plan,[target,{...target,viewId:'v_b'}]),true);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把静态文字“操作区”改为“设备操作区”',{...plan,text:'设备'},[target]),false);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把静态文字“其他”改为“设备操作区”',plan,[target]),false);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把静态文字“操作区”改为“设备操作区”',plan,[target,{...target,viewId:'v_b'}]),false);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把文字 ID“PLCD_tOpTitle”改为“设备操作区”',plan,[target,{...target,viewId:'v_b'}]),false);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把静态文字“操作区”改为“设备操作区”',plan,[{...target,ambiguousText:true}]),false);
 assert.equal(matchesHmiIntent('hmi-static-text-v1','把文字 ID“PLCD_tOpTitle”改为“设备操作区”',plan,[{...target,ambiguousText:true}]),true);
});
test('negation, conditions, multiple actions, mismatched quotes and additional prose fail closed',()=>{
 for(const value of ['不要把静态文字“操作区”改为“设备操作区”','如果需要把静态文字“操作区”改为“设备操作区”','把静态文字“操作区”改为“设备操作区”，画面名不要改变','把静态文字“其他”和“操作区”改为“设备操作区”','把静态文字“操作区”改为“设备操作区以外”然后再改一次','把静态文字“操作区”改为“设备操作区','把静态文字“操作区”改为“设备操作区”并把静态文字“a”改为“b”','把静态文字“操作区”改为"设备操作区”'])assert.equal(parseHmiIntent('hmi-static-text-v1',value),null,value);
});
test('view name requires unique saved view and complete requested name',()=>{
 const rows=[{id:'v_a',name:'主画面',ambiguousName:false}],p={viewId:'v_a',name:'控制画面'};
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称“主画面”改为“控制画面”',p,rows),true);
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称 ID“v_a”改为“控制画面”',p,rows),true);
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称“主画面”改为“控制画面”',p,[...rows,{id:'v_b',name:'主画面'}]),false);
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称“主画面”改为“控制画面”',{...p,name:'控制'},rows),false);
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称“主画面”改为“控制画面”',p,[{...rows[0],ambiguousName:true}]),false);
 assert.equal(matchesHmiIntent('hmi-view-name-v1','把画面名称 ID“v_a”改为“控制画面”',p,[{...rows[0],ambiguousName:true}]),true);
});
