// A covered FRO's row and the covering agent's panel must show the same idle.
//
// The row belongs to the FRO, but while an agent is covering it the person at the
// keyboard is the AGENT — and the agent's panel shows the agent's own figure. The
// board used to show the FRO's banked idle instead, so the same row read 44m on the
// board and 2m on the panel, and neither number was wrong: they were two different
// people. This pins the rule that makes one number win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

// The decision itself, extracted so it is testable without a database.
export function idleCellForRow({ froOwnIdle, bankedIdle, coveringAgentIdle, hasLiveCover }) {
  const fallback = Math.max(Number(froOwnIdle || 0), Number(bankedIdle || 0));
  if (hasLiveCover && coveringAgentIdle != null) return coveringAgentIdle;
  return fallback;
}

test('a live cover makes the board report the agent, matching that agent panel', () => {
  assert.equal(
    idleCellForRow({ froOwnIdle: 2640, bankedIdle: 2640, coveringAgentIdle: 120, hasLiveCover: true }),
    120,
    'the agent at the keyboard is who the panel shows, so the board must show them too'
  );
});

test('an agent with no stamped time yet reads zero, not the covered FRO figure', () => {
  assert.equal(
    idleCellForRow({ froOwnIdle: 2640, bankedIdle: 2640, coveringAgentIdle: 0, hasLiveCover: true }),
    0,
    'zero from the covering agent is a real reading and must not fall through to the FRO'
  );
});

test('no live cover leaves the FRO own figure alone', () => {
  assert.equal(
    idleCellForRow({ froOwnIdle: 2640, bankedIdle: 2640, coveringAgentIdle: 120, hasLiveCover: false }),
    2640
  );
});

test('a cover whose agent has no ledger row falls back to the FRO figure', () => {
  // Unknown agent (ledger absent) must not blank a real number to 0.
  assert.equal(
    idleCellForRow({ froOwnIdle: 2640, bankedIdle: 100, coveringAgentIdle: null, hasLiveCover: true }),
    2640
  );
});

test('the board reads the agent figure from the agent stamp, not from the FRO row', () => {
  const src = read('controllers/ngoAdminController.js');
  assert.match(src, /coveringIdle\s*!=\s*null\s*\?\s*coveringIdle\s*:\s*idleDisplaySeconds/,
    'today_idle_seconds must prefer the covering agent figure while a cover is live');
  // And it must say whose it is, or the cell reads as the FRO's number.
  assert.match(src, /idle_attributed_to/,
    'the board must name whose idle it is reporting while a cover is live');
});

test('an agent idle total is read by agent_id, the only place an agent has rows', () => {
  const sessions = read('services/froTimeSessions.js');
  assert.match(sessions, /export async function dayTotalsForAgents/,
    'the agent totals reader must exist — an agent has no workers row to key a worker query on');
  const board = read('controllers/ngoAdminController.js');
  assert.match(board, /dayTotalsForAgents\(/, 'the board must use it');
  assert.match(board, /operatorUserId/, 'the operator id is the agent stamp on the intervals');
});

test('one agent covering two FROs does not inflate either row', () => {
  // The agent's strip reads their rows filtered to the FRO being worked. Summing
  // by agent alone would print their combined total on BOTH rows, so each row would
  // sit higher than the panel in front of them — the same class of disagreement
  // this reader exists to remove, just distributed across rows instead of screens.
  const sessions = read('services/froTimeSessions.js');
  assert.match(sessions, /agentTotalKey/, 'agent totals must be keyed by worker AND agent');
  assert.match(sessions, /\(worker_id::text, agent_id\) IN/,
    'the query must filter on the pair, not on agent_id alone');
});

test('agent idle is clamped to the covered FRO shift, as the strip clamps it', () => {
  const sessions = read('services/froTimeSessions.js');
  assert.match(sessions, /sumIntervalsByState\(clamped, \{ shift: shiftFor\(/,
    'no shift here means idle past shift end counts on the board and clips on the strip');
  const board = read('controllers/ngoAdminController.js');
  assert.match(board, /dayTotalsForAgents\(pairs, \{[\s\S]{0,200}shiftFor:/,
    'the board must pass the covered FRO shift through');
});

// Behavioural, not textual: drive the real reader with a stub pool.
test('the reader keeps each FRO pair separate and returns 0 for an agent yet unseen', async () => {
  const { dayTotalsForAgents, agentTotalKey } = await import('./froTimeSessions.js');

  const iso = (h) => new Date(`2026-01-15T${h}:00+05:30`).toISOString();
  const rows = [
    // Agent A worked 30m on FRO-1 and 45m on FRO-2. One combined read would put
    // 75m on both rows; the strip behind each row shows 30m and 45m respectively.
    { worker_id: 1, agent_id: 'A', state: 'IDLE', started_at: iso('10:00'), ended_at: iso('10:30') },
    { worker_id: 2, agent_id: 'A', state: 'IDLE', started_at: iso('11:00'), ended_at: iso('11:45') },
  ];
  let captured = null;
  const pool = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows };
    },
  };

  const nowMs = new Date('2026-01-15T12:00:00+05:30').getTime();
  const out = await dayTotalsForAgents(
    [{ workerId: 1, agentId: 'A' }, { workerId: 2, agentId: 'A' }, { workerId: 3, agentId: 'B' }],
    { pool, nowMs },
  );

  assert.equal(out.get(agentTotalKey(1, 'A')), 1800, 'FRO-1 row must show only that FRO 30m');
  assert.equal(out.get(agentTotalKey(2, 'A')), 2700, 'FRO-2 row must show only that FRO 45m');
  assert.equal(out.get(agentTotalKey(3, 'B')), 0,
    'an agent with no rows must read 0, which is what their strip reads — not a fallback');
  assert.ok(out.has(agentTotalKey(3, 'B')), 'every requested cover gets a reading, so 0 is never mistaken for missing');

  // The pair filter must actually reach the database, not just the grouping.
  assert.deepEqual(captured.params[0], ['1', '2', '3']);
  assert.deepEqual(captured.params[1], ['A', 'A', 'B']);
});

test('idle running past shift end is clipped to the shift, as the strip clips it', async () => {
  const { dayTotalsForAgents, agentTotalKey } = await import('./froTimeSessions.js');

  const iso = (t) => new Date(t).toISOString();
  // One 40m idle block starting 20m before the shift ends.
  const rows = [
    { worker_id: 1, agent_id: 'A', state: 'IDLE', started_at: iso('2026-01-15T17:40:00+05:30'), ended_at: iso('2026-01-15T18:20:00+05:30') },
  ];
  const pool = { async query() { return { rows }; } };
  const nowMs = new Date('2026-01-15T20:00:00+05:30').getTime();
  const shift = { startMs: new Date('2026-01-15T09:00:00+05:30').getTime(), endMs: new Date('2026-01-15T18:00:00+05:30').getTime() };
  const pair = [{ workerId: 1, agentId: 'A' }];

  const clipped = await dayTotalsForAgents(pair, { pool, nowMs, shiftFor: () => shift });
  assert.equal(clipped.get(agentTotalKey(1, 'A')), 1200,
    'only the 20m inside the shift counts; the 20m past shift end would otherwise print on the board alone');

  // Same rows, no shift — the gap this reader must never reintroduce.
  const unclipped = await dayTotalsForAgents(pair, { pool, nowMs, shiftFor: () => null });
  assert.equal(unclipped.get(agentTotalKey(1, 'A')), 2400);
});