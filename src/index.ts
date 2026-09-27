import koffi from 'koffi';
import { existsSync, readFileSync } from 'node:fs';
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
/** Only metadata crosses FFI. Result data never enters the compiler. */
export interface CompileRequest {
  version: 1; dialect: Dialect; language: Language; query: string;
  parameters?: Readonly<Record<string, unknown>>;
  tables: readonly Table[]; nodes?: readonly NodeMapping[]; edges?: readonly EdgeMapping[];
  functions?: readonly FunctionSignature[]; ontology?: Ontology;
  rdf?: readonly RdfMapping[]; dataset?: string;
}
export interface CompiledQuery { version: 1; dialect: Dialect; sql: string; fields: readonly string[] }

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
}

export class Compiler {
  private readonly library: ReturnType<typeof koffi.load>;
  private readonly compileNative: ReturnType<ReturnType<typeof koffi.load>['func']>;
  private readonly freeNative: ReturnType<ReturnType<typeof koffi.load>['func']>;
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
    this.freeNative = this.library.func('void orchiddb_string_free(void *value)');
    this.coreRevision = this.library.func('const char *orchiddb_core_revision(void)')();
    this.version = this.library.func('const char *orchiddb_version(void)')();
    if (manifest && (manifest.abi_version !== abi || manifest.version !== this.version || manifest.core_revision !== this.coreRevision)) {
      this.library.unload(); throw new Error('Native compiler manifest mismatch');
    }
  }
  /** Synchronous CPU work. Use a worker thread for latency-sensitive Node servers. */
  compile(request: CompileRequest): CompiledQuery {
    const encoded = encodeRequest(request);
    if (!encoded || encoded.includes('\u0000')) throw new Error('Request cannot contain NUL');
    const pointer = this.compileNative(encoded);
    if (!pointer) throw new Error('Native compiler returned a null response');
    let response: any;
    try { response = JSON.parse(koffi.decode(pointer, 'char', -1) as string); }
    finally { this.freeNative(pointer); }
    if (response?.ok !== true) throw new Error(response?.error ?? 'Invalid compiler response');
    const result = response.result;
    if (result?.version !== 1 || result?.dialect !== request.dialect || typeof result?.sql !== 'string' ||
        !Array.isArray(result?.fields) || !result.fields.every((f: unknown) => typeof f === 'string')) {
      throw new Error('Invalid compiled query response');
    }
    return Object.freeze({ ...result, fields: Object.freeze([...result.fields]) });
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
