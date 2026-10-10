import pg from 'pg';
import { AsyncLocalStorage } from 'async_hooks';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import { S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { emitDbChange } from '../socket.js';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

// ---------------------------------------------------------------------------
// Type parsers — make node-postgres output match what the query builder /
// PostgREST returns (numbers for int8/numeric, ISO-8601 UTC strings for
// timestamptz).
// ---------------------------------------------------------------------------
pg.types.setTypeParser(20, (v) => parseInt(v, 10));            // int8   -> number
pg.types.setTypeParser(1700, (v) => parseFloat(v));            // numeric-> number
pg.types.setTypeParser(1184, (v) => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toISOString(); // timestamptz -> ISO string (pass through invalid values like 'infinity')
});
pg.types.setTypeParser(1114, (v) => v);                        // timestamp -> raw string
pg.types.setTypeParser(1082, (v) => v);                        // date -> string
pg.types.setTypeParser(1083, (v) => v);                        // time -> string

// Pool size is the number that decides what a slow query costs the rest of the
// app: at max 5 the fifth concurrent slow query makes every OTHER request queue
// for a free connection, which is what "the site keeps loading" looks like to a
// user on a fast network.
//
// Raising it buys concurrency but costs RAM and CPU: every connection can run
// its own sorts at work_mem each. On a 2-vCPU instance, 10 connections running
// CPU-heavy queries can be SLOWER than 5, because they contend rather than
// queue. Past ~10 there is usually a query that needs an index, not more slots.
//
// Overridable per environment so a busy box can be given headroom without a code
// change. Watch server max_connections before going much above this -- the
// backend, the panel and RDS internal sessions all share the same budget.
const POOL_MAX = Math.max(1, parseInt(process.env.PG_POOL_MAX || '5', 10));
const poolConfig = {
  max: POOL_MAX,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 20000,
  maxUses: 1000,
};
if (process.env.DATABASE_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL;
  poolConfig.ssl = process.env.DATABASE_SSL !== 'false' ? { rejectUnauthorized: false } : false;
} else {
  poolConfig.host = process.env.PGHOST || 'localhost';
  poolConfig.port = parseInt(process.env.PGPORT || '5432', 10);
  poolConfig.user = process.env.PGUSER;
  poolConfig.password = process.env.PGPASSWORD;
  poolConfig.database = process.env.PGDATABASE;
  if (process.env.PGSSLMODE && process.env.PGSSLMODE !== 'disable') {
    poolConfig.ssl = { rejectUnauthorized: false };
  }
}
// The business operates on IST calendar days. Pinning each session's timezone
// makes now(), ::date casts and naive timestamp comparisons mean IST
// everywhere, killing the UTC-vs-IST date-filter bug class at the root.
// statement_timeout caps any runaway query (seq-scan floods, lock stalls) so a
// single bad query can't pin the RDS CPU for minutes. lock_timeout aborts long
// lock waits (e.g. an UPDATE blocked behind a big transaction) before they
// silently bind a connection. Both are overridable via env for rare legit
// long-running jobs.
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS || 60000);
const LOCK_TIMEOUT_MS = Number(process.env.PG_LOCK_TIMEOUT_MS || 10000);
poolConfig.options = [
  poolConfig.options,
  '-c timezone=Asia/Kolkata',
  `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
].filter(Boolean).join(' ');
const pgPool = new pg.Pool(poolConfig);
pgPool.on('error', (err) => console.error('pg pool idle client error:', err.message));

// Route every pool.query() call through the active transaction's connection
// when one is open, so queries issued inside db.transaction() all run on
// the same client (all-or-nothing) instead of the shared pool.
const txStore = new AsyncLocalStorage();
const pool = new Proxy(pgPool, {
  get(target, prop) {
    const ctx = txStore.getStore();
    if (prop === 'query' && ctx && ctx.client) return ctx.client.query.bind(ctx.client);
    const v = target[prop];
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const PGRST116 = { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116', details: '', hint: '' };

// -- Realtime -----------------------------------------------------------------
// Tables whose row writes are broadcast to socket.io clients as db:change events.
const REALTIME_TABLES = new Set([
  'fro_donor_logs', 'bank_audit_entries', 'rejected_lead_tickets',
  'fro_assignments', 'fro_live_status', 'messages', 'conversations',
  'attendance', 'leaves', 'worker_loans', 'attendance_corrections', 'impersonation_codes',
  'receipts', 'leads', 'special_incentives', 'special_incentive_progress',
  'lead_champion_announcements', 'incentive_slabs',
  // Ticket threads: without these a team reply only reaches the raising FRO on
  // the next 30s poll. Low write volume, so no bulk coalescing is needed.
  'support_tickets', 'ticket_replies',
]);

// High-volume tables whose rows are written in bulk (imports, scrapes, donor
// logs): broadcasting one db:change per row would fan an N-row write into N
// socket emits across every connected panel and stall the shared event loop.
// Clients only use db:change for these tables as a "something changed, refetch"
// signal, so a single coalesced event per (table, eventType) carrying the last
// row (plus count) is behaviorally equivalent and drops the fan-out to ~1.
const BULK_EMIT_TABLES = new Set([
  'receipts', 'bank_audit_entries', 'fro_donor_logs', 'rejected_lead_tickets',
  'lead_champion_announcements', 'incentive_slabs', 'impersonation_codes',
]);

// Pending bulk-emission windows, keyed by `${table}:${eventType}`. Each window
// flushes at most once per RT_BULK_FLUSH_MS (default 2s) with the last row seen.
const pendingBulkEmits = new Map();

function flushBulkEmit(table, eventType) {
  const key = `${table}:${eventType}`;
  const rec = pendingBulkEmits.get(key);
  if (!rec) return;
  pendingBulkEmits.delete(key);
  if (rec.timer) clearTimeout(rec.timer);
  const row = rec.last;
  if (!row) return;
  emitDbChange({
    table, schema: 'public', eventType, bulk: true, count: rec.count,
    new: eventType === 'DELETE' ? null : row,
    old: eventType === 'DELETE' ? row : null,
  });
}

function emitRealtimeRows(table, eventType, rows) {
  if (!rows || rows.length === 0) return;

  if (BULK_EMIT_TABLES.has(table)) {
    // Collapse the whole batch into one pending event. Consecutive writes to
    // the same table land on the same window, so a multi-thousand-row import
    // produces ~1 broadcast instead of ~thousands.
    const key = `${table}:${eventType}`;
    for (const row of rows) {
      if (!row) continue;
      let rec = pendingBulkEmits.get(key);
      if (!rec) {
        rec = { last: null, count: 0, timer: null };
        pendingBulkEmits.set(key, rec);
      }
      rec.last = row;
      rec.count += 1;
      if (!rec.timer) {
        rec.timer = setTimeout(() => flushBulkEmit(table, eventType), Number(process.env.RT_BULK_FLUSH_MS || 2000));
        rec.timer.unref?.();
      }
    }
    return;
  }

  for (const row of rows) {
    if (!row) continue;
    // fro_live_status rows are rewritten by every heartbeat and broadcast to
    // EVERY connected client: ship only the fields subscribers read (pause
    // convergence needs worker_id/is_paused/paused_by; admin lists refetch
    // full data themselves), not the full counter payload.
    const slim =
      table === 'fro_live_status' && eventType !== 'DELETE' && row && typeof row === 'object'
        ? { worker_id: row.worker_id, is_paused: row.is_paused, paused_by: row.paused_by, status: row.status, updated_at: row.updated_at }
        : row;
    if (eventType === 'DELETE') emitDbChange({ table, schema: 'public', eventType, new: null, old: row });
    else emitDbChange({ table, schema: 'public', eventType, new: slim, old: null });
  }
}

// ---------------------------------------------------------------------------
// Schema metadata caches
// ---------------------------------------------------------------------------
let fkCache = null;
const columnCache = {};
const columnCacheTs = {};
const pkCache = {};
const jsonColumnCache = {};
// Columns can be added by raw SQL migrations applied outside this process
// (e.g. w1_name..w4_name for the Android Whatsapp data). The '*' expansion in
// selects reads this cache, so keep it fresh with a short TTL instead of a
// one-time snapshot that goes stale until a backend restart.
const COLUMN_TTL_MS = 30000;

// Manually-declared joins for tables that lost their FK constraints during the
// RDS migration. Keyed by (child_table -> embed rel -> column mapping).
const EMBED_JOINS = {
  agent_phone_assignments: {
    whatsapp_accounts: { childColumn: 'account_id', parentColumn: 'id' },
  },
  support_tickets: {
    support_tickets_raised_by_fkey: { childColumn: 'raised_by', parentColumn: 'id' },
    support_tickets_resolved_by_fkey: { childColumn: 'resolved_by', parentColumn: 'id' },
  },
  developer_tickets: {
    developer_tickets_raised_by_fkey: { childColumn: 'raised_by', parentColumn: 'id' },
    developer_tickets_assigned_to_fkey: { childColumn: 'assigned_to', parentColumn: 'id' },
  },
};

async function getForeignKeys() {
  if (fkCache) return fkCache;
  const { rows } = await pool.query(`
    SELECT con.conname AS constraint,
           child.relname AS child_table,
           child_att.attname AS child_column,
           parent.relname AS parent_table,
           parent_att.attname AS parent_column
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace cns ON cns.oid = child.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY
      AS ord(child_attnum, parent_attnum, pos)
    JOIN pg_attribute child_att ON child_att.attrelid = con.conrelid AND child_att.attnum = ord.child_attnum
    JOIN pg_attribute parent_att ON parent_att.attrelid = con.confrelid AND parent_att.attnum = ord.parent_attnum
    WHERE con.contype = 'f' AND cns.nspname = 'public'
  `);
  fkCache = rows;
  return fkCache;
}

async function getColumns(table) {
  const now = Date.now();
  const stale = !columnCache[table] || columnCacheTs[table] === undefined || now - columnCacheTs[table] > COLUMN_TTL_MS;
  if (!stale) return columnCache[table];
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table]
  );
  columnCache[table] = rows.map((r) => r.column_name);
  columnCacheTs[table] = now;
  return columnCache[table];
}

// If a write references a column absent from the cached schema, the cache is
// stale (e.g. a column was added to the live DB after this process started).
// Drop it so the next read re-queries information_schema and picks up the new
// column without requiring a process restart.
async function ensureSchemaFresh(table, keys) {
  const cached = await getColumns(table);
  if (keys.some((k) => !cached.includes(k))) delete columnCache[table];
}

async function getJsonColumns(table) {
  if (jsonColumnCache[table]) return jsonColumnCache[table];
  const { rows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND data_type IN ('json', 'jsonb')`,
    [table]
  );
  jsonColumnCache[table] = new Set(rows.map((r) => r.column_name));
  return jsonColumnCache[table];
}

// pg serializes JS arrays as Postgres array literals ({...}), not JSON ([...]),
// which Postgres rejects when the target column is json/jsonb. Pre-serialize.
function toJsonParam(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function getPrimaryKey(table) {
  if (pkCache[table] !== undefined) return pkCache[table];
  const { rows } = await pool.query(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1
     ORDER BY kcu.ordinal_position`,
    [table]
  );
  pkCache[table] = rows.map((r) => r.column_name);
  return pkCache[table];
}

// ---------------------------------------------------------------------------
// Relationship resolution (to-one embeds)
// ---------------------------------------------------------------------------
async function guessChildColumn(childTable, parentTable) {
  const cols = await getColumns(childTable);
  const singular = parentTable.replace(/ies$/, 'y').replace(/s$/, '');
  const candidates = [
    `${parentTable}_id`,
    `${singular}_id`,
    `${parentTable}s_id`,
    `${singular}s_id`,
  ];
  for (const c of candidates) if (cols.includes(c)) return c;
  const matches = cols.filter((c) => c.endsWith('_id') && (c.startsWith(parentTable) || c.startsWith(singular)));
  if (matches.length === 1) return matches[0];
  return null;
}

async function resolveRelationship(childTable, rel, hint) {
  const fks = await getForeignKeys();
  const childFks = fks.filter((f) => f.child_table === childTable);
  const hintIsMode = hint === 'inner' || hint === 'left';
  const mode = hintIsMode ? hint : 'left';

  const hintConstraint = !hintIsMode && hint ? childFks.find((f) => f.constraint === hint) : null;
  const hintColumn = !hintIsMode && hint && !hintConstraint ? childFks.find((f) => f.child_column === hint) : null;

  let chosen = null;
  if (hintConstraint || hintColumn) {
    chosen = hintConstraint || hintColumn;
} else {
    // Check EMBED_JOINS with hint first (for cases where FK constraints were dropped in RDS migration).
    // This allows PostgREST embeds like "workers!developer_tickets_raised_by_fkey(...)" to resolve
    // using explicit childColumn/parentColumn mappings instead of relying on DB metadata FK constraints.
    if (hint && EMBED_JOINS[childTable] && EMBED_JOINS[childTable][hint]) {
      const manual = EMBED_JOINS[childTable][hint];
      chosen = {
        parent_table: rel,
        child_column: manual.childColumn,
        parent_column: manual.parentColumn,
      };
    } else {
      const byTable = childFks.filter((f) => f.parent_table === rel);
      if (byTable.length === 1) {
        chosen = byTable[0];
      } else if (byTable.length > 1) {
        throw new Error(`Ambiguous relationship ${childTable} -> ${rel}`);
      } else {
        chosen = childFks.find((f) => f.constraint === rel) || childFks.find((f) => f.child_column === rel) || null;
      }
    }
  }

  if (!chosen) {
    const guessed = await guessChildColumn(childTable, rel);
    if (guessed) {
      const pks = await getPrimaryKey(rel);
      return { parentTable: rel, childColumn: guessed, parentColumn: pks.length ? pks[0] : 'id', mode };
    }
    // Tables without FK constraints (constraints dropped in the RDS migration).
    const manual = EMBED_JOINS[childTable] && EMBED_JOINS[childTable][rel];
    if (manual) {
      return { parentTable: rel, childColumn: manual.childColumn, parentColumn: manual.parentColumn, mode };
    }
    throw new Error(`Could not resolve relationship ${childTable} -> ${rel}`);
  }

  return { parentTable: chosen.parent_table, childColumn: chosen.child_column, parentColumn: chosen.parent_column, mode };
}

// ---------------------------------------------------------------------------
// Select-list parser: supports `*`, columns, and embeds of the form
//   [alias:]table[!hint](...)
//   [alias:]relationship(...)
//   nested embeds and `*` inside embeds.
// ---------------------------------------------------------------------------
const OP_SET = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'not.in', 'not.is', 'cs', 'cd']);

function parseSelectList(str) {
  let i = 0;
  const n = str.length;
  const skipSpaces = () => { while (i < n && /\s/.test(str[i])) i++; };
  const readName = () => {
    skipSpaces();
    const s = i;
    while (i < n && /[A-Za-z0-9_]/.test(str[i])) i++;
    return str.slice(s, i);
  };
  const expectParen = () => {
    skipSpaces();
    if (str[i] !== '(') throw new Error(`select parse error near "${str.slice(i, i + 20)}"`);
    i++;
  };
  const parseItem = () => {
    skipSpaces();
    if (str[i] === '*') { i++; return { type: 'star' }; }
    const first = readName();
    skipSpaces();
    if (str[i] === ':') {
      i++;
      const rel = readName();
      let hint = null;
      skipSpaces();
      if (str[i] === '!') { i++; hint = readName(); }
      expectParen();
      const children = parseList();
      skipSpaces();
      if (str[i] !== ')') throw new Error('select parse: expected )');
      i++;
      return { type: 'embed', alias: first, rel, hint, children };
    }
    if (str[i] === '!') {
      i++;
      const hint = readName();
      expectParen();
      const children = parseList();
      skipSpaces();
      if (str[i] !== ')') throw new Error('select parse: expected )');
      i++;
      return { type: 'embed', alias: null, rel: first, hint, children };
    }
    if (str[i] === '(') {
      i++;
      const children = parseList();
      skipSpaces();
      if (str[i] !== ')') throw new Error('select parse: expected )');
      i++;
      return { type: 'embed', alias: null, rel: first, hint: null, children };
    }
    return { type: 'col', name: first };
  };
  const parseList = () => {
    const out = [];
    for (;;) {
      skipSpaces();
      if (i >= n) break;
      out.push(parseItem());
      skipSpaces();
      if (str[i] === ',') { i++; continue; }
      break;
    }
    return out;
  };

  return parseList();
}

// ---------------------------------------------------------------------------
// or() string parser -> [{ conditions: [cond, ...], }, ...]  (OR of AND-groups)
// ---------------------------------------------------------------------------
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function parseCond(seg) {
  const tokens = seg.split('.');
  let opIdx = -1;
  for (let i = 1; i < tokens.length; i++) {
    if (OP_SET.has(tokens[i])) { opIdx = i; break; }
  }
  if (opIdx === -1) throw new Error(`Cannot parse or() condition "${seg}"`);
  return {
    col: tokens.slice(0, opIdx).join('.'),
    op: tokens[opIdx],
    value: tokens.slice(opIdx + 1).join('.'),
  };
}

function parseOrString(str) {
  const groups = splitTopLevel(str, ',');
  return groups.map((group) => {
    const trimmed = group.trim();
    if (/^and\(/.test(trimmed) && trimmed.endsWith(')')) {
      const inner = trimmed.slice(4, -1);
      return splitTopLevel(inner, ',').map((c) => parseCond(c.trim()));
    }
    return [parseCond(trimmed)];
  });
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------
function orValueParam(value) {
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'not.null') return { __notNull: true };
  return value;
}

function orListToParams(listStr) {
  const inner = listStr.trim();
  const body = inner.startsWith('(') && inner.endsWith(')') ? inner.slice(1, -1) : inner;
  return body.split(',').map((v) => v.trim());
}

function likePattern(value) {
  return value.replace(/\*/g, '%');
}

// ---------------------------------------------------------------------------
// Row reconstruction: flatten "a.b.c" keys into nested objects and null out
// empty/fully-null embed objects.
// ---------------------------------------------------------------------------
function setNullIfEmpty(obj, parts) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return;
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  const val = cur[last];
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const vals = Object.values(val);
    if (vals.length === 0 || vals.every((x) => x === null || x === undefined)) cur[last] = null;
  }
}

function nestRows(rows, embedPaths) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === '__pg_count' || k === '__count') continue;
      if (k.includes('.')) {
        const parts = k.split('.');
        let obj = out;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (obj[seg] == null || typeof obj[seg] !== 'object') obj[seg] = {};
          obj = obj[seg];
        }
        obj[parts[parts.length - 1]] = v;
      } else {
        out[k] = v;
      }
    }
    for (const p of embedPaths) setNullIfEmpty(out, p.split('.'));
    return out;
  });
}

// ---------------------------------------------------------------------------
// Query builder (thenable)
// ---------------------------------------------------------------------------
// Tables that were deliberately retired. The physical table is dropped, but
// feature code across the codebase still calls db.from() on them, so these
// resolve to empty results instead of throwing "relation does not exist" —
// which would otherwise turn every call site into a 500. Writing is a silent
// no-op, so retiring a table is one edit here instead of ~90 scattered ones.
//
// Add a table here ONLY when it is genuinely being retired. A typo would
// silently swallow real queries.
const RETIRED_TABLES = new Set(['notification_log']);

// Chainable no-op stand-in for a retired table. It mimics enough of the
// QueryBuilder surface (fluent filters + thenable) that existing call sites
// keep working unchanged and simply see an empty table.
class RetiredTableQuery {
  constructor(table) {
    this.table = table;
    this.op = 'select';
  }

  select() { this.op = 'select'; return this; }
  eq() { return this; }
  neq() { return this; }
  gt() { return this; }
  gte() { return this; }
  lt() { return this; }
  lte() { return this; }
  is() { return this; }
  like() { return this; }
  ilike() { return this; }
  in() { return this; }
  not() { return this; }
  or() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  single() { this.op = 'select'; this._single = true; return this; }
  maybeSingle() { this.op = 'select'; this._single = true; return this; }
  insert() { this.op = 'insert'; return this; }
  update() { this.op = 'update'; return this; }
  upsert() { this.op = 'upsert'; return this; }
  ignoreDuplicates() { return this; }
  delete() { this.op = 'delete'; return this; }

  // Mirrors the real builder's result shape: reads hand back an empty table,
  // writes hand back the "done, nothing to return" shape.
  _result() {
    if (this.op === 'select') {
      if (this._single) {
        const empty = { data: null, count: null, error: { ...PGRST116 } };
        return empty;
      }
      return { data: [], count: 0, error: null };
    }
    return { data: null, count: null, error: null };
  }

  then(onFulfilled, onRejected) { return Promise.resolve(this._result()).then(onFulfilled, onRejected); }
  catch(onRejected) { return Promise.resolve(this._result()).then(undefined, onRejected); }
  finally(fn) { return Promise.resolve(this._result()).finally(fn); }
}

function makeQuery(table) {
  return RETIRED_TABLES.has(table) ? new RetiredTableQuery(table) : new QueryBuilder(table);
}

class QueryBuilder {
  constructor(table) {
    this.table = table;
    this.op = 'select';
    this.selectStr = null;
    this.filters = [];
    this.orGroups = [];
    this.orders = [];
    this.limitVal = null;
    this.fromVal = null;
    this.toVal = null;
    this.singleFlag = false;
    this.maybeSingleFlag = false;
    this.countOpt = null;
    this.head = false;
    this.insertRows = null;
    this.updateData = null;
    this.upsertData = null;
    this.onConflict = null;
    this.ignoreDuplicates = false;
    this.selectAfterWrite = false;
  }

  select(columns, opts = {}) {
    this.selectStr = columns == null ? '*' : String(columns);
    this.selectAfterWrite = true;
    if (opts) {
      if (opts.count === 'exact' || opts.count === 'planned' || opts.count === 'estimated') this.countOpt = opts.count;
      if (opts.head) this.head = true;
    }
    return this;
  }

  eq(col, value) { this.filters.push({ col, op: 'eq', value }); return this; }
  neq(col, value) { this.filters.push({ col, op: 'neq', value }); return this; }
  gt(col, value) { this.filters.push({ col, op: 'gt', value }); return this; }
  gte(col, value) { this.filters.push({ col, op: 'gte', value }); return this; }
  lt(col, value) { this.filters.push({ col, op: 'lt', value }); return this; }
  lte(col, value) { this.filters.push({ col, op: 'lte', value }); return this; }
  is(col, value) { this.filters.push({ col, op: 'is', value }); return this; }
  like(col, value) { this.filters.push({ col, op: 'like', value }); return this; }
  ilike(col, value) { this.filters.push({ col, op: 'ilike', value }); return this; }
  in(col, values) { this.filters.push({ col, op: 'in', value: Array.isArray(values) ? values : [values] }); return this; }
  not(col, op, value) { this.filters.push({ col, op: `not_${op}`, value }); return this; }
  or(str) { this.orGroups.push(String(str)); return this; }
  order(col, opts = {}) {
    const m = /^(\w+)\(([^)]+)\)$/.exec(String(col));
    if (m) col = `${m[1]}.${m[2]}`;
    this.orders.push({ col, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n) { this.limitVal = n; return this; }
  range(from, to) { this.fromVal = from; this.toVal = to; return this; }
  single() { this.singleFlag = true; return this; }
  maybeSingle() { this.maybeSingleFlag = true; return this; }

  insert(rows) { this.op = 'insert'; this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(data) { this.op = 'update'; this.updateData = data || {}; return this; }
  upsert(data, opts = {}) {
    this.op = 'upsert';
    this.upsertData = Array.isArray(data) ? data : [data];
    this.onConflict = opts.onConflict || null;
    this.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }
  ignoreDuplicates() { this.ignoreDuplicates = true; return this; }
  delete() { this.op = 'delete'; return this; }

  then(onFulfilled, onRejected) {
    const p = this._execute();
    return p.then(onFulfilled, onRejected);
  }
  catch(onRejected) {
    return this._execute().then(undefined, onRejected);
  }

  async _execute() {
    try {
      if (this.op === 'select') return await this._execSelect();
      if (this.op === 'insert') return await this._execInsert();
      if (this.op === 'update') return await this._execUpdate();
      if (this.op === 'upsert') return await this._execUpsert();
      if (this.op === 'delete') return await this._execDelete();
      return { data: null, error: null };
    } catch (err) {
      // Inside a PostgreSQL transaction any error automatically aborts the
      // entire transaction.  Returning the error as a result object lets the
      // caller continue executing queries on the same (now dead) transaction
      // client, which surfaces the generic "current transaction is aborted"
      // error and masks the real cause.  Re-throw immediately so the
      // transaction wrapper can ROLLBACK and propagate the original error.
      if (txStore.getStore()) throw err;
      return {
        data: null,
        error: {
          message: err && err.message ? err.message : String(err),
          code: err && err.code ? err.code : 'UNKNOWN',
          details: err && err.details ? err.details : '',
          hint: err && err.hint ? err.hint : '',
        },
      };
    }
  }

  // -- shared column-reference / filter builders ---------------------------

  resolveCol(col, aliasMap) {
    if (col.includes('.')) {
      const parts = col.split('.');
      for (let len = parts.length - 1; len >= 1; len--) {
        const prefix = parts.slice(0, len).join('.');
        if (aliasMap.has(prefix)) return { alias: aliasMap.get(prefix), column: parts.slice(len).join('.') };
      }
    }
    return { alias: 't0', column: col };
  }

  buildCondSql(cond, aliasMap, params, { forUpdateDelete = false } = {}) {
    const { alias, column } = this.resolveCol(cond.col, aliasMap);
    const ref = forUpdateDelete ? q(column) : `${alias}.${q(column)}`;
    const op = cond.op;
    if (op === 'is') {
      if (cond.value === 'not.null') return `${ref} IS NOT NULL`;
      if (cond.value === 'null') return `${ref} IS NULL`;
      if (cond.value === 'true' || cond.value === 'false') {
        params.push(cond.value === 'true');
        return `${ref} = $${params.length}`;
      }
      params.push(cond.value);
      return `${ref} = $${params.length}`;
    }
    if (op === 'in' || op === 'not_in') {
      const list = Array.isArray(cond.value) ? cond.value : orListToParams(cond.value);
      if (list.length === 0) return op === 'not_in' ? 'true' : 'false';
      const ph = [];
      for (const v of list) {
        params.push(v);
        ph.push(`$${params.length}`);
      }
      const inner = ph.join(', ');
      return op === 'not_in' ? `${ref} NOT IN (${inner})` : `${ref} IN (${inner})`;
    }
    const map = {
      eq: '=',
      neq: '<>',
      not_eq: '<>',
      gt: '>',
      not_gt: '<=',
      gte: '>=',
      not_gte: '<',
      lt: '<',
      not_lt: '>=',
      lte: '<=',
      not_lte: '>',
      like: 'LIKE',
      not_like: 'NOT LIKE',
      ilike: 'ILIKE',
      not_ilike: 'NOT ILIKE',
    };
    const sqlOp = map[op];
    if (!sqlOp) throw new Error(`Unsupported filter operator "${op}"`);
    if (op === 'not_eq' && cond.value === 'null') return `${ref} IS NOT NULL`;
    if (op === 'eq' && cond.value === 'null') return `${ref} IS NULL`;
    if (op === 'neq' && cond.value === 'null') return `${ref} IS NOT NULL`;
    let v = orValueParam(cond.value);
    if (v && typeof v === 'object' && v.__notNull) return `${ref} IS NOT NULL`;
    if (op.endsWith('like') || op.endsWith('ilike')) v = likePattern(String(v));
    params.push(v);
    return `${ref} ${sqlOp} $${params.length}`;
  }

  buildWhere(aliasMap, params, { forUpdateDelete = false } = {}) {
    const clauses = [];
    for (const f of this.filters) {
      const { alias, column } = this.resolveCol(f.col, aliasMap);
      const ref = forUpdateDelete ? q(column) : `${alias}.${q(column)}`;
      const op = f.op;

      if (op === 'in') {
        const arr = f.value || [];
        if (arr.length === 0) return { sql: '1 = 0', params };
        const ph = arr.map((v) => { params.push(v); return `$${params.length}`; }).join(', ');
        clauses.push(`${ref} IN (${ph})`);
        continue;
      }
      if (op === 'is') {
        clauses.push(f.value === null ? `${ref} IS NULL` : `${ref} = $${params.push(f.value)}`);
        continue;
      }
      if (op === 'not_is') {
        clauses.push(f.value === null ? `${ref} IS NOT NULL` : `${ref} <> $${params.push(f.value)}`);
        continue;
      }
      if (op === 'like' || op === 'ilike') {
        params.push(f.value);
        clauses.push(`${ref} ${op.toUpperCase()} $${params.length}`);
        continue;
      }
      if (op === 'not_like' || op === 'not_ilike') {
        params.push(f.value);
        clauses.push(`${ref} NOT ${op.slice(4).toUpperCase()} $${params.length}`);
        continue;
      }
      if (op === 'not_in') {
        const arr = Array.isArray(f.value) ? f.value : orListToParams(f.value);
        if (arr.length === 0) continue;
        const ph = arr.map((v) => { params.push(v); return `$${params.length}`; }).join(', ');
        clauses.push(`${ref} NOT IN (${ph})`);
        continue;
      }
      if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
        const neg = op === 'neq';
        const sym = neg ? '<>' : op === 'gt' ? '>' : op === 'gte' ? '>=' : op === 'lt' ? '<' : op === 'lte' ? '<=' : '=';
        if (f.value === null) {
          clauses.push(neg ? `${ref} IS NOT NULL` : `${ref} IS NULL`);
        } else {
          params.push(f.value);
          clauses.push(`${ref} ${sym} $${params.length}`);
        }
        continue;
      }
      if (op === 'not_eq') {
        if (f.value === null) clauses.push(`${ref} IS NOT NULL`);
        else { params.push(f.value); clauses.push(`${ref} <> $${params.length}`); }
        continue;
      }
      if (op === 'not_gt' || op === 'not_gte' || op === 'not_lt' || op === 'not_lte') {
        const sym = op === 'not_gt' ? '<=' : op === 'not_gte' ? '<' : op === 'not_lt' ? '>=' : '>';
        params.push(f.value);
        clauses.push(`${ref} ${sym} $${params.length}`);
        continue;
      }
      throw new Error(`Unsupported filter operator "${op}"`);
    }

    for (const orStr of this.orGroups) {
      const groups = parseOrString(orStr);
      const groupSql = groups.map((conds) => {
        const inner = conds.map((c) => this.buildCondSql(c, aliasMap, params, { forUpdateDelete }));
        return `(${inner.join(' AND ')})`;
      });
      clauses.push(`(${groupSql.join(' OR ')})`);
    }

    if (forUpdateDelete && clauses.length === 0) {
      throw Object.assign(new Error('Update/Delete requires a filter'), { code: 'PGRST100' });
    }
    return { sql: clauses.length ? clauses.map((c) => `(${c})`).join(' AND ') : 'true', params };
  }

  buildOrder(aliasMap) {
    if (!this.orders.length) return '';
    const parts = this.orders.map((o) => {
      const { alias, column } = this.resolveCol(o.col, aliasMap);
      const dir = o.ascending ? 'ASC' : 'DESC';
      const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST';
      return `${alias}.${q(column)} ${dir}${nulls}`;
    });
    return ` ORDER BY ${parts.join(', ')}`;
  }

  // -- SELECT ---------------------------------------------------------------

  async _execSelect() {
    const { items, grouped, hasCountCol } = this._parseReadSelect();
    const embedPaths = [];
    const joins = [];
    const aliasMap = new Map();
    const params = [];

    const rootCols = [];
    if (grouped) {
      rootCols.push(...items.filter((it) => it.type === 'col' && it.name !== 'count').map((it) => it.name));
    } else if (hasCountCol) {
      // select('count') aggregate — no root columns
    } else {
      for (const it of items) {
        if (it.type === 'star') {
          for (const c of await getColumns(this.table)) if (!rootCols.includes(c)) rootCols.push(c);
        } else if (it.type === 'col') {
          if (!rootCols.includes(it.name)) rootCols.push(it.name);
        }
      }
    }

    const selectParts = [];
    if (grouped) {
      for (const c of rootCols) selectParts.push(`t0.${q(c)} AS ${q(c)}`);
    } else {
      for (const c of rootCols) selectParts.push(`t0.${q(c)} AS ${q(c)}`);
    }

    for (const it of items) {
      if (it.type !== 'embed') continue;
      await this._buildEmbed(it, this.table, null, null, joins, selectParts, aliasMap, embedPaths, params);
    }

    const fromSql = [`FROM ${q(this.table)} t0`];
    for (const j of joins) {
      const mode = j.mode === 'inner' ? 'INNER JOIN' : 'LEFT JOIN';
      fromSql.push(`${mode} ${q(j.parentTable)} ${j.alias} ON ${j.alias}.${q(j.parentColumn)} = ${j.childAlias}.${q(j.childColumn)}`);
    }

    const where = this.buildWhere(aliasMap, params);

    let count = null;
    let rows;
    const qlog = (sql) => { if (process.env.DEBUG_SQL) console.error('\n[SQL]', sql, '\n'); };
    if (this.head) {
      const res = await pool.query(`SELECT COUNT(*)::bigint AS __count ${fromSql.join(' ')} WHERE ${where.sql}`, where.params);
      count = res.rows[0] ? res.rows[0].__count : 0;
      rows = [];
    } else if (grouped) {
      const groupBy = rootCols.length ? ` GROUP BY ${rootCols.map((c) => `t0.${q(c)}`).join(', ')}` : '';
      const agg = `COUNT(*) AS ${q('count')}`;
      const extra = this.countOpt === 'exact' ? `, COUNT(*) OVER() AS __pg_count` : '';
      const sql = `SELECT ${selectParts.join(', ')}${selectParts.length ? ', ' : ''}${agg}${extra} ${fromSql.join(' ')} WHERE ${where.sql}${groupBy}${this.buildOrder(aliasMap)}${this._buildLimitOffset()}`;
      qlog(sql);
      const res = await pool.query(sql, where.params);
      rows = res.rows;
      count = rows.length ? rows[0].__pg_count : 0;
    } else if (hasCountCol) {
      // select('count') aggregate — single row [{ count: N }]
      const sql = `SELECT COUNT(*) AS ${q('count')} ${fromSql.join(' ')} WHERE ${where.sql}${this._buildLimitOffset()}`;
      const res = await pool.query(sql, where.params);
      rows = res.rows;
      count = this.countOpt === 'exact' ? (rows.length ? rows[0].count : 0) : null;
    } else {
      const extra = this.countOpt === 'exact' ? `, COUNT(*) OVER() AS __pg_count` : '';
      const sql = `SELECT ${selectParts.join(', ')}${extra} ${fromSql.join(' ')} WHERE ${where.sql}${this.buildOrder(aliasMap)}${this._buildLimitOffset()}`;
      qlog(sql);
      const res = await pool.query(sql, where.params);
      rows = res.rows;
      count = rows.length ? rows[0].__pg_count : 0;
    }

    const data = nestRows(rows, embedPaths);

    let resultData = data;
    if (this.singleFlag || this.maybeSingleFlag) {
      if (data.length === 0) {
        if (this.singleFlag) return { data: null, count, error: { ...PGRST116 } };
        resultData = null;
      } else {
        resultData = data[0];
      }
    }

    return { data: resultData, count, error: null };
  }

  _parseReadSelect() {
    const items = parseSelectList(this.selectStr || '*');
    const rootCols = items.filter((it) => it.type === 'col').map((it) => it.name);
    const hasCountCol = rootCols.includes('count');
    const grouped = hasCountCol && rootCols.length > 1;
    return { items, grouped, hasCountCol };
  }

  async _buildEmbed(embed, childTable, parentPathKey, parentSqlAlias, joins, selectParts, aliasMap, embedPaths, params) {
    const res = await resolveRelationship(childTable, embed.rel, embed.hint);
    const alias = `e${joins.length}`;
    const key = embed.alias || res.parentTable;
    const pathKey = parentPathKey ? `${parentPathKey}.${key}` : key;
    embedPaths.push(pathKey);
    joins.push({
      alias,
      parentTable: res.parentTable,
      parentColumn: res.parentColumn,
      childAlias: parentSqlAlias || 't0',
      childColumn: res.childColumn,
      mode: res.mode,
    });
    aliasMap.set(pathKey, alias);
    aliasMap.set(`${key}`, alias);

    for (const child of embed.children) {
      if (child.type === 'star') {
        for (const c of await getColumns(res.parentTable)) {
          selectParts.push(`${alias}.${q(c)} AS ${q(`${pathKey}.${c}`)}`);
        }
      } else if (child.type === 'col') {
        selectParts.push(`${alias}.${q(child.name)} AS ${q(`${pathKey}.${child.name}`)}`);
      } else {
        await this._buildEmbed(child, res.parentTable, pathKey, alias, joins, selectParts, aliasMap, embedPaths, params);
      }
    }
  }

  _buildLimitOffset() {
    let s = '';
    if (this.limitVal != null) s += ` LIMIT ${parseInt(this.limitVal, 10)}`;
    if (this.fromVal != null) {
      const from = parseInt(this.fromVal, 10);
      const to = this.toVal != null ? parseInt(this.toVal, 10) : from;
      s += ` OFFSET ${from} LIMIT ${Math.max(0, to - from + 1)}`;
    }
    return s;
  }

  // -- INSERT ---------------------------------------------------------------

  async _execInsert() {
    const rows = this.insertRows || [];
    if (rows.length === 0) {
      return this._finishWrite([], this.selectAfterWrite);
    }
    const cols = [];
    const seen = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (r[k] === undefined) continue;
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
    if (cols.length === 0) throw new Error('Insert must contain at least one column');
    await ensureSchemaFresh(this.table, cols);

    const values = [];
    const valueRows = [];
    let p = 1;
    const jsonCols = await getJsonColumns(this.table);
    for (const r of rows) {
      const ph = [];
      for (const c of cols) {
        if (r[c] === undefined) { ph.push('DEFAULT'); continue; }
        values.push(jsonCols.has(c) ? toJsonParam(r[c]) : r[c]);
        ph.push(`$${p++}`);
      }
      valueRows.push(`(${ph.join(', ')})`);
    }

    let sql = `INSERT INTO ${q(this.table)} (${cols.map(q).join(', ')}) VALUES ${valueRows.join(', ')}`;
    if (this.ignoreDuplicates) sql += ' ON CONFLICT DO NOTHING';
    if (this.selectAfterWrite || REALTIME_TABLES.has(this.table)) {
      sql += ' RETURNING *';
      const res = await pool.query(sql, values);
      if (REALTIME_TABLES.has(this.table)) emitRealtimeRows(this.table, 'INSERT', res.rows);
      return this.selectAfterWrite ? this._finishWrite(res.rows, true) : { data: null, count: null, error: null };
    }
    await pool.query(sql, values);
    return { data: null, count: null, error: null };
  }

  // -- UPDATE ---------------------------------------------------------------

  async _execUpdate() {
    const data = {};
    for (const [k, v] of Object.entries(this.updateData || {})) {
      if (v !== undefined) data[k] = v;
    }
    const cols = Object.keys(data);
    if (cols.length === 0) throw new Error('Update must contain at least one column');
    await ensureSchemaFresh(this.table, cols);

    const params = [];
    const jsonCols = await getJsonColumns(this.table);
    const sets = cols.map((c) => `${q(c)} = $${params.push(jsonCols.has(c) ? toJsonParam(data[c]) : data[c])}`);
    const aliasMap = new Map();
    const where = this.buildWhere(aliasMap, params, { forUpdateDelete: true });

    let sql = `UPDATE ${q(this.table)} SET ${sets.join(', ')} WHERE ${where.sql}`;
    if (this.selectAfterWrite || REALTIME_TABLES.has(this.table)) {
      sql += ' RETURNING *';
      const res = await pool.query(sql, where.params);
      if (REALTIME_TABLES.has(this.table)) emitRealtimeRows(this.table, 'UPDATE', res.rows);
      return this.selectAfterWrite ? this._finishWrite(res.rows, true) : { data: null, count: null, error: null };
    }
    await pool.query(sql, where.params);
    return { data: null, count: null, error: null };
  }

  // -- UPSERT ---------------------------------------------------------------

  async _execUpsert() {
    const rows = this.upsertData || [];
    if (rows.length === 0) {
      return this._finishWrite([], this.selectAfterWrite);
    }
    const cols = [];
    const seen = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        if (r[k] === undefined) continue;
        if (!seen.has(k)) { seen.add(k); cols.push(k); }
      }
    }
    if (cols.length === 0) throw new Error('Upsert must contain at least one column');
    await ensureSchemaFresh(this.table, cols);

    let conflictCols = this.onConflict ? this.onConflict.split(',').map((s) => s.trim()) : await getPrimaryKey(this.table);
    if (conflictCols.length === 0) conflictCols = null;

    const values = [];
    const valueRows = [];
    let p = 1;
    const jsonCols = await getJsonColumns(this.table);
    for (const r of rows) {
      const ph = [];
      for (const c of cols) {
        if (r[c] === undefined) { ph.push('DEFAULT'); continue; }
        values.push(jsonCols.has(c) ? toJsonParam(r[c]) : r[c]);
        ph.push(`$${p++}`);
      }
      valueRows.push(`(${ph.join(', ')})`);
    }

    let sql = `INSERT INTO ${q(this.table)} (${cols.map(q).join(', ')}) VALUES ${valueRows.join(', ')}`;
    if (conflictCols) {
      if (this.ignoreDuplicates) {
        sql += ` ON CONFLICT (${conflictCols.map(q).join(', ')}) DO NOTHING`;
      } else {
        const updateCols = cols.filter((c) => !conflictCols.includes(c));
        if (updateCols.length > 0) {
          sql += ` ON CONFLICT (${conflictCols.map(q).join(', ')}) DO UPDATE SET ${updateCols.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ')}`;
        } else {
          sql += ` ON CONFLICT (${conflictCols.map(q).join(', ')}) DO NOTHING`;
        }
      }
    }

    const realtime = REALTIME_TABLES.has(this.table);
    if (this.selectAfterWrite || realtime) {
      sql += ' RETURNING *';
      if (realtime) sql += ', (xmax = 0) AS __rt_ins';
      try {
        const res = await pool.query(sql, values);
        if (realtime) {
          for (const row of res.rows) {
            const { __rt_ins, ...clean } = row;
            emitRealtimeRows(this.table, __rt_ins ? 'INSERT' : 'UPDATE', [clean]);
          }
          res.rows = res.rows.map(({ __rt_ins, ...rest }) => rest);
        }
        return this.selectAfterWrite ? this._finishWrite(res.rows, true) : { data: null, count: null, error: null };
      } catch (err) {
        if (err.code === '23505' && !conflictCols) {
          const pk = (await getPrimaryKey(this.table))[0];
          if (pk) {
            const { rows: existing } = await pool.query(
              `SELECT * FROM ${q(this.table)} WHERE ${pk} = $1`,
              [rows[0][pk]]
            );
            if (realtime) emitRealtimeRows(this.table, 'UPDATE', existing);
            return this.selectAfterWrite ? this._finishWrite(existing, true) : { data: null, count: null, error: null };
          }
        }
        throw err;
      }
    }
    await pool.query(sql, values);
    return { data: null, count: null, error: null };
  }

  // -- DELETE ---------------------------------------------------------------

  async _execDelete() {
    const params = [];
    const aliasMap = new Map();
    const where = this.buildWhere(aliasMap, params, { forUpdateDelete: true });
    let sql = `DELETE FROM ${q(this.table)} WHERE ${where.sql}`;
    if (this.selectAfterWrite || REALTIME_TABLES.has(this.table)) {
      sql += ' RETURNING *';
      const res = await pool.query(sql, where.params);
      if (REALTIME_TABLES.has(this.table)) emitRealtimeRows(this.table, 'DELETE', res.rows);
      return this.selectAfterWrite ? this._finishWrite(res.rows, true) : { data: null, count: null, error: null };
    }
    await pool.query(sql, where.params);
    return { data: null, count: null, error: null };
  }

  // -- write result materialization (with JS-side embed enrichment) ---------

  async _finishWrite(rows, hasSelect) {
    if (!hasSelect) return { data: null, count: null, error: null };
    const items = parseSelectList(this.selectStr || '*');
    const rootCols = [];
    const embeds = [];
    for (const it of items) {
      if (it.type === 'star') rootCols.push('*');
      else if (it.type === 'col') rootCols.push(it.name);
      else embeds.push(it);
    }

    const data = [];
    for (const row of rows) {
      const out = {};
      if (rootCols.includes('*')) Object.assign(out, row);
      for (const c of rootCols) if (c !== '*') out[c] = row[c];
      for (const emb of embeds) {
        const key = emb.alias || (await resolveRelationship(this.table, emb.rel, emb.hint)).parentTable;
        out[key] = await this._enrichWriteEmbed(row, emb, this.table);
      }
      data.push(out);
    }

    let result = data;
    if (this.singleFlag || this.maybeSingleFlag) {
      if (data.length === 0) {
        if (this.singleFlag) return { data: null, count: null, error: { ...PGRST116 } };
        result = null;
      } else {
        result = data[0];
      }
    }
    return { data: result, count: null, error: null };
  }

  async _enrichWriteEmbed(row, embed, childTable) {
    const res = await resolveRelationship(childTable, embed.rel, embed.hint);
    const childVal = row[res.childColumn];
    if (childVal == null) return null;
    const { rows } = await pool.query(
      `SELECT * FROM ${q(res.parentTable)} WHERE ${q(res.parentColumn)} = $1 LIMIT 1`,
      [childVal]
    );
    if (rows.length === 0) return null;
    const prow = rows[0];
    const out = {};
    for (const it of embed.children) {
      if (it.type === 'star') Object.assign(out, prow);
      else if (it.type === 'col') out[it.name] = prow[it.name];
      else {
        const key = it.alias || (await resolveRelationship(res.parentTable, it.rel, it.hint)).parentTable;
        out[key] = await this._enrichWriteEmbed(prow, it, res.parentTable);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// rpc()
// ---------------------------------------------------------------------------
const RPC_ARG_ORDER = {
  verify_agent: ['p_email', 'p_password'],
  get_whatsapp_user: ['p_id'],
  get_worker_agents: ['p_worker_id'],
  create_agent: ['p_email', 'p_password', 'p_name', 'p_role'],
  promote_to_admin: ['p_id'],
  get_station_disposition_stats: ['p_ngo_id', 'p_from', 'p_to'],
  assign_agent_to_worker: ['p_worker_id', 'p_agent_id', 'p_account_id'],
  claim_conversation: ['p_conversation_id', 'p_agent_id'],
  create_whatsapp_user: ['p_id', 'p_email', 'p_name'],
  delete_agent: ['p_id'],
  delete_message: ['p_id'],
  get_agent_workers: ['p_agent_id'],
  list_whatsapp_users: [],
  search_whatsapp_users: ['p_query'],
  search_workers_for_agent: ['p_agent_id', 'p_search'],
  transfer_conversation: ['p_conversation_id', 'p_target_agent_id'],
  unassign_agent_from_worker: ['p_worker_id', 'p_agent_id'],
  handle_new_user: [],
};

async function rpc(fn, args = {}) {
  try {
    const order = RPC_ARG_ORDER[fn];
    const ordered = order ? order.map((k) => (args && k in args ? args[k] : null)) : Object.values(args || {});
    const placeholders = ordered.map((_, i) => `$${i + 1}`).join(', ');

    if (fn === 'get_station_disposition_stats') {
      const { rows } = await pool.query(`SELECT * FROM ${q(fn)}(${placeholders})`, ordered);
      return { data: rows, count: null, error: null };
    }
    if (fn === 'promote_to_admin') {
      await pool.query(`SELECT ${q(fn)}(${placeholders})`, ordered);
      return { data: null, count: null, error: null };
    }

    const { rows } = await pool.query(`SELECT ${q(fn)}(${placeholders}) AS result`, ordered);
    const val = rows.length ? rows[0].result : null;
    return { data: typeof val === 'string' ? JSON.parse(val) : val, count: null, error: null };
  } catch (err) {
    return {
      data: null,
      count: null,
      error: {
        message: err && err.message ? err.message : String(err),
        code: err && err.code ? err.code : 'PGRST202',
        details: err && err.details ? err.details : '',
        hint: err && err.hint ? err.hint : '',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// auth() stub — interim until Phase 5 custom JWT + verify_password
// ---------------------------------------------------------------------------
const auth = {
  async signInWithPassword({ email, password }) {
    const invalid = { data: { user: null, session: null }, error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };
    try {
      const { rows } = await pool.query(
        'SELECT id, email, name, role, is_active, created_at, password_hash FROM users WHERE email = $1',
        [email]
      );
      const user = rows[0];
      if (!user || !user.password_hash) return invalid;
      const { rows: chk } = await pool.query('SELECT (crypt($1, $2) = $2) AS ok', [password, user.password_hash]);
      if (!chk[0].ok) return invalid;
      const publicUser = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        is_active: user.is_active,
        created_at: user.created_at,
        email_confirmed_at: user.created_at,
      };
      const access_token = jwt.sign(
        { id: user.id, email: user.email, role: user.role || 'agent' },
        process.env.JWT_SECRET || 'dev-secret',
        { expiresIn: '100y' }
      );
      return { data: { user: publicUser, session: { access_token, refresh_token: null, expires_at: null } }, error: null };
    } catch (e) {
      return invalid;
    }
  },
  async signUp() {
    return { data: { user: null, session: null }, error: { message: 'Signup is unavailable until Phase 5 (auth migration). Use the agent import flow instead.', code: 'SIGNUP_DISABLED' } };
  },
  async signOut() {
    return { data: { user: null, session: null }, error: null };
  },
  admin: {
    async signOut() {
      return { data: { user: null }, error: null };
    },
  },
};

// ---------------------------------------------------------------------------
// storage() — AWS S3-backed file storage.
// Files are stored in <S3_BUCKET>/<bucket>/<fileName> and exposed as public S3
// object URLs. S3_BUCKET (plus AWS credentials) is required; there is no
// local-filesystem fallback, so uploads fail loudly with a clear message when
// S3 is not configured.
// ---------------------------------------------------------------------------
const safeBucket = (name) => String(name).replace(/[^a-zA-Z0-9._-]/g, '_');

// Multi-account S3 registry: 'head' (dev) and 'upstream' (production).
// Code selects an account via db.storage.from(account, bucket) or
// db.storage.fromAccount(account, bucket). Backward-compatible single-arg
// calls (db.storage.from(bucket)) resolve to the valid account: 'head' if its
// credentials are configured, otherwise the legacy AWS_*/S3_* env pair.
const S3_ACCOUNTS = {
  head: {
    accessKeyId: process.env.HEAD_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.HEAD_AWS_SECRET_ACCESS_KEY,
    bucket: process.env.HEAD_S3_BUCKET,
    region: process.env.HEAD_S3_REGION || 'ap-south-1',
  },
  upstream: {
    accessKeyId: process.env.UPSTREAM_AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.UPSTREAM_AWS_SECRET_ACCESS_KEY,
    bucket: process.env.UPSTREAM_S3_BUCKET,
    region: process.env.UPSTREAM_S3_REGION || 'ap-south-1',
  },
  legacy: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1',
  },
};

const _s3Clients = {};

function getS3Client(account) {
  if (_s3Clients[account]) return _s3Clients[account];
  const cfg = S3_ACCOUNTS[account];
  if (!cfg || !cfg.accessKeyId || !cfg.bucket) return null;
  try {
    const client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
    const entry = { client, region: cfg.region, bucket: cfg.bucket };
    _s3Clients[account] = entry;
    return entry;
  } catch {
    return null;
  }
}

// Legacy single-account client (uses AWS_ACCESS_KEY_ID / S3_BUCKET env pair).
let _s3 = null;
function getS3() {
  if (!process.env.S3_BUCKET) return null;
  if (_s3) return _s3;
  try {
    const region = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
    const s3Config = { region };
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      s3Config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }
    _s3 = { client: new S3Client(s3Config), region, bucket: process.env.S3_BUCKET };
    return _s3;
  } catch {
    return null;
  }
}

const s3Key = (bucket, fileName) => `${safeBucket(bucket)}/${String(fileName)}`;

// GetObjectCommand hands back a stream whose reader API depends on the SDK
// version — newer builds mix in transformToByteArray(), older ones leave a
// plain async-iterable Readable. Prefer the helper when present and fall back to
// draining the stream, so a read never fails over a version difference.
async function s3BodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  if (typeof body.transformToString === 'function') return Buffer.from(await body.transformToString('utf8'));
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const STORAGE_NOT_CONFIGURED = 'S3 storage is not configured. Set S3_BUCKET (and AWS credentials) to enable file uploads.';

// Resolve which named account (or legacy client) a storage call targets.
// db.storage.from('head', 'receipts') / db.storage.from('upstream', 'receipts')
// pick an explicit account; db.storage.from('receipts') falls back to the
// active (head) account when configured, else the legacy AWS_*/S3_* pair.
// The resolved account name is returned so callers that must later read the
// same object back (see services/receiptFileLink.js) do not have to re-derive
// the bucket from env and risk guessing a different one.
function resolveS3(accountOrBucket, maybeBucket) {
  const explicit = maybeBucket != null;
  const account = explicit ? accountOrBucket : null;
  const bucket = explicit ? maybeBucket : accountOrBucket;
  let s3 = null;
  let accountName = null;
  if (account) {
    s3 = getS3Client(account) || (account === 'head' ? getS3() : null);
    accountName = account;
  } else if (getS3Client('head')) {
    s3 = getS3Client('head');
    accountName = 'head';
  } else {
    s3 = getS3();
    accountName = 'legacy';
  }
  return { s3, bucket, accountName };
}

const storage = {
  from(accountOrBucket, maybeBucket) {
    const { s3, bucket, accountName } = resolveS3(accountOrBucket, maybeBucket);
    const b = safeBucket(bucket);
    return {
      // Which configured account this handle writes to. Exposed so a caller can
      // build a link that reads the same object back later.
      accountName: s3 ? accountName : null,
      async upload(fileName, buffer, opts = {}) {
        if (!s3) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
        try {
          await s3.client.send(new PutObjectCommand({
            Bucket: s3.bucket,
            Key: s3Key(b, fileName),
            Body: buffer,
            ContentType: opts.contentType || opts.content_type || undefined,
          }));
          return { data: { path: String(fileName) }, error: null };
        } catch (e) {
          return { data: null, error: { message: e && e.message ? e.message : String(e), code: 'STORAGE_UPLOAD_FAILED' } };
        }
      },
      getPublicUrl(fileName) {
        if (!s3) return { data: { publicUrl: '' } };
        return { data: { publicUrl: `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/${s3Key(b, fileName)}` } };
      },
      // Server-side read of a private object. getPublicUrl() yields an
      // unauthenticated URL that 403s for any bucket not world-readable, so
      // anything the backend needs to re-read (e.g. a certificate template it
      // uploaded itself) has to come through the credentials rather than HTTP.
      async download(fileName) {
        if (!s3) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
        try {
          const res = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: s3Key(b, fileName) }));
          return { data: await s3BodyToBuffer(res.Body), error: null };
        } catch (e) {
          return { data: null, error: { message: e && e.message ? e.message : String(e), code: 'STORAGE_DOWNLOAD_FAILED' } };
        }
      },
      // Same read as download(), but hands back the live stream plus the object's
      // own headers instead of buffering it. The WhatsApp receipt-file endpoint
      // needs Content-Type/Content-Length to answer Meta properly, and streaming
      // avoids holding whole PDFs in memory. Kept separate from download()
      // because buffering would be the wrong default for a streaming caller.
      async readStream(fileName) {
        if (!s3) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
        try {
          const out = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: s3Key(b, fileName) }));
          return { data: { body: out.Body, contentType: out.ContentType, contentLength: out.ContentLength }, error: null };
        } catch (e) {
          return { data: null, error: { message: e && e.message ? e.message : String(e), code: e?.name || 'S3_READ_FAILED' } };
        }
      },
      // Time-limited S3 URL for one object in this handle's bucket.
      //
      // This is what Meta is handed for a HEADER document. Meta fetches that URL
      // itself, from outside this deployment, so it has to be an ordinary public
      // HTTPS GET against infrastructure Meta can already reach -- which rules
      // out a link served by this app (it sits behind Azure Front Door + Caddy
      // and a send pointed at it was accepted by the API yet never delivered).
      //
      // It deliberately runs through s3Key() like every other method here, so it
      // can only ever address the object that upload()/readStream() would. Signing
      // a hand-assembled key is how you get a 404 that looks exactly like "Meta
      // cannot download the file".
      //
      // The bucket stays private: authorization travels in the query string and
      // expires, so no bucket policy, no public ACL and no PublicAccessBlock
      // relaxation are involved.
      async presignDownload(fileName, expiresIn = 3600) {
        if (!s3) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
        try {
          // A non-positive or non-numeric expiry falls back to the default rather than
// clamping down to the 60s floor. Shortening a receipt link to a minute is
// exactly the wrong failure mode: Meta fetches the document asynchronously, and
// a link that expires while it is still queued fails with 131053 and no visible
// cause.
const wanted = Number(expiresIn);
const secs = Math.min(Math.max(Number.isFinite(wanted) && wanted > 0 ? wanted : 3600, 60), 7 * 24 * 60 * 60);
          const url = await getSignedUrl(
            s3.client,
            new GetObjectCommand({ Bucket: s3.bucket, Key: s3Key(b, fileName) }),
            { expiresIn: secs },
          );
          return { data: { url, expiresAt: new Date(Date.now() + secs * 1000).toISOString() }, error: null };
        } catch (e) {
          return { data: null, error: { message: e && e.message ? e.message : String(e), code: 'STORAGE_PRESIGN_FAILED' } };
        }
      },
      async remove(paths) {
        const list = Array.isArray(paths) ? paths : [paths];
        if (!s3) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
        try {
          await Promise.all(list.map((p) => s3.client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: s3Key(b, p) }))));
          return { data: null, error: null };
        } catch (e) {
          return { data: null, error: { message: e && e.message ? e.message : String(e), code: 'STORAGE_REMOVE_FAILED' } };
        }
      },
    };
  },
  fromAccount(account, bucket) {
    return this.from(account, bucket);
  },
  async createBucket(name, opts = {}) {
    const target = opts.account ? getS3Client(opts.account) : (getS3Client('head') || getS3());
    if (!target) return { data: null, error: { message: STORAGE_NOT_CONFIGURED, code: 'STORAGE_NOT_CONFIGURED' } };
    try {
      await target.client.send(new HeadBucketCommand({ Bucket: target.bucket }));
    } catch {
      try {
        await target.client.send(new CreateBucketCommand({
          Bucket: target.bucket,
          ...(target.region !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: target.region } } : {}),
        }));
      } catch (e) {
        return { data: null, error: { message: e && e.message ? e.message : String(e), code: 'STORAGE_BUCKET_FAILED' } };
      }
    }
    return { data: { name: String(name) }, error: null };
  },
  async listBuckets(account) {
    const s3 = account ? getS3Client(account) : (getS3Client('head') || getS3());
    if (!s3) return { data: [], error: null };
    try {
      const r = await s3.client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Delimiter: '/' }));
      const names = (r.CommonPrefixes || []).map((p) => String(p.Prefix || '').replace(/\/$/, ''));
      return { data: names.map((n) => ({ name: n })), error: null };
    } catch (e) {
      return { data: [], error: null };
    }
  },
  // Account registry for the bucket browser: names, regions and the bucket
  // each account points at. Never exposes access keys.
  accounts() {
    return Object.entries(S3_ACCOUNTS).map(([name, cfg]) => ({
      name,
      region: cfg.region,
      bucket: cfg.bucket || null,
      configured: Boolean(cfg.accessKeyId && cfg.bucket),
    }));
  },
  // Raw handle for tooling that needs commands the object API does not wrap —
  // ListBuckets, ListObjectsV2, DeleteObjects, CopyObject. Credential
  // resolution matches from() exactly (an unconfigured 'head' falls back to
  // the legacy AWS_*/S3_* pair), so the bucket browser reads through the same
  // keys the app writes with.
  raw(account) {
    let s3 = null;
    let name = null;
    if (account) {
      s3 = getS3Client(account) || (account === 'head' || account === 'legacy' ? getS3() : null);
      name = account;
    } else if (getS3Client('head')) {
      s3 = getS3Client('head');
      name = 'head';
    } else {
      s3 = getS3();
      name = 'legacy';
    }
    if (!s3) return null;
    return { client: s3.client, bucket: s3.bucket, region: s3.region, account: name };
  },
};

// ---------------------------------------------------------------------------
// Startup connection test — call once after server boots to verify the pool
// can actually reach the database.  Logs a clear message on success/failure.
// ---------------------------------------------------------------------------
async function testConnection() {
  try {
    const res = await pgPool.query('SELECT current_database(), current_user, inet_server_addr() AS server_ip, now() AS server_time');
    const row = res.rows[0];
    console.log(`[DB] Connected to "${row.current_database}" as "${row.current_user}" | server: ${row.server_ip || 'local'} | time: ${row.server_time}`);
    return true;
  } catch (err) {
    console.error(`[DB] CONNECTION FAILED: ${err.message}`);
    console.error(`[DB] DATABASE_URL host: ${process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : 'not set'}`);
    console.error('[DB] Ensure the RDS instance is running and your IP is allowed in the security group.');
    return false;
  }
}

const db = {
  from(table) { return makeQuery(table); },
  async transaction(callback) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStore.run({ client }, async () => {
        return await callback({ from: (table) => makeQuery(table) });
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* connection already dead */ }
      throw err;
    } finally {
      client.release();
    }
  },
  rpc,
  auth,
  storage,
  testConnection,
  _pool: pool,
};

export const sql = async (text, params = []) => {
  const { rows } = await pool.query(text, params);
  return rows;
};

// Named exports of the internals that storage.presignDownload() depends on.
// They exist for tests: the prefixing behaviour below is what silently
// mis-addressed a presigned URL once already, and it is not reachable from the
// outside because from() resolves its client from the environment.
export { storage, s3Key };

export const getTableColumns = async (table) => getColumns(table);

export default db;
