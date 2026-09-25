import test from 'node:test';
import assert from 'node:assert/strict';
import { Compiler, batches } from '../dist/index.js';
import { openDatabase, arrowEngine, request } from '../examples/duckdb-wasm.mjs';

test('native compile -> caller DuckDB -> Arrow preserves values/nulls and transaction ownership', async () => {
  const db = await openDatabase(); const connection = db.connect();
  try {
    connection.query("CREATE TABLE people(id BIGINT, name VARCHAR); INSERT INTO people VALUES (9007199254740993, 'Orchid'), (2, NULL)");
    connection.query('BEGIN; INSERT INTO people VALUES (3, \'transaction\')');
    const compiler = new Compiler(); const engine = arrowEngine(connection);
    const result = await compiler.query(request, engine);
    const rows = [];
    for await (const batch of batches(result)) {
      assert.equal(batch.schema.fields[0].name, 'id');
      for (let i=0;i<batch.numRows;i++) rows.push([batch.getChild('id').get(i),batch.getChild('name').get(i)]);
    }
    assert.deepEqual(rows, [[2n,null],[3n,'transaction'],[9007199254740993n,'Orchid']]);
    connection.query('ROLLBACK');
    assert.equal(connection.query('SELECT count(*) n FROM people').getChild('n').get(0),2n);
    assert.throws(()=>compiler.compile({...request,query:'this is not a graph query'}));
    assert.throws(()=>compiler.compile({...request,dialect:'clickhouse'}));
    await assert.rejects(compiler.query(request,{...engine,dialect:'postgres'}),/dialects differ/);
  } finally {connection.close();db.reset();}
});

test('early stop releases Arrow lease and permits connection reuse', async()=>{
  const db=await openDatabase(); const connection=db.connect();
  try {
    connection.query('CREATE TABLE people AS SELECT i::BIGINT AS id, NULL::VARCHAR AS name FROM range(10000) t(i)');
    const engine=arrowEngine(connection); const compiler=new Compiler();
    const result=await compiler.query(request,engine);
    await assert.rejects(compiler.query(request,engine),/active result/);
    for await (const batch of batches(result)) {assert.ok(batch.numRows>0);break;}
    await result.close();
    const again=await compiler.query({...request,query:'MATCH (p:Person) RETURN count(p) AS n'},engine);
    for await(const batch of batches(again)) assert.equal(batch.getChild('n').get(0),10000n);
  } finally {connection.close();db.reset();}
});

test('integer parameters preserve signed int64 exactly through compiler and DuckDB Arrow', async () => {
  const db = await openDatabase(); const connection = db.connect();
  try {
    const compiler = new Compiler();
    for (const n of [9007199254740993n, -9007199254740993n, 9223372036854775807n, -9223372036854775808n]) {
      const plan = compiler.compile({...request, query: 'RETURN $n AS n', parameters: {n}});
      assert.equal(connection.query(plan.sql).getChild('n').get(0), n);
    }
    const nested = compiler.compile({...request, query: 'RETURN $values[0] AS n', parameters: {values: [9007199254740993n]}});
    assert.equal(connection.query(nested.sql).getChild('n').get(0), 9007199254740993n);
    for (const n of [9007199254740992, -9007199254740992, NaN, Infinity, -Infinity, 9223372036854775808n, -9223372036854775809n]) {
      assert.throws(() => compiler.compile({...request, query: 'RETURN $n AS n', parameters: {n}}), /Unsafe integer|finite|64-bit range/);
    }
    const text = '9007199254740993\"; DROP TABLE people; --';
    const literal = compiler.compile({...request, query: 'RETURN $n AS n', parameters: {n: text}});
    assert.equal(connection.query(literal.sql).getChild('n').get(0), text);
    for (const n of [42, 0.125, Number.MAX_SAFE_INTEGER]) {
      const plan = compiler.compile({...request, query: 'RETURN $n AS n', parameters: {n}});
      assert.equal(connection.query(`SELECT CAST(n AS DOUBLE) AS n FROM (${plan.sql})`).getChild('n').get(0), n);
    }
  } finally { connection.close(); db.reset(); }
});
