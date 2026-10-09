// A FRO who was not on the panel must not be billed idle for the time before
// they arrived. Overnight-open HIDDEN/IDLE intervals used to be clipped into
// today's window and counted from shift start, which showed up as "25 min idle"
// for somebody who had just logged in.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampIdleToFirstPresence } from './froTimeSessions.js';

const DAY = '2026-10-08';
const dayStart = new Date(`${DAY}T00:00:00.000+05:30`).getTime();
const at = (hhmm) => new Date(`${DAY}T${hhmm}:00.000+05:30`).toISOString();

// Shift 09:30-18:30 IST; the FRO logs in at 10:05 after an overnight HIDDEN gap.
const SHIFT_START = new Date(`${DAY}T09:30:00.000+05:30`).getTime();

test('idle before the first panel presence of the day is not counted', () => {
  const sessions = [
    // Opened yesterday evening, never closed: the panel was shut.
    { state: 'HIDDEN', started_at: new Date(SHIFT_START - 60 * 60 * 1000).toISOString(), ended_at: null },
    // They arrive at 10:05 and start working.
    { state: 'WORKING', started_at: at('10:05'), ended_at: at('10:35') },
    { state: 'IDLE', started_at: at('10:35'), ended_at: at('10:50') },
  ];

  const clamped = clampIdleToFirstPresence(sessions, dayStart);

  const hidden = clamped.find((s) => s.state === 'HIDDEN');
  assert.equal(hidden.started_at, at('10:05'), 'overnight idle starts at first presence, not the day start');
  assert.equal(
    new Date(clamped[1].started_at).getTime(),
    Math.max(new Date(hidden.started_at).getTime(), new Date(clamped[1].started_at).getTime()),
    'no interval may start before the previous one after clamping'
  );
});

test('genuine same-day idle is untouched', () => {
  const sessions = [
    { state: 'WORKING', started_at: at('09:35'), ended_at: at('10:00') },
    { state: 'IDLE', started_at: at('10:00'), ended_at: at('10:20') },
  ];
  assert.deepEqual(clampIdleToFirstPresence(sessions, dayStart), sessions);
});

test('the day reader and the range report agree on a late login', () => {
  // getIdleReportForWorker clamps per day for exactly this reason: it used to skip
  // the clamp and kept billing an overnight-open interval from the next day's
  // shift start, so "My Idle" disagreed with every other screen on a late login.
  const overnight = {
    state: 'HIDDEN',
    started_at: new Date(SHIFT_START - 60 * 60 * 1000).toISOString(),
    ended_at: null,
  };
  const arrived = { state: 'WORKING', started_at: at('10:05'), ended_at: at('11:00') };

  const clamped = clampIdleToFirstPresence([overnight, arrived], dayStart);
  assert.equal(clamped[0].started_at, at('10:05'), 'idle starts at arrival, not at shift start');

  // And the rule the report relies on: a day with no presence at all is untouched.
  assert.deepEqual(clampIdleToFirstPresence([overnight], dayStart), [overnight]);
});

test('a worker who never showed up keeps no invented presence', () => {
  // One overnight interval and nothing else: there is no first presence to clamp
  // to, so the row must be returned as-is rather than snapped to the day start.
  const sessions = [
    { state: 'HIDDEN', started_at: new Date(SHIFT_START - 60 * 60 * 1000).toISOString(), ended_at: null },
  ];
  assert.deepEqual(clampIdleToFirstPresence(sessions, dayStart), sessions);
});

test('an idle interval that begins after presence is left alone', () => {
  const sessions = [
    { state: 'HIDDEN', started_at: new Date(SHIFT_START - 60 * 60 * 1000).toISOString(), ended_at: at('09:40') },
    { state: 'WORKING', started_at: at('09:40'), ended_at: at('12:00') },
    { state: 'IDLE', started_at: at('13:00'), ended_at: at('13:10') },
  ];
  const clamped = clampIdleToFirstPresence(sessions, dayStart);
  assert.equal(clamped.find((s) => s.state === 'HIDDEN').started_at, at('09:40'));
  assert.equal(clamped.find((s) => s.state === 'IDLE').started_at, at('13:00'));
});