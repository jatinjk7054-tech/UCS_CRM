// froTimeSessions — the write/read layer for the authoritative interval ledger.
//
// This is the ONLY module that writes fro_time_sessions. Every state change in
// the app funnels through transition(), which:
//
//   1. locks the worker's open interval (so concurrent events serialize),
//   2. no-ops when the requested state is already open (idempotent),
//   3. closes the open interval, then opens the next one in one transaction.
//
// The database enforces the rest: at most one open interval per worker (partial
// unique index) and no overlapping intervals (exclusion constraint). If an
// invariant is ever about to be violated the insert fails loudly instead of
// silently double-counting seconds.
import db from '../config/db.js';
import {
  isKnownState,
  resolveEventState,
  sumIntervalsByState,
  istDayBoundsMs,
  isIdleState,
} from '../utils/froTimeState.js';

const IDLE_SET = new Set(['IDLE', 'SLEEPING', 'HIDDEN']);

const OPEN_SESSION_UNIQUE = 'uq_fro_time_sessions_open_per_worker';

function toIso(ms) {
  return new Date(ms).toISOString();
}

function durationSecondsBetween(startMs, endMs) {
  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

/**
 * Move a worker to `state`, closing the currently-open interval.
 *
 * Idempotent: replaying the same event (socket retry, double click, duplicate
 * disposition) while the target state is already open returns changed:false and
 * writes nothing.
 *
 * `atMs` is a SERVER timestamp. Callers must never pass a client Date.now().
 */
export async function transition(workerId, state, { atMs = Date.now(), reason = null, sessionId = null, pool = db._pool, fromState = null, agentId = null } = {}) {
  if (!workerId) throw new Error('transition: workerId is required');
  if (!isKnownState(state)) throw new Error(`transition: unknown time state "${state}"`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, session_id, state, started_at, agent_id
         FROM fro_time_sessions
        WHERE worker_id = $1 AND ended_at IS NULL
        FOR UPDATE`,
      [workerId]
    );
    const open = rows[0];
    const agent = agentId == null || agentId === '' ? null : String(agentId);

    // An agent taking over a row that already has an open interval: the interval
    // opened while the FRO was working must not silently swallow the agent's time
    // too. Stamping it claims the remainder for the agent, so the FRO's own totals
    // stop at the moment the cover began. Idempotent — already stamped is a no-op.
    if (open && agent && !open.agent_id) {
      await client.query(`UPDATE fro_time_sessions SET agent_id = $2, updated_at = now() WHERE id = $1`, [open.id, agent]);
    }

    // Conditional transition (compare-and-set). A caller that decided to move
    // the worker based on a state it read OUTSIDE this lock passes fromState; if
    // a concurrent writer changed the open state in the meantime the write is
    // skipped instead of clobbering it. Used by deadline reconciliation so a
    // MEETING/PAUSE that landed between the read and the write is never
    // overwritten by a stale IDLE decision.
    if (fromState && (!open || open.state !== fromState)) {
      await client.query('COMMIT');
      return { changed: false, state, skipped: true };
    }

    if (open && open.state === state) {
      await client.query('COMMIT');
      return { changed: false, state, sessionId: open.session_id, id: open.id };
    }

    if (open) {
      const startedMs = new Date(open.started_at).getTime();
      const endMs = Math.max(atMs, startedMs);
      await client.query(
        `UPDATE fro_time_sessions
            SET ended_at = $2, duration_seconds = $3, updated_at = now()
          WHERE id = $1`,
        [open.id, toIso(endMs), durationSecondsBetween(startedMs, endMs)]
      );
    }

    const effectiveSessionId = sessionId || open?.session_id || null;
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO fro_time_sessions (worker_id, session_id, state, started_at, reason, agent_id, updated_at)
         VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6, now())
         RETURNING id, session_id`,
        [workerId, effectiveSessionId, state, toIso(atMs), reason, agent]
      );
    } catch (insErr) {
      // Defensive: if a concurrent writer somehow opened a same-state interval
      // between our lock release and insert (it cannot with FOR UPDATE, but the
      // cost of being wrong is double-counted time), treat a unique violation as
      // "already in that state" rather than failing the caller's real work.
      if (insErr.code === '23505' && String(insErr.constraint || '').includes(OPEN_SESSION_UNIQUE)) {
        await client.query('ROLLBACK');
        return { changed: false, state };
      }
      throw insErr;
    }

    await client.query('COMMIT');
    return { changed: true, state, sessionId: inserted.rows[0].session_id, id: inserted.rows[0].id };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Apply a named time event (MEETING_START, PAGE_HIDDEN, …) to a worker.
 *
 * The current state is read from the open interval. If the event is not
 * actionable from that state — e.g. a PAGE_HIDDEN arriving during a meeting — the
 * held state wins and nothing changes.
 */
export async function applyEvent(workerId, event, { atMs = Date.now(), reason = null, currentState = null, pool = db._pool, agentId = null } = {}) {
  const open = await getOpenSession(workerId, { pool });
  const cur = currentState || open?.state || null;
  const next = resolveEventState(cur, event);
  if (!next) return { changed: false, state: cur };
  return transition(workerId, next, { atMs, reason: reason || event, pool, agentId });
}

/** Close the worker's open interval without opening a new one. */
export async function closeOpenSession(workerId, { atMs = Date.now(), reason = null, pool = db._pool } = {}) {
  if (!workerId) return { changed: false };
  const { rowCount } = await pool.query(
    `UPDATE fro_time_sessions
        SET ended_at = $2,
            duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - started_at))))::int,
            reason = COALESCE($3, reason),
            updated_at = now()
      WHERE worker_id = $1 AND ended_at IS NULL`,
    [workerId, toIso(atMs), reason]
  );
  return { changed: rowCount > 0 };
}

/** The worker's currently-open interval, or null. */
export async function getOpenSession(workerId, { pool = db._pool } = {}) {
  const { rows } = await pool.query(
    `SELECT id, session_id, state, started_at, reason, agent_id
       FROM fro_time_sessions
      WHERE worker_id = $1 AND ended_at IS NULL
      LIMIT 1`,
    [workerId]
  );
  return rows[0] || null;
}

/**
 * Close an interval that is still open from a PREVIOUS IST day, ending it at that
 * day's end rather than at the moment the worker finally shows up.
 *
 * WHY. A panel closed overnight leaves HIDDEN/IDLE open indefinitely. Every read
 * then clips it to today's window, so the FRO is billed idle for the hours between
 * their shift start and their login — before they were at their desk at all. The
 * read clamp (clampIdleToFirstPresence) hides the symptom; this removes the cause
 * for everyone from the next day on. Cross-midnight shifts are unaffected: their
 * interval legitimately spans midnight and is re-armed by this call only on the
 * NEXT day's first beat.
 */
export async function closeSessionOpenedBeforeDay(workerId, { nowMs = Date.now(), pool = db._pool } = {}) {
  if (!workerId) return { changed: false };
  const day = istDayBoundsMs(nowMs);
  const { rowCount } = await pool.query(
    `UPDATE fro_time_sessions
        SET ended_at = $3,
            duration_seconds = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($3::timestamptz - started_at))))::int,
            reason = COALESCE(reason, 'day_boundary'),
            updated_at = now()
      WHERE worker_id = $1
        AND ended_at IS NULL
        AND started_at < $2`,
    [workerId, toIso(day.startMs), toIso(day.startMs)]
  );
  return { changed: rowCount > 0 };
}

/**
 * Pick the half of a worker's day that belongs to one actor.
 *
 * `agentId` of null/undefined means "the FRO's own time": only intervals with no
 * agent stamp. A string means "this agent's time": only stamped intervals. That is
 * the whole of the attribution rule, and it lives here so no reader can invent a
 * second interpretation.
 *
 * Exported for testing; the SQL mirrors it for the batch path.
 */
export function sessionsForActor(sessions, agentId = null) {
  const rows = sessions || [];
  const want = agentId == null || agentId === '' ? null : String(agentId);
  if (want === null) return rows.filter((s) => s.agent_id == null || s.agent_id === '');
  return rows.filter((s) => s.agent_id != null && String(s.agent_id) === want);
}

/**
 * All intervals that touch the IST calendar day `dateStr` ('YYYY-MM-DD'), oldest
 * first. An interval that started the previous day but is still open
 * (cross-midnight shift) is included and clipped by sumIntervalsByState.
 *
 * LATE-LOGIN CLAMP. An IDLE/SLEEPING/HIDDEN interval that began on an earlier day
 * and was never closed (the panel was closed overnight, or the machine was off)
 * used to bill the FRO for the whole gap between their shift start and the moment
 * they actually logged in — 30 minutes of "idle" for somebody who had not yet
 * arrived. Idle before first presence is not idle: it is nobody being there.
 * So leading idle intervals that start before this day's first WORKING (or held)
 * interval are treated as beginning at that first presence instead.
 *
 * `agentId` selects which half of the day to return — see sessionsForActor.
 */
export async function getSessionsForDate(workerId, dateStr, { pool = db._pool, agentId = null } = {}) {
  const startMs = new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  const sessions = await getSessionsInRange(workerId, startMs, endMs, { pool });
  return clampIdleToFirstPresence(sessionsForActor(sessions, agentId), startMs);
}

// Exported for the batch reader, which must apply the identical rule or the admin
// board and the FRO's own strip would disagree about a late login.
export function clampIdleToFirstPresence(sessions, dayStartMs) {
  const rows = sessions || [];
  if (rows.length < 2) return rows;

  // First moment of this day the worker was demonstrably on the panel.
  let presenceMs = NaN;
  for (const s of rows) {
    if (IDLE_SET.has(s.state)) continue;
    const startMs = new Date(s.started_at).getTime();
    if (Number.isFinite(startMs) && startMs >= dayStartMs) { presenceMs = startMs; break; }
  }
  if (!Number.isFinite(presenceMs)) return rows;

  // Nothing to clamp when the worker was never present today: a still-open
  // overnight idle interval is the only row, and the caller must not invent a
  // presence for it.
  return rows.map((s) => {
    if (!IDLE_SET.has(s.state)) return s;
    const startMs = new Date(s.started_at).getTime();
    if (!Number.isFinite(startMs) || startMs >= presenceMs) return s;
    return { ...s, started_at: toIso(presenceMs) };
  });
}

/**
 * All intervals that overlap the half-open window [fromMs, toMs), oldest first.
 *
 * An interval is included when it starts before the window ends and ends after
 * the window begins, so an interval that straddles `fromMs` — or is still open —
 * is returned and must be clipped by the caller (sumIntervalsByState, or the
 * per-IST-day splitter in froTimeReport). This is the read the historical idle
 * reports are built on.
 */
export async function getSessionsInRange(workerId, fromMs, toMs, { pool = db._pool } = {}) {
  const { rows } = await pool.query(
    `SELECT id, session_id, state, started_at, ended_at, duration_seconds, reason, agent_id
       FROM fro_time_sessions
      WHERE worker_id = $1
        AND started_at < $3
        AND COALESCE(ended_at, 'infinity'::timestamptz) > $2
      ORDER BY started_at ASC`,
    [workerId, toIso(fromMs), toIso(toMs)]
  );
  return rows;
}

/** All intervals that touch the IST day containing `nowMs`, oldest first. */
export async function getSessionsForDay(workerId, { nowMs = Date.now(), pool = db._pool, agentId = null } = {}) {
  const day = istDayBoundsMs(nowMs);
  return getSessionsForDate(workerId, day.day, { pool, agentId });
}

/**
 * Per-state totals for a specific IST date, from the ledger, plus whether the
 * ledger had any rows for it. Callers that keep a legacy derived value should
 * prefer these totals only when `hasLedger` is true, so a pre-migration panel
 * does not read as an authoritative zero.
 *
 * `agentId` picks the actor's half of the day; the default is the FRO's own.
 */
export async function dayTotalsForDate(workerId, dateStr, { shift = null, pool = db._pool, agentId = null } = {}) {
  const sessions = await getSessionsForDate(workerId, dateStr, { pool, agentId });
  const startMs = new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
  const totals = sumIntervalsByState(sessions, {
    shift,
    nowMs: Date.now(),
    dayBounds: { startMs, endMs: startMs + 24 * 60 * 60 * 1000, day: dateStr },
  });
  return { hasLedger: sessions.length > 0, totals };
}

/**
 * Derived "today" totals for a worker, from the authoritative intervals. This is
 * what every reader (status endpoint, dashboards, screens) must call — do not
 * recompute idle anywhere else.
 */
export async function computeWorkerDayTotals(workerId, { shift = null, nowMs = Date.now(), pool = db._pool, agentId = null } = {}) {
  const sessions = await getSessionsForDay(workerId, { nowMs, pool, agentId });
  return sumIntervalsByState(sessions, { shift, nowMs });
}

/**
 * Batch version of computeWorkerDayTotals for dashboards: one query for many
 * workers. Returns Map(workerId -> totals) only for workers that have ledger
 * rows today, so callers can fall back to the legacy live-row value otherwise.
 */
export async function dayTotalsForWorkers(workerIds, { shiftFor = () => null, nowFor = () => null, agentFor = () => null, nowMs = Date.now(), pool = db._pool } = {}) {
  const ids = [...new Set((workerIds || []).filter(Boolean).map(String))];
  const out = new Map();
  if (ids.length === 0) return out;
  const day = istDayBoundsMs(nowMs);
  const { rows } = await pool.query(
    `SELECT worker_id, state, started_at, ended_at, agent_id
       FROM fro_time_sessions
      WHERE worker_id::text = ANY($1::text[])
        AND started_at < $3
        AND COALESCE(ended_at, 'infinity'::timestamptz) > $2
      ORDER BY started_at ASC`,
    [ids, toIso(day.startMs), toIso(day.endMs)]
  );
  const byWorker = new Map();
  for (const r of rows) {
    const k = String(r.worker_id);
    if (!byWorker.has(k)) byWorker.set(k, []);
    byWorker.get(k).push(r);
  }
  for (const [k, sessions] of byWorker) {
    const cut = nowFor(k);
    const at = Number.isFinite(cut) ? Math.min(cut, nowMs) : nowMs;
    const own = sessionsForActor(sessions, agentFor(k));
    out.set(k, sumIntervalsByState(clampIdleToFirstPresence(own, day.startMs), { shift: shiftFor(k), nowMs: at, dayBounds: day }));
  }
  return out;
}

/** Map key for a (covered worker, agent) pair. Both halves matter — see below. */
export const agentTotalKey = (workerId, agentId) => `${String(workerId)}::${String(agentId)}`;

/**
 * Today's idle totals for the person at the keyboard on a covered FRO, keyed by
 * (coveredWorkerId, agentId). One query for every live cover on a board.
 *
 * An agent has no row in `workers` — that is why their time is stamped on the
 * covered FRO's intervals in the first place — so this is the only way to ask the
 * ledger "how much idle has the person actually running this queue run up today".
 * The admin board needs it to show, on a covered FRO's row, the figure belonging
 * to whoever is really working it, which is what that FRO's own strip shows them.
 *
 * Keyed by BOTH halves, not by agent alone, and it matters:
 *
 *   - By worker, because the strip reads the agent's rows filtered to the FRO being
 *     worked. One agent covering two FROs has rows against both; summing by agent
 *     would print their combined total on each of the two rows, so each row would
 *     read higher than the panel in front of them.
 *   - By shift, because the strip clamps that FRO's shift window. With no shift
 *     passed in, idle running past shift end would be counted on the board and
 *     clipped on the strip — the board would quietly disagree by exactly those
 *     minutes, which is the very symptom this reader exists to remove.
 */
export async function dayTotalsForAgents(pairs, { shiftFor = () => null, nowMs = Date.now(), pool = db._pool } = {}) {
  const wanted = [...new Map(
    (pairs || [])
      .filter((p) => p && p.workerId != null && p.agentId != null)
      .map((p) => [agentTotalKey(p.workerId, p.agentId), p])
  ).values()];
  const out = new Map();
  if (wanted.length === 0) return out;
  const workerIds = wanted.map((p) => String(p.workerId));
  const agentIds = wanted.map((p) => String(p.agentId));
  const day = istDayBoundsMs(nowMs);
  const { rows } = await pool.query(
    `SELECT worker_id, agent_id, state, started_at, ended_at
       FROM fro_time_sessions
      WHERE (worker_id::text, agent_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        AND started_at < $4
        AND COALESCE(ended_at, 'infinity'::timestamptz) > $3
      ORDER BY started_at ASC`,
    [workerIds, agentIds, toIso(day.startMs), toIso(day.endMs)]
  );
  const byPair = new Map();
  for (const r of rows) {
    const k = agentTotalKey(r.worker_id, r.agent_id);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  for (const p of wanted) {
    const k = agentTotalKey(p.workerId, p.agentId);
    const sessions = byPair.get(k) || [];
    // The same first-presence clamp the worker readers use: an interval left open
    // overnight must not bill an agent for hours before they started.
    const clamped = clampIdleToFirstPresence(sessions, day.startMs);
    // Same shift window the strip applies, so the two cannot drift apart.
    out.set(k, sumIntervalsByState(clamped, { shift: shiftFor(p.workerId), nowMs, dayBounds: day }).idle_seconds);
  }
  return out;
}

export const __internal = { durationSecondsBetween };
