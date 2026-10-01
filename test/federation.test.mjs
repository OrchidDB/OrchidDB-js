import {test} from 'node:test';
import assert from 'node:assert/strict';
import {queryFederated} from '../dist/index.js';

for (const fail of [false,true]) test(`federation routes read queries and closes results (failure=${fail})`,async()=>{
 const log=[];
 const transfer={source_engine:'pg',source_dialect:'postgres',sql:'SELECT count(*) AS n FROM people WHERE age > 25',target_relation:'exchange',columns:[{name:'n',data_type:'int64',nullable:false}]};
 const plan={version:1,dialect:'duckdb',execution_engine:'dd',sql:'SELECT n FROM exchange',fields:['n'],transfers:[transfer]};
 const compiler={compile:()=>plan,bindArrow:async(p,relation,source)=>{assert.equal(relation,'exchange');log.push('bind');return {...p,transfers:[]};}};
 const engines=new Map([
  ['pg',{dialect:'postgres',execute:async q=>{log.push(q.sql);return {close:()=>log.push('source closed')}}}],
  ['dd',{dialect:'duckdb',execute:async q=>{assert.deepEqual(q.transfers,[]);return {close:()=>log.push('result closed')}}}]
 ]);
 const run=queryFederated(compiler,{},engines,async result=>{if(fail)throw Error('consumer failed');return 7});
 if(fail)await assert.rejects(run,/consumer failed/);else assert.equal(await run,7);
 assert.deepEqual(log,[transfer.sql,'bind','source closed','result closed']);
});
test('routing validation happens before opening any result',async()=>{
 const compiler={compile:()=>({version:1,dialect:'postgres',execution_engine:'p',transfers:[]})};
 await assert.rejects(queryFederated(compiler,{},new Map(),async()=>{}),/Missing engine/);
});
