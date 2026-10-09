// froTimeReport — historical idle reporting over the authoritative interval
// ledger (fro_time_sessions).
//
// WHY THIS IS SEPARATE FROM froTimeStatus
// ---------------------------------------
// froTimeStatus answers "what state is this worker in RIGHT NOW, and how much
// have they worked/idled TODAY" — a single IST day. Reporting answers a different
// question: "how much idle time did this worker accrue across a date range",
// which requires splitting intervals at IST midnights (and month boundaries) so a
// session that runs 23:58 -> 00:12 is billed 2 minutes to one day and 12 to the
// next, not all 14 to whichever day it started.
//
// The pure splitter below is the single place that rule lives. The DB wrappers
// only fetch intervals and hand them to it, so a report can never invent its own
// day attribution. fro_daily_stats is NOT read here: it is a GREATEST()-monotonic
// cache and is never the source of truth for history.
import db from '../config/db.js';
import {
  ALL_TIME_STATES,
  TIME_STATES,
  WORKED_STATES,
  IDLE_STATES,
  istDateStr,
} from '../utils/froTimeState.js';
import { getSessionsInRange, sessionsForActor, clampIdleToFirstPresence } from './froTimeSessions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Epoch ms of IST midnight for 'YYYY-MM-DD'. */
export function istMidnightMs(dateStr) {
  return new Date(`${dateStr}T00:00:00.000+05:30`).getTime();
}

/** [startMs, endMs) covering the inclusive IST date range `from`..`to`. */
export function istDayRangeToMs(fromDate, toDate) {
  const fromMs = istMidnightMs(fromDate);
  const toMs = istMidnightMs(toDate) + DAY_MS;
  return { fromMs, toMs };
}

function emptyPerState() {
  return Object.fromEntries(ALL_TIME_STATES.map((s) => [s, 0]));
}

function summarize(perState) {
  return {
    ...perState,
    worked_seconds: WORKED_STATES.reduce((a, s) => a + perState[s], 0),
    idle_seconds: IDLE_STATES.reduce((a, s) => a + perState[s], 0),
    meeting_seconds: perState[TIME_STATES.MEETING],
    pause_seconds: perState[TIME_STATES.PAUSED],
    internet_problem_seconds: perState[TIME_STATES.INTERNET_PROBLEM],
    sleep_hidden_seconds: perState[TIME_STATES.SLEEPING] + perState[TIME_STATES.HIDDEN],
    off_shift_seconds: perState[TIME_STATES.OFF_SHIFT],
  };
}

/**
 * Split one interval into per-IST-day segments clipped to [fromMs, toMs).
 *
 * An open interval (ended_at null) is clipped at `nowMs`, so a report never
 * invents an end for a session that is still running — it simply reports the
 * elapsed part. Segments shorter than a second are dropped. Returns
 * `{ day, state, startMs, endMs, seconds }[]`.
 */
export function splitIntervalByIstDay(interval, { fromMs, toMs, nowMs = Date.now() } = {}) {
  const state = interval?.state;
  if (!state || !ALL_TIME_STATES.includes(state)) return [];
  const startMs = new Date(interval.started_at).getTime();
  if (!Number.isFinite(startMs)) return [];
  const rawEnd = interval.ended_at ? new Date(interval.ended_at).getTime() : nowMs;
  const endMs = Number.isFinite(rawEnd) ? rawEnd : nowMs;

  const lo = Math.max(startMs, fromMs);
  const hi = Math.min(endMs, toMs, nowMs);
  if (!(hi > lo)) return [];

  const out = [];
  let cursor = lo;
  while (cursor < hi) {
    const day = istDateStr(new Date(cursor));
    const dayEnd = istMidnightMs(day) + DAY_MS;
    const segEnd = Math.min(hi, dayEnd);
    const seconds = Math.round((segEnd - cursor) / 1000);
    if (seconds > 0) out.push({ day, state, startMs: cursor, endMs: segEnd, seconds });
    cursor = segEnd;
  }
  return out;
}

/**
 * Per-day, per-state totals for a set of intervals, split at IST midnights and
 * clipped to [fromMs, toMs). Returns `{ dayMap, total }` where `dayMap` is a Map
 * of 'YYYY-MM-DD' -> summarized totals and `total` is the range-wide summary.
 */
export function perDayStateTotals(intervals = [], { fromMs, toMs, nowMs = Date.now() } = {}) {
  const dayMap = new Map();
  const totalPerState = emptyPerState();

  for (const it of intervals) {
    for (const seg of splitIntervalByIstDay(it, { fromMs, toMs, nowMs })) {
      let day = dayMap.get(seg.day);
      if (!day) { day = emptyPerState(); dayMap.set(seg.day, day); }
      day[seg.state] += seg.seconds;
      totalPerState[seg.state] += seg.seconds;
    }
  }

  return { dayMap, total: summarize(totalPerState) };
}

/** Every IST date string in the inclusive range `from`..`to`. */
export function enumerateIstDays(fromDate, toDate) {
  const out = [];
  let cursor = istMidnightMs(fromDate);
  const end = istMidnightMs(toDate);
  while (cursor <= end) {
    out.push(istDateStr(new Date(cursor)));
    cursor += DAY_MS;
  }
  return out;
}

/**
 * Full per-worker report for an inclusive IST date range: a day-by-day series
 * (zero-filled for days with no sessions) plus range totals. Reads the ledger
 * only.
 */
export async function getIdleReportForWorker({ workerId, from, to, nowMs = Date.now(), pool, agentId = null } = {}) {
  const { fromMs, toMs } = istDayRangeToMs(from, to);
  const fetched = sessionsForActor(
    await getSessionsInRange(workerId, fromMs, toMs, pool ? { pool } : {}),
    agentId
  );
  // Clamp day by day, exactly as the day readers do. Without it an interval left
  // open overnight is clipped into the next day and billed from that day's shift
  // start — the "logged in late, shown 25 minutes idle" figure — and this page
  // would go on reporting it after every other screen had been fixed.
  //
  // The clamp has to see a single day at a time (it finds that day's first
  // presence), so the fetched intervals are re-windowed per day rather than
  // clamped once across the whole range.
  const clamped = [];
  for (let dayStart = fromMs; dayStart < toMs; dayStart += DAY_MS) {
    const dayEnd = Math.min(dayStart + DAY_MS, toMs);
    const inDay = fetched.filter((s) => {
      const st = new Date(s.started_at).getTime();
      const en = s.ended_at ? new Date(s.ended_at).getTime() : Infinity;
      return st < dayEnd && en > dayStart;
    });
    clamped.push(...clampIdleToFirstPresence(inDay, dayStart));
  }
  const { dayMap, total } = perDayStateTotals(clamped, { fromMs, toMs, nowMs });

  const daily = enumerateIstDays(from, to).map((date) => {
    const perState = dayMap.get(date);
    return perState ? { date, ...summarize(perState) } : { date, ...summarize(emptyPerState()) };
  });

  return { hasLedger: intervals.length > 0, daily, total };
}

/**
 * Individual IDLE sessions for one IST day, split at midnight and clipped to the
 * day. `open` marks a session that has not been closed yet (ended_at null); its
 * `ended_at` is the clip point (now), NOT a stored end — no fake end is written.
 */
export function idleSessionsForDay(intervals = [], dateStr, { nowMs = Date.now() } = {}) {
  const fromMs = istMidnightMs(dateStr);
  const toMs = fromMs + DAY_MS;
  const out = [];
  for (const it of intervals) {
    if (!IDLE_STATES.includes(it.state)) continue;
    for (const seg of splitIntervalByIstDay(it, { fromMs, toMs, nowMs })) {
      if (seg.day !== dateStr) continue;
      out.push({
        state: seg.state,
        started_at: new Date(seg.startMs).toISOString(),
        ended_at: new Date(seg.endMs).toISOString(),
        duration_seconds: seg.seconds,
        reason: it.reason || null,
        open: !it.ended_at,
      });
    }
  }
  return out.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
}

/** Same, but fetches the day's intervals from the ledger first. */
export async function getIdleSessionsForDay({ workerId, date, nowMs = Date.now(), pool, agentId = null } = {}) {
  const fromMs = istMidnightMs(date);
  const toMs = fromMs + DAY_MS;
  const fetched = await getSessionsInRange(workerId, fromMs, toMs, pool ? { pool } : {});
  const intervals = sessionsForActor(fetched, agentId);
  return { hasLedger: intervals.length > 0, sessions: idleSessionsForDay(intervals, date, { nowMs }) };
}

/**
 * Total IDLE seconds per worker across an inclusive IST date range, for a set of
 * workers. One SQL aggregate — the per-FRO monthly board must not pull every
 * session row into the app. An open interval is clipped at now().
 *
 * `agent_id IS NULL` is load-bearing: this is the FRO's own idle. An agent
 * working their stations stamps their uuid on the interval, and without this
 * clause the FRO is billed for time they never spent at their desk.
 */
export async function getFroIdleTotalsForRange(workerIds, from, to, { pool = db._pool } = {}) {
  const ids = (workerIds || []).map(String).filter(Boolean);
  if (ids.length === 0) return {};
  const { fromMs, toMs } = istDayRangeToMs(from, to);
  const { rows } = await pool.query(
    `SELECT worker_id,
            COALESCE(SUM(EXTRACT(EPOCH FROM (
              LEAST(COALESCE(ended_at, now()), $3::timestamptz)
              - GREATEST(started_at, $2::timestamptz)
            ))), 0)::bigint AS idle_seconds
       FROM fro_time_sessions
      WHERE worker_id = ANY($1::uuid[])
        AND agent_id IS NULL
        AND state IN ('IDLE', 'SLEEPING', 'HIDDEN')
        AND started_at < $3::timestamptz
        AND COALESCE(ended_at, 'infinity'::timestamptz) > $2::timestamptz
      GROUP BY worker_id`,
    [ids, new Date(fromMs).toISOString(), new Date(toMs).toISOString()]
  );
  const out = {};
  for (const r of rows) out[String(r.worker_id)] = Number(r.idle_seconds) || 0;
  return out;
}
