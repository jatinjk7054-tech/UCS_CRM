import { Router } from 'express';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import db from '../config/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Projects live at the repo root (one level above backend/).
const PROJECTS_ROOT = process.env.ENV_ADMIN_ROOT || path.resolve(__dirname, '../../..');

// The project this backend itself runs from — the only one we can compare the
// running process env against.
const SELF_DIR = path.resolve(__dirname, '../..');

// Normalise a value read from a .env line the way dotenv does (strip quotes,
// expand \n/\r/\t in double-quoted values, drop inline comments), so it can be
// compared to the value the running process actually loaded.
function normalizeFileValue(v) {
  let s = String(v == null ? '' : v).trim();
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    s = s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
  } else if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    s = s.slice(1, -1);
  } else {
    s = s.replace(/\s+#.*$/, '').trim();
  }
  return s;
}

const ENV_ADMIN_KEY = process.env.ENV_ADMIN_KEY;
if (!ENV_ADMIN_KEY) {
  console.warn('WARNING: ENV_ADMIN_KEY is not set. Env admin endpoints are OPEN.');
}

const router = Router();

const requireKey = (req, res, next) => {
  if (!ENV_ADMIN_KEY) return next();
  const key = req.headers['x-admin-key'] || req.query.key;
  if (key !== ENV_ADMIN_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
};
router.use(requireKey);

function safeProjectDir(name) {
  const n = String(name || '').trim();
  if (!n || n.includes('/') || n.includes('\\') || n === '.' || n === '..' || n.startsWith('.')) return null;
  return path.join(PROJECTS_ROOT, n);
}

async function isDirectory(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readEnvLines(envPath) {
  try {
    return (await fs.readFile(envPath, 'utf8')).split(/\r?\n/);
  } catch {
    return [];
  }
}

async function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, filePath);
}

// List all project folders under the projects root.
router.get('/projects', async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(PROJECTS_ROOT, e.name);
      let hasEnv = false;
      let envCount = 0;
      let mtime = null;
      const comparable = path.resolve(PROJECTS_ROOT, e.name) === SELF_DIR;
      let needsRestart = false;
      try {
        const lines = await readEnvLines(path.join(dir, '.env'));
        hasEnv = lines.length > 0;
        for (const line of lines) {
          const t = line.trim();
          if (t && !t.startsWith('#') && t.includes('=')) envCount++;
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (comparable && m && normalizeFileValue(m[2]) !== (process.env[m[1]] ?? null)) needsRestart = true;
        }
        mtime = (await fs.stat(path.join(dir, '.env'))).mtime.toISOString();
      } catch {}
      projects.push({ name: e.name, hasEnv, envCount, mtime, comparable, needsRestart });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: PROJECTS_ROOT, projects });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Read every project's .env in one call (for the "View All" screen).
router.get('/all', async (req, res) => {
  try {
    const entries = await fs.readdir(PROJECTS_ROOT, { withFileTypes: true });
    const projects = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const dir = path.join(PROJECTS_ROOT, e.name);
      const envPath = path.join(dir, '.env');
      const lines = await readEnvLines(envPath);
      if (!lines.length) continue;
      const comparable = dir === SELF_DIR;
      const vars = [];
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (m) {
          const deployed = comparable
            ? normalizeFileValue(m[2]) === (process.env[m[1]] ?? null)
            : null;
          const running = comparable ? process.env[m[1]] ?? null : null;
          vars.push({ key: m[1], value: m[2], line: i + 1, deployed, running });
        }
      }
      let mtime = null;
      try { mtime = (await fs.stat(envPath)).mtime.toISOString(); } catch {}
      projects.push({
        name: e.name,
        envPath: envPath.replace(PROJECTS_ROOT, '.'),
        comparable,
        needsRestart: comparable ? vars.some((v) => !v.deployed) : null,
        mtime,
        vars,
        raw: lines.join('\n'),
      });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ root: PROJECTS_ROOT, projects });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Read the .env of a project as key/value pairs.
router.get('/projects/:name/env', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const envPath = path.join(dir, '.env');
    const comparable = dir === SELF_DIR;
    const lines = await readEnvLines(envPath);
    const vars = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) {
        const deployed = comparable
          ? normalizeFileValue(m[2]) === (process.env[m[1]] ?? null)
          : null;
        const running = comparable ? process.env[m[1]] ?? null : null;
        vars.push({ key: m[1], value: m[2], line: i + 1, deployed, running });
      }
    }
    const needsRestart = comparable ? vars.some((v) => !v.deployed) : null;
    res.json({ name: req.params.name, envPath: envPath.replace(PROJECTS_ROOT, '.'), comparable, needsRestart, vars, raw: lines.join('\n') });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Add or update a single variable. Creates .env if it does not exist yet.
router.post('/projects/:name/env', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const key = String((req.body && req.body.key) || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ message: 'Invalid key (A-Z, a-z, 0-9, _ only)' });
    const value = req.body && req.body.value != null ? String(req.body.value) : '';
    if (value.includes('\n') || value.includes('\r')) {
      return res.status(400).json({ message: 'Value cannot contain newlines' });
    }

    const envPath = path.join(dir, '.env');
    const lines = await readEnvLines(envPath);
    const re = new RegExp(`^${escapeRe(key)}\\s*=`);

    let found = false;
    const out = lines.map((line) => {
      if (!found && re.test(line)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) out.push(`${key}=${value}`);

    await atomicWrite(envPath, out.join('\n') + '\n');
    res.json({ ok: true, key, value, updated: found });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a variable from .env.
router.delete('/projects/:name/env/:key', async (req, res) => {
  try {
    const dir = safeProjectDir(req.params.name);
    if (!dir) return res.status(400).json({ message: 'Invalid project name' });
    if (!(await isDirectory(dir))) return res.status(404).json({ message: 'Project not found' });

    const key = String(req.params.key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return res.status(400).json({ message: 'Invalid key' });

    const envPath = path.join(dir, '.env');
    const lines = await readEnvLines(envPath);
    const re = new RegExp(`^${escapeRe(key)}\\s*=`);

    const next = lines.filter((line) => !re.test(line));
    if (next.length === lines.length) return res.status(404).json({ message: `Key "${key}" not found` });

    await atomicWrite(envPath, next.join('\n'));
    res.json({ ok: true, key });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

async function readCpuOnce() {
  const text = await fs.readFile('/proc/stat', 'utf8');
  const parts = text.split('\n')[0].split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + (parts[4] || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function readCpuUsage() {
  try {
    const a = await readCpuOnce();
    await new Promise((r) => setTimeout(r, 500));
    const b = await readCpuOnce();
    const total = b.total - a.total;
    const idle = b.idle - a.idle;
    const usage = total > 0 ? ((total - idle) / total) * 100 : 0;
    return { usagePct: Math.round(usage * 10) / 10, cores: os.cpus().length };
  } catch {
    return { usagePct: null, cores: os.cpus().length };
  }
}

function readMem() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => {
      const m = text.match(new RegExp(`${k}:\\s*(\\d+)`));
      return m ? parseInt(m[1], 10) * 1024 : null;
    };
    const total = get('MemTotal');
    const avail = get('MemAvailable');
    if (total && avail) {
      const used = total - avail;
      return { total, used, free: avail, pct: Math.round((used / total) * 1000) / 10 };
    }
  } catch {}
  const t = os.totalmem();
  const f = os.freemem();
  return { total: t, used: t - f, free: f, pct: Math.round(((t - f) / t) * 1000) / 10 };
}

function readDisk() {
  try {
    const out = execSync(
      'df -Pk --exclude-type=tmpfs --exclude-type=devtmpfs --exclude-type=overlay --exclude-type=sysfs --exclude-type=proc --exclude-type=devpts',
      { encoding: 'utf8', timeout: 5000 }
    );
    return out.trim().split('\n').slice(1).map((l) => {
      const p = l.trim().split(/\s+/);
      if (p.length < 6) return null;
      const [, totalK, usedK, availK, usePct, mount] = p;
      return { mount, total: +totalK * 1024, used: +usedK * 1024, free: +availK * 1024, pct: parseFloat(usePct.replace('%', '')) };
    }).filter((d) => d && d.total >= 1024 * 1024);
  } catch {
    return [];
  }
}

// Server load: CPU, memory, disk, uptime, load average, PM2 processes.
router.get('/system', async (req, res) => {
  try {
    const [cpu, mem, disk, pm2] = await Promise.all([
      readCpuUsage(),
      Promise.resolve(readMem()),
      Promise.resolve(readDisk()),
      (async () => {
        try {
          const j = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 }));
          return j.map((p) => ({
            name: p.name,
            status: (p.pm2_env && p.pm2_env.status) || 'unknown',
            restart_time: (p.pm2_env && p.pm2_env.restart_time) || 0,
            cpu: (p.monit && p.monit.cpu) || 0,
            memory: (p.monit && p.monit.memory) || 0,
            uptime_ms: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
          }));
        } catch {
          return [];
        }
      })(),
    ]);

    res.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime_seconds: Math.round(os.uptime()),
      load_avg: os.loadavg().map((n) => Math.round(n * 100) / 100),
      node: process.version,
      cpu,
      mem,
      disk,
      pm2,
      // This process's own heap breakdown: rss vs the V8 heap we cap in
      // ecosystem.config.cjs (old-space limit) — use it to spot Buffer/native
      // growth that V8 GC can never reclaim.
      proc_mem: process.memoryUsage(),
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Top CPU/memory consumers on the host (one line per PID). Shows things PM2
// does not manage — stray soffice orphans, converters, pg_dump, etc.
router.get('/system/procs', async (req, res) => {
  try {
    const out = execSync(
      "ps -eo pid,ppid,pcpu,pmem,rss,etime,user,comm,args --sort=-rss | head -n 30",
      { encoding: 'utf8', timeout: 8000 }
    );
    const lines = out.trim().split('\n').map((l) => l.replace(/\s+/g, ' ').split(' '));
    const [, ...rows] = lines;
    const procs = rows.map((r) => ({
      pid: Number(r[0]),
      ppid: Number(r[1]),
      pcpu: parseFloat(r[2]),
      pmem: parseFloat(r[3]),
      rss_mb: Math.round((+r[4] / 1024) * 10) / 10,
      etime: r[5],
      user: r[6],
      cmd: r.slice(8).join(' '),
    }));
    res.json({ procs });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Postgres read/write counters. Everything here is read from pg_stat_*, which
// counts CUMULATIVE totals since the last stats reset -- not per-second rates.
// So this samples twice a second apart and diffs, otherwise the panel would show
// a number that only ever climbs and would say nothing about current traffic.
//
// The counters are instance-wide: on RDS they include the production EC2 backend
// too, not just whatever is running locally. `by_app` splits them by
// application_name so you can tell the two apart when that matters.
const RATE_SAMPLE_MS = 1000;

async function readDbCounters() {
  const { rows } = await db._pool.query(`
    SELECT datname,
           xact_commit, xact_rollback,
           blks_read, blks_hit,
           tup_returned, tup_fetched,
           tup_inserted, tup_updated, tup_deleted,
           conflicts, deadlocks,
           temp_files, temp_bytes,
           blk_read_time, blk_write_time
    FROM pg_stat_database
    WHERE datname = current_database()
  `);
  return rows[0] || null;
}

// Per-table breakdown, ordered by the busiest table first. Only tables with
// actual traffic are returned -- an idle CRM has hundreds of tables and listing
// all of them buries the handful that matter.
async function readTableCounters() {
  const { rows } = await db._pool.query(`
    SELECT relname AS table,
           n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd,
           seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
           n_live_tup, n_dead_tup
    FROM pg_stat_user_tables
    WHERE n_tup_ins + n_tup_upd + n_tup_del + seq_scan + idx_scan > 0
    ORDER BY (n_tup_ins + n_tup_upd + n_tup_del) DESC, (seq_scan + idx_scan) DESC
    LIMIT 25
  `);
  return rows;
}

async function readByApp() {
  try {
    // pg_stat_activity has no xact_commit/row counters -- those only exist in
    // pg_stat_database. It does expose state and wait_event, which is what makes
    // a stuck connection visible here. Ordering by the query text length is a
    // stand-in for "interesting first" since there is nothing to rank on.
    const { rows } = await db._pool.query(`
      SELECT COALESCE(NULLIF(application_name, ''), '(unnamed)') AS app,
             COALESCE(client_addr::text, 'local') AS client,
             count(*) AS conns,
             count(*) FILTER (WHERE state = 'idle in transaction') AS stuck,
             count(*) FILTER (WHERE wait_event_type IS NOT NULL AND state = 'active') AS waiting,
             max(EXTRACT(EPOCH FROM (now() - state_change))) FILTER (WHERE state = 'idle in transaction') AS oldest_idle_s
      FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND datname = current_database()
      GROUP BY 1, 2
      ORDER BY conns DESC, stuck DESC
      LIMIT 15
    `);
    return rows;
  } catch {
    // pg_stat_activity hides other sessions' text on managed Postgres for a
    // non-owner role. The panel should still show the rest of the section.
    return [];
  }
}

function rate(now, before, ms) {
  // Coerce explicitly: pg_stat counters are int8, and while db.js registers a
  // parser for that, blk_*_time is float8 which comes back as a string. String
  // minus string coerces to number in JS, but subtracting a number from a string
  // with `+` would concatenate, so normalise once here.
  const n = v => Number(v || 0);
  const perSec = (a, b) => Math.max(0, Math.round((n(a) - n(b)) / (ms / 1000)));
  return {
    reads: perSec(n(now.tup_returned) + n(now.tup_fetched), n(before.tup_returned) + n(before.tup_fetched)),
    inserts: perSec(now.tup_inserted, before.tup_inserted),
    updates: perSec(now.tup_updated, before.tup_updated),
    deletes: perSec(now.tup_deleted, before.tup_deleted),
    commits: perSec(now.xact_commit, before.xact_commit),
    rollbacks: perSec(now.xact_rollback, before.xact_rollback),
    blocksRead: perSec(now.blks_read, before.blks_read),
  };
}

router.get('/db', async (req, res) => {
  try {
    const before = await readDbCounters();
    if (!before) return res.status(500).json({ message: 'No stats row for the current database' });
    await new Promise((r) => setTimeout(r, RATE_SAMPLE_MS));
    const now = await readDbCounters();

    const [tables, byApp] = await Promise.all([readTableCounters(), readByApp()]);

    const blksRead = Number(now.blks_read || 0);
    const blksHit = Number(now.blks_hit || 0);
    const hits = blksRead + blksHit;

    res.json({
      database: now.datname,
      sampled_ms: RATE_SAMPLE_MS,
      per_sec: rate(now, before, RATE_SAMPLE_MS),
      totals: {
        reads: Number(now.tup_returned || 0) + Number(now.tup_fetched || 0),
        inserts: Number(now.tup_inserted || 0),
        updates: Number(now.tup_updated || 0),
        deletes: Number(now.tup_deleted || 0),
        commits: Number(now.xact_commit || 0),
        rollbacks: Number(now.xact_rollback || 0),
        blocks_read: blksRead,
        blocks_hit: blksHit,
        conflicts: Number(now.conflicts || 0),
        deadlocks: Number(now.deadlocks || 0),
        temp_files: Number(now.temp_files || 0),
        temp_bytes: Number(now.temp_bytes || 0),
      },
      // A low cache ratio means queries keep going to disk. This is the single
      // most useful number here when the DB feels slow.
      cache_hit_pct: hits > 0 ? Math.round((blksHit / hits) * 1000) / 10 : null,
      read_ms: now.blk_read_time || 0,
      write_ms: now.blk_write_time || 0,
      tables,
      by_app: byApp,
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Live lock state, plus the settings that decide whether a future deadlock is
// diagnosable at all.
//
// IMPORTANT: Postgres does not store deadlock DETAILS. pg_stat_database.deadlocks
// is a bare counter -- which two transactions collided, and on which rows, exists
// only in the server log. A query cannot recover a deadlock that already fired.
// What this endpoint can do is show the contention happening RIGHT NOW (locks
// waiting on other locks) and report whether the settings are in place to capture
// the next one.
router.get('/db/deadlocks', async (req, res) => {
  try {
    // Locks that have NOT been granted are the ones actually blocked. Granted
    // locks are just the ordinary noise every session holds (AccessShare on the
    // catalog tables and so on), so filtering on granted = false is what makes
    // this read as "who is stuck", not "what is running".
    const { rows: blocked } = await db._pool.query(`
      SELECT l.pid,
             a.application_name,
             a.state,
             a.wait_event_type,
             a.wait_event,
             EXTRACT(EPOCH FROM (now() - a.query_start)) AS running_s,
             left(a.query, 400) AS query,
             l.mode AS waiting_mode,
             COALESCE(l.relation::regclass::text, '') AS waiting_on,
             blocker.pid AS blocked_by,
             left(blocker.query, 400) AS blocker_query
      FROM pg_locks l
      JOIN pg_stat_activity a ON a.pid = l.pid
      LEFT JOIN pg_stat_activity blocker
        ON blocker.pid = ANY(pg_blocking_pids(l.pid))
      WHERE NOT l.granted AND a.datname = current_database()
      ORDER BY running_s DESC NULLS LAST
      LIMIT 25
    `);

    const { rows: settings } = await db._pool.query(`
      SELECT name, setting, unit FROM pg_settings
      WHERE name IN ('log_lock_waits', 'deadlock_timeout', 'lock_timeout', 'log_min_messages', 'log_line_prefix')
      ORDER BY name
    `);

    const { rows: dbRow } = await db._pool.query(`
      SELECT deadlocks, conflicts, stats_reset FROM pg_stat_database WHERE datname = current_database()
    `);

    const settingMap = Object.fromEntries(settings.map((s) => [s.name, s.setting]));

    res.json({
      // Without log_lock_waits the server writes nothing when a session waits on
      // a lock, so the next deadlock will be as undiagnosable as this one.
      can_diagnose_future: settingMap.log_lock_waits === 'on',
      log_lock_waits: settingMap.log_lock_waits || 'unknown',
      deadlock_timeout_ms: Number(settingMap.deadlock_timeout || 0),
      lock_timeout_ms: Number(settingMap.lock_timeout || 0),
      deadlocks_total: Number(dbRow[0] ? dbRow[0].deadlocks : 0),
      stats_reset: dbRow[0] ? dbRow[0].stats_reset : null,
      blocked_now: blocked,
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// What is making the site hang right now.
//
// The important number is NOT the query count but how many of the app's 5 pool
// connections are busy. db.js caps the pool at max:5, so the FIFTH concurrent
// slow query does not degrade gracefully -- it makes every other request in the
// app wait for a free connection. That is what presents to a user as "the
// website keeps loading" on a perfectly fast network.
//
// A single snapshot misses queries that ran and finished between polls, so this
// also keeps a short rolling history of the slowest queries seen, deduplicated by
// their normalised text. SLOW_QUERY_MS decides what counts as slow.
const SLOW_QUERY_MS = 1000;
const HISTORY_LIMIT = 25;
const HISTORY_TTL_MS = 60000;
const recentSlow = new Map();

// Append-only event log. The user's symptom is "it shows blocked and then it
// vanishes" -- which is inherent to polling: a block that clears between two
// 5s samples is invisible. Polling cannot fix that, so anything worth seeing is
// also written here and kept, deduplicated so one stuck query does not produce
// one line per sample.
const EVENTS_LIMIT = 200;
const events = [];
const eventSeen = new Map(); // dedupe key -> last logged ms

function logEvent(key, severity, message, extra) {
  const now = Date.now();
  const last = eventSeen.get(key) || 0;
  // Once a minute per distinct condition is enough to show a pattern without
  // drowning the log in the same line 12 times.
  if (now - last < 60000) return;
  eventSeen.set(key, now);
  events.unshift({ at: new Date(now).toISOString(), severity, message, extra: extra || null });
  if (events.length > EVENTS_LIMIT) events.length = EVENTS_LIMIT;
}

// The app's configured pool size, read from the env the same way db.js reads it,
// so the panel cannot drift out of sync with reality.
const APP_POOL_MAX = Math.max(1, parseInt(process.env.PG_POOL_MAX || '5', 10));

function normalizeQuery(sql) {
  // Strip literals so 50 different receipt ids collapse into one entry.
  return String(sql || '')
    .replace(/\$\d+/g, '$?')
    .replace(/'[^']*'/g, "'?'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

// Read every non-idle session with how long it has been running, plus where the
// connection came from so you can tell a real user's query from the local tunnel.
async function readActiveQueries() {
  const { rows } = await db._pool.query(`
    SELECT a.pid,
           a.state,
           COALESCE(NULLIF(a.application_name, ''), '(unnamed)') AS app,
           COALESCE(a.client_addr::text, 'local socket') AS client,
           a.backend_start,
           EXTRACT(EPOCH FROM (now() - a.query_start)) AS dur_s,
           EXTRACT(EPOCH FROM (now() - a.state_change)) AS state_s,
           a.wait_event_type,
           a.wait_event,
           a.backend_xid IS NOT NULL AS in_xact,
           left(a.query, 500) AS query,
           -- Tag this panel's own statements so the UI can exclude them. Without
           -- this the observer shows up in its own load numbers and can starve
           -- the pool it is trying to measure.
           a.query LIKE 'SELECT datname,%pg_stat_database%'
            OR a.query LIKE 'SELECT state, count(*)%pg_stat_activity%'
            OR a.query LIKE 'SELECT a.pid,%pg_blocking_pids%'
            OR a.query LIKE 'SELECT COALESCE(client_addr%'
            OR a.query LIKE 'SELECT COALESCE(NULLIF(application_name%'
            OR a.query LIKE 'SELECT locktype%'
            OR a.query LIKE 'SELECT name, setting, unit%pg_settings%'
            OR a.query LIKE 'SELECT name, size, setting%pg_settings%'
            OR a.query LIKE 'SELECT stats_reset%'
            OR a.query LIKE 'SELECT current_setting(%' AS is_panel,
           (SELECT count(*) FROM pg_blocking_pids(a.pid)) > 0 AS blocked,
           COALESCE((SELECT string_agg(b.query, ' <- ' ORDER BY b.pid)
                     FROM pg_stat_activity b
                     WHERE b.pid = ANY(pg_blocking_pids(a.pid))), '') AS blocker_query
    FROM pg_stat_activity a
    WHERE a.datname = current_database()
      AND a.pid <> pg_backend_pid()
      AND a.state <> 'idle'
    ORDER BY dur_s DESC NULLS LAST
    LIMIT 30
  `);
  return rows.map((r) => {
    const durS = Number(r.dur_s || 0);
    const text = normalizeQuery(r.query);
    const wait = [r.wait_event_type, r.wait_event].filter(Boolean).join(' ') || null;
    if (r.state === 'active' && durS * 1000 >= SLOW_QUERY_MS) {
      const prev = recentSlow.get(text);
      // Keep the WORST run seen, not the latest, so a query that was slow once
      // stays visible instead of being replaced by its fast reruns.
      recentSlow.set(text, {
        query: String(r.query || '').slice(0, 500),
        normalized: text,
        max_s: prev ? Math.max(prev.max_s, durS) : durS,
        last_s: durS,
        seen: new Date().toISOString(),
        client: r.client,
        blocked: r.blocked,
        wait,
      });
      logEvent('slow:' + text, durS >= 5 ? 'danger' : 'warn',
        `Slow query ${durS.toFixed(1)}s from ${r.client}`,
        { query: String(r.query || '').slice(0, 300), client: r.client });
    }
    // A session is only genuinely blocked when pg_blocking_pids() is non-empty.
    // Checking wait_event_type='Lock' alone is wrong: it also matches
    // lock-RELATED events that are not waits on another session, and it counted
    // the panel's own short probes as blocks.
    if (r.blocked && durS >= 0.05) {
      logEvent('blocked:' + r.pid, 'danger',
        `Session ${r.pid} blocked on a lock for ${durS.toFixed(2)}s (from ${r.client})`,
        { query: String(r.query || '').slice(0, 300), blocker: String(r.blocker_query || '').slice(0, 300), client: r.client });
    }
    return {
      pid: r.pid,
      state: r.state,
      app: r.app,
      client: r.client,
      backend_start: r.backend_start,
      dur_s: durS,
      state_s: Number(r.state_s || 0),
      wait,
      blocked: r.blocked,
      is_panel: r.is_panel,
      in_xact: r.in_xact,
      query: String(r.query || '').slice(0, 500),
      blocker_query: r.blocker_query || null,
    };
  });
}

// Every connection the app is holding right now, with its origin. This is the
// "where is the read coming from" view: client_addr separates real users from
// your local SSH tunnel and from the panel's own probes.
router.get('/db/clients', async (req, res) => {
  try {
    const { rows } = await db._pool.query(`
      SELECT COALESCE(client_addr::text, 'local socket') AS client,
             COALESCE(NULLIF(application_name, ''), '(unnamed)') AS app,
             state,
             count(*)::int AS conns,
             max(EXTRACT(EPOCH FROM (now() - state_change))) AS idle_s,
             max(EXTRACT(EPOCH FROM (now() - query_start))) AS running_s,
             min(backend_start) AS oldest_conn
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY 1, 2, 3
      ORDER BY conns DESC, 1
      LIMIT 40
    `);
    res.json({ clients: rows, now: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get('/db/queries', async (req, res) => {
  try {
    const [active, byState] = await Promise.all([
      readActiveQueries(),
      db._pool.query(`
        SELECT state, count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
      `).then((r) => r.rows),
    ]);

    // The panel's own sessions are excluded (is_panel below). Otherwise its 5s
    // poll shows up as load and can even saturate the very pool it is trying to
    // measure -- an observer inflating what it observes.
    const busy = active.filter((a) => a.state === 'active' && !a.is_panel).length;
    if (busy >= APP_POOL_MAX) {
      logEvent('pool:saturated', 'danger',
        `Pool saturated: ${busy}/${APP_POOL_MAX} connections busy — every other request is queued`);
    }

    const now = Date.now();
    const history = [...recentSlow.values()]
      .filter((e) => now - Date.parse(e.seen) < HISTORY_TTL_MS)
      .sort((a, b) => b.max_s - a.max_s)
      .slice(0, HISTORY_LIMIT);

    res.json({
      active,
      by_state: byState,
      pool: {
        app_max: APP_POOL_MAX,
        busy,
        // At the cap, every other request waits for a free connection. That is
        // the exact symptom of "site keeps loading on a fast network".
        saturated: busy >= APP_POOL_MAX,
      },
      slow_history: history,
      slow_query_ms: SLOW_QUERY_MS,
      events,
      now: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Trigger a backend restart so .env changes take effect. The restart is fired
// as a detached child (with a short delay) so the response is sent before the
// current process is killed. Also kills any orphaned LibreOffice (soffice)
// processes — those are not PM2 children, so a plain restart never reclaimed
// them and they could chew hundreds of MB of RAM each.
router.post('/restart', async (req, res) => {
  try {
    const child = spawn('sh', ['-c', 'pkill -f soffice.bin; sleep 2 && pm2 restart backend --update-env'], {
      detached: true,
      stdio: 'ignore',
      cwd: PROJECTS_ROOT,
    });
    child.unref();
    res.json({ ok: true, message: 'Backend restart triggered. Reconnecting…' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
