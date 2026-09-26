# OrchidDB for JavaScript and TypeScript

Compile Cypher, Gremlin text, or SPARQL to SQL. Execute on your own database and consume Apache Arrow record batches. No database is bundled; no result rows pass through the Rust compiler.

```sh
npm install @orchiddb/client@0.1.0 apache-arrow@17
```

For SQL compilation alone, install only `@orchiddb/client`. Apache Arrow is an
optional peer dependency: install it when using the Arrow interfaces (including
the TypeScript declarations). Database drivers remain application dependencies.

Version 0.1.0 is published on npm and bundles the macOS ARM64 compiler. No native library path or Rust build is required on that platform. Node 20+; this package is not a browser/Wasm compiler.

Run the example against published packages:

```sh
cd examples
npm install
npm start
```

The example supplies its own DuckDB-Wasm and Arrow dependencies and checks graph values, nulls and connection reuse.

```ts
import { Compiler, batches } from '@orchiddb/client';
const compiler = new Compiler();
const plan = compiler.compile({
  version: 1, dialect: 'duckdb', language: 'cypher',
  query: 'MATCH (p:Person) RETURN p.name',
  tables: [{ name: 'people', columns: [
    { name: 'id', data_type: 'int64' }, { name: 'name', data_type: 'string' }
  ] }],
  nodes: [{ label: 'Person', table: 'people', id: 'id', properties: {name: 'name'} }]
});
// Your engine owns the connection, schema, extensions, UDFs, transactions and caches.
const result = await yourArrowEngine.execute(plan);
for await (const batch of batches(result)) console.log(batch.numRows);
```

Implement `ExecutionEngine.execute()` to return `ArrowResult`: a schema, async batch iterator, and an idempotent `close()` releasing only result resources. Its connection stays caller-owned. Batches remain valid according to the producer's documented lifetime; copy/retain them yourself before advancing if required. `batches()` closes on completion, errors, or early exit.

See [the runnable DuckDB-Wasm example](examples/duckdb-wasm.mjs), also exercised by `npm test`. DuckDB-Wasm produces Arrow directly (IPC decoding still has costs). DuckDB's Node Neo driver is **not** silently adapted via row objects. Supply a genuine Arrow producer. Compilation is synchronous; use workers if blocking the event loop matters. Pass signed 64-bit integer parameters as JavaScript `bigint` (for example `9007199254740993n`). Unsafe integer Numbers, non-finite Numbers, and bigint values outside signed int64 are rejected before compilation, including in nested parameter values. Ordinary finite fractional Numbers remain supported. SQL currently specializes parameter values; cached plans must include parameters, schema, mappings, functions and dialect. Postgres is a SQL rendering target; federation and ClickHouse are not implemented.

## Release

Commit the native source SHA in `NATIVE_REVISION`, update the package version, and tag `vX.Y.Z`. The release workflow builds that exact native source, tests the package, uploads GitHub tarballs and can publish to npm with `NPM_TOKEN` in the `npm` environment. npm scope ownership must be configured by the organization. No credentials or placeholder binaries are included. License: [existing OrchidDB GPL-3.0-only license](LICENSE.md).
