import koffi from 'koffi';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RecordBatch, Schema } from 'apache-arrow';

export type Dialect = 'duckdb' | 'postgres';
export type Language = 'cypher' | 'gremlin' | 'sparql';
export interface Column { name: string; data_type: string; nullable?: boolean }
export interface Table { name: string; columns: readonly Column[] }
export interface NodeMapping { label: string; table: string; id: string; properties?: Readonly<Record<string, string>> }
export interface EdgeMapping extends NodeMapping { source: string; target: string; source_label: string; target_label: string }
export interface FunctionSignature { name: string; target: string; parameters: readonly string[]; returns: string; aggregate?: boolean }
export interface Ontology {
  classes?: readonly { iri: string; label: string; identity?: string }[];
  properties?: readonly { iri: string; label: string; property: string }[];
  relationships?: readonly { iri: string; label: string; source_label: string; target_label: string }[];
}
export type RdfTermMapping =
  | { kind: 'iri'; column: string }
  | { kind: 'template'; prefix: string; columns: readonly string[] }
  | { kind: 'blank'; scope: string; columns: readonly string[] }
  | { kind: 'literal'; column: string; datatype?: string; language?: string; language_column?: string }
  | { kind: 'constant'; value: string; datatype?: string; language?: string };
export interface RdfMapping {
  table: string; subject: RdfTermMapping; predicate: RdfTermMapping; object: RdfTermMapping;
  graph?: RdfTermMapping; dataset?: string; key?: readonly string[]; writable?: boolean;
}
/** Shared compilation metadata and optional generated statistics. */
export interface CompileRequest {
  version: 1; dialect: Dialect; language: Language; query: string;
  parameters?: Readonly<Record<string, unknown>>;
  tables: readonly Table[]; nodes?: readonly NodeMapping[]; edges?: readonly EdgeMapping[];
  functions?: readonly FunctionSignature[]; ontology?: Ontology;
  rdf?: readonly RdfMapping[]; dataset?: string;
  logical_sources?: readonly unknown[]; collection_sources?: readonly unknown[];
  representation_sources?: readonly unknown[]; statistics?: unknown;
}
export interface CompiledQuery { version: 1; dialect: Dialect; sql: string; fields: readonly string[]; readonly [diagnostic: string]: unknown }

/** A caller-owned lease. close() releases result resources, never the parent engine. */
export interface ArrowResult extends AsyncIterable<RecordBatch> {
  readonly schema: Schema;
  close(): void | Promise<void>;
}
/** No driver dependency: implement with an Arrow-capable database/ADBC/Flight client. */
export interface ExecutionEngine {
  readonly id: string;
  readonly dialect: Dialect;
  execute(query: CompiledQuery): Promise<ArrowResult>;
  /** Enforce deadline and cancellation during acquisition and reads. */
  executeStatistics?(task: StatisticsRequest, signal: AbortSignal): Promise<ArrowResult>;
}

export interface StatisticsRequest {
  id: string; source: string; kind: string; sql: string; dialect: Dialect;
  max_rows: number; max_bytes: number; timeout_ms: number;
}
export interface StatisticsResult { snapshot: unknown; catalog_id: string; report: unknown }

export class Compiler {
  private readonly library: ReturnType<typeof koffi.load>;
  private readonly compileNative: ReturnType<ReturnType<typeof koffi.load>['func']>;
  private readonly freeNative: ReturnType<ReturnType<typeof koffi.load>['func']>;
  private readonly statisticsNative: ReturnType<ReturnType<typeof koffi.load>['func']>;
  private catalogId?: string;
  statisticsSnapshot?: unknown;
  statisticsReport?: unknown;
  readonly coreRevision: string;
  readonly version: string;
  constructor(path?: string) {
    const explicit = path ?? process.env.ORCHIDDB_NATIVE_LIBRARY;
    path = explicit ?? defaultLibrary();
    const manifest = explicit ? undefined : JSON.parse(readFileSync(join(dirname(path), 'manifest.json'), 'utf8'));
    if (manifest && createHash('sha256').update(readFileSync(path)).digest('hex') !== manifest.sha256) throw new Error('Native compiler checksum mismatch');
    this.library = koffi.load(path);
    const abi = this.library.func('uint32_t orchiddb_abi_version(void)')();
    if (abi !== 1) { this.library.unload(); throw new Error(`Unsupported OrchidDB ABI ${abi}`); }
    this.compileNative = this.library.func('void *orchiddb_compile_json(const char *request)');
    this.statisticsNative = this.library.func('void *orchiddb_statistics_json(const char *request)');
    this.freeNative = this.library.func('void orchiddb_string_free(void *value)');
    this.coreRevision = this.library.func('const char *orchiddb_core_revision(void)')();
    this.version = this.library.func('const char *orchiddb_version(void)')();
    if (manifest && (manifest.abi_version !== abi || manifest.version !== this.version || manifest.core_revision !== this.coreRevision)) {
      this.library.unload(); throw new Error('Native compiler manifest mismatch');
    }
  }
  /** Synchronous CPU work. Use a worker thread for latency-sensitive Node servers. */
  private callNative(fn: typeof this.compileNative, request: unknown): any {
    const encoded = encodeRequest(request);
    if (!encoded || encoded.includes('\u0000')) throw new Error('Request cannot contain NUL');
    const pointer = fn(encoded);
    if (!pointer) throw new Error('Native compiler returned a null response');
    let response: any;
    try { response = JSON.parse(koffi.decode(pointer, 'char', -1) as string); }
    finally { this.freeNative(pointer); }
    if (response?.ok !== true) throw new Error(response?.error ?? 'Invalid compiler response');
    return response.result;
  }
  statisticsCommand(command: unknown): any { return this.callNative(this.statisticsNative, command); }
  compile(request: CompileRequest): CompiledQuery {
    const result = this.catalogId
      ? this.statisticsCommand({ op: 'compile', catalog_id: this.catalogId, request })
      : this.callNative(this.compileNative, request);
    if (result?.version !== 1 || result?.dialect !== request.dialect || typeof result?.sql !== 'string' ||
        !Array.isArray(result?.fields) || !result.fields.every((f: unknown) => typeof f === 'string')) {
      throw new Error('Invalid compiled query response');
    }
    return Object.freeze({ ...result, fields: Object.freeze([...result.fields]) });
  }
  private retain(result: StatisticsResult): void {
    const old = this.catalogId;
    this.catalogId = result.catalog_id;
    this.statisticsSnapshot = result.snapshot;
    this.statisticsReport = result.report;
    if (old) this.statisticsCommand({ op: 'release', catalog_id: old });
  }
  clearStatistics(): void {
    if (this.catalogId) this.statisticsCommand({ op: 'release', catalog_id: this.catalogId });
    this.catalogId = undefined;
    this.statisticsSnapshot = this.statisticsReport = undefined;
  }
  saveStatistics(path: string): void {
    if (!this.catalogId) throw new Error('No statistics generated');
    writeFileSync(path, encodeRequest(this.statisticsSnapshot));
  }
  loadStatistics(path: string): void {
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    const result = this.statisticsCommand({ op: 'install', snapshot });
    this.retain({ ...result, snapshot, report: snapshot.report });
  }
  close(): void { this.clearStatistics(); }
  async generateStatistics(request: CompileRequest, engine: ExecutionEngine, signal?: AbortSignal): Promise<StatisticsResult> {
    signal?.throwIfAborted();
    const arrow = await import('apache-arrow');
    const { Table, tableToIPC } = arrow;
    let state = this.statisticsCommand({ op: 'begin', request });
    const id = state.id;
    try {
      while (state.request) {
        const task: StatisticsRequest = state.request;
        const submit = { op: 'submit', id, request_id: task.id };
        signal?.throwIfAborted();
        const controller = new AbortController();
        const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const timeout = setTimeout(() => controller.abort(new Error('Statistics request timed out')), task.timeout_ms);
        let result: ArrowResult | undefined;
        try {
          if (task.dialect !== engine.dialect) throw new Error('Statistics and engine dialects differ');
          if (!engine.executeStatistics) throw new Error('Adapter does not provide bounded statistics execution');
          result = await engine.executeStatistics(task, requestSignal);
          let rows = 0, bytes = 0;
          for await (let batch of result) {
            requestSignal.throwIfAborted();
            batch = localArrowBatch(batch, arrow);
            let offset = 0;
            while (offset < batch.numRows && rows < task.max_rows) {
              requestSignal.throwIfAborted();
              let count = Math.min(batch.numRows - offset, task.max_rows - rows);
              const limit = Math.min(1024 * 1024, task.max_bytes - bytes);
              let ipc: Uint8Array;
              while (true) {
                ipc = tableToIPC(new Table(batch.slice(offset, offset + count)), 'stream');
                if (ipc.byteLength <= limit) break;
                if (count <= 1) throw new Error('Statistics transport byte budget reached');
                count = Math.max(1, Math.floor(count / 2));
              }
              this.statisticsCommand({ ...submit, ipc: Buffer.from(ipc).toString('base64'), done: false });
              rows += count; offset += count; bytes += ipc.byteLength;
            }
            if (rows >= task.max_rows) break;
          }
          await result.close(); result = undefined;
          state = this.statisticsCommand({ ...submit, rows: [] });
        } catch (error) {
          signal?.throwIfAborted();
          state = this.statisticsCommand({ ...submit, error: String(error) });
        } finally {
          clearTimeout(timeout);
          controller.abort();
          await result?.close();
        }
      }
      signal?.throwIfAborted();
      const result: StatisticsResult = this.statisticsCommand({ op: 'finish', id });
      this.retain(result);
      return result;
    } catch (error) {
      this.statisticsCommand({ op: 'cancel', id });
      throw error;
    }
  }
  async query(request: CompileRequest, engine: ExecutionEngine): Promise<ArrowResult> {
    if (request.dialect !== engine.dialect) throw new Error('Compiler and engine SQL dialects differ');
    return engine.execute(this.compile(request));
  }
}
function defaultLibrary(): string {
  const suffix = process.platform === 'win32' ? 'orchiddb_compiler.dll' :
    process.platform === 'darwin' ? 'liborchiddb_compiler.dylib' : 'liborchiddb_compiler.so';
  const path = fileURLToPath(new URL(`../native/${process.platform}-${process.arch}/${suffix}`, import.meta.url));
  if (!existsSync(path)) throw new Error('No packaged native compiler for this platform; set ORCHIDDB_NATIVE_LIBRARY');
  return path;
}

/** Ensures early cancellation and exceptions release the caller-provided result lease. */
export async function* batches(result: ArrowResult): AsyncGenerator<RecordBatch> {
  try { yield* result; } finally { await result.close(); }
}

/** JSON numbers are emitted directly for bigint so signed int64 values reach Rust intact.
 * Reject rounded Numbers instead of compiling a different parameter value. */
function encodeRequest(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value > (1n << 63n) - 1n)
      throw new RangeError('Integer parameter exceeds signed 64-bit range');
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Numbers must be finite');
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new RangeError('Unsafe integer Number; pass an exact bigint instead');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') throw new TypeError('Request must contain JSON values or signed int64 bigint');
  if (ancestors.has(value)) throw new TypeError('Cyclic request');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return '[' + Array.from(value, item => encodeRequest(item, ancestors)).join(',') + ']';
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('Request objects must be plain objects');
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => JSON.stringify(key) + ':' + encodeRequest(item, ancestors)).join(',') + '}';
  } finally { ancestors.delete(value); }
}

/** Adapt a worker-backed DuckDB-WASM connection without owning its lifetime.
 * The session must execute off the JS event loop so deadlines can interrupt it. */
export function asyncDuckDBEngine(connection: {
  send(sql: string, allowStreamResult: boolean): Promise<AsyncIterable<RecordBatch> & {
    schema: Schema; cancel(): void | Promise<void>;
  }>;
  cancelSent(): void | Promise<unknown>;
}): ExecutionEngine {
  let active = false;
  async function executeSQL(sql: string, signal?: AbortSignal): Promise<ArrowResult> {
    signal?.throwIfAborted();
    if (active) throw new Error('Connection already has an active result');
    active = true;
    let reader: Awaited<ReturnType<typeof connection.send>> | undefined;
    let closed = false;
    const abort = () => { void Promise.resolve(connection.cancelSent()).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    const close = async () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', abort);
      try { await reader?.cancel(); await connection.cancelSent(); }
      finally { active = false; }
    };
    try {
      reader = await connection.send(sql, true);
      signal?.throwIfAborted();
      return {
        schema: reader.schema,
        async *[Symbol.asyncIterator]() {
          if (closed) throw new Error('Result is closed');
          for await (const batch of reader!) { signal?.throwIfAborted(); yield batch; }
        },
        close,
      };
    } catch (error) { await close(); throw error; }
  }
  return {
    id: 'duckdb-async', dialect: 'duckdb',
    execute: query => executeSQL(query.sql),
    executeStatistics: (task, signal) => executeSQL(task.sql, signal),
  };
}

// Arrow's CJS and ESM exports have distinct class identities. Recreate metadata
// and wrappers in the local module while retaining the original typed buffers.
function localArrowBatch(batch: any, a: typeof import('apache-arrow')): RecordBatch {
  if (batch instanceof a.RecordBatch) return batch;
  const field = (f: any): import('apache-arrow').Field => new a.Field(f.name, type(f.type), f.nullable, f.metadata);
  const type = (t: any): import('apache-arrow').DataType => {
    switch (t.typeId) {
      case a.Type.Null: return new a.Null();
      case a.Type.Bool: return new a.Bool();
      case a.Type.Int: return new a.Int(t.isSigned, t.bitWidth);
      case a.Type.Float: return new a.Float(t.precision);
      case a.Type.Utf8: return new a.Utf8();
      case a.Type.LargeUtf8: return new a.LargeUtf8();
      case a.Type.Binary: return new a.Binary();
      case a.Type.LargeBinary: return new a.LargeBinary();
      case a.Type.FixedSizeBinary: return new a.FixedSizeBinary(t.byteWidth);
      case a.Type.Decimal: return new a.Decimal(t.scale, t.precision, t.bitWidth);
      case a.Type.Date: return new a.Date_(t.unit);
      case a.Type.Time: return new a.Time(t.unit, t.bitWidth);
      case a.Type.Timestamp: return new a.Timestamp(t.unit, t.timezone);
      case a.Type.Interval: return new a.Interval(t.unit);
      case a.Type.Duration: return new a.Duration(t.unit);
      case a.Type.List: return new a.List(field(t.children[0]));
      case a.Type.FixedSizeList: return new a.FixedSizeList(t.listSize, field(t.children[0]));
      case a.Type.Struct: return new a.Struct(t.children.map(field));
      case a.Type.Map: return new a.Map_(field(t.children[0]), t.keysSorted);
      case a.Type.Union: return new a.Union(t.mode, t.typeIds, t.children.map(field));
      case a.Type.Dictionary: return new a.Dictionary(type(t.dictionary), type(t.indices) as import('apache-arrow').Int32, t.id, t.isOrdered);
      default: throw new Error(`Unsupported Arrow statistics type ${t.typeId}`);
    }
  };
  const data = (d: any): import('apache-arrow').Data => new a.Data(type(d.type), d.offset, d.length, d.nullCount,
    d.buffers, d.children.map(data), d.dictionary ? new a.Vector(d.dictionary.data.map(data)) : undefined);
  return new a.RecordBatch(new a.Schema(batch.schema.fields.map(field), batch.schema.metadata), data(batch.data) as import('apache-arrow').Data<import('apache-arrow').Struct>);
}
