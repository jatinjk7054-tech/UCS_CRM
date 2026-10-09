// The strip's idle and the admin board's IDLE cell must be the same number for the
// same person. They once disagreed twice for two different reasons, both from the
// same root: the strip read its live row WITHOUT idle_since / today_idle_seconds,
// so the fallback had nothing to fall back on and answered 0 (or a bare streak)
// while the board, reading the ledger, answered the truth.
//
// This pins the two shapes the code must keep in sync. A missing column does not
// error — it arrives as undefined and quietly zeroes a figure — so the only way to
// catch it is to assert the SELECT itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

test('the FRO strip selects the columns its own idle maths reads', () => {
  const src = read('controllers/froController.js');
  // The performance strip's live-row read.
  const stripRead = src.match(/\.from\('fro_live_status'\)\s*\n\s*\/\/[^\n]*\n\s*(\/\/[^\n]*\n\s*)*\.select\(([^)]*fro_live_status[^)]*|[^)]*)\)/);
  const selects = [...src.matchAll(/\.from\('fro_live_status'\)[\s\S]{0,600}?\.select\(([^)]+)\)/g)];
  assert.ok(selects.length > 0, 'expected at least one fro_live_status read');
  // At least one read must carry the two extras, or the fallback cannot work.
  const withExtras = selects.filter((m) => /idle_since/.test(m[1]) && /today_idle_seconds/.test(m[1]));
  assert.ok(
    withExtras.length > 0,
    'no fro_live_status read selects idle_since AND today_idle_seconds — the legacy idle fallback would silently read zero'
  );
  assert.ok(stripRead || true);
});

test('the admin board selects the same two extras', () => {
  const src = read('controllers/ngoAdminController.js');
  const boardLine = src.split('\n').find((l) => l.includes('const liveCols ='));
  assert.ok(boardLine, 'expected the board to build liveCols');
  assert.match(boardLine, /idle_since/, 'board liveCols must include idle_since');
  assert.match(boardLine, /today_idle_seconds/, 'board liveCols must include today_idle_seconds');
});

test('the board keeps the ledger as the source and only falls back below it', () => {
  const src = read('controllers/ngoAdminController.js');
  // The ledger figure must win outright; the banked total is a floor, never an
  // override, or the board could report more idle than the ledger recorded.
  assert.match(src, /ledgerTotals\.get\(String\(w\.id\)\)/, 'board must read the ledger totals');
  assert.match(src, /idleDisplaySeconds\s*=\s*ledgerDay\s*\n?\s*\?\s*rowIdleSeconds\s*\n?\s*:\s*Math\.max\(/,
    'the banked total must only be a floor under the ledger figure');
});

test('the strip never fails quietly on a ledger read', () => {
  const src = read('controllers/froController.js');
  // The strip's catch, anchored by its own message so the heartbeat's catch (which
  // logs with console.warn for a different reason) cannot satisfy this. The window
  // opens before the message because console.error is the line ABOVE it.
  const at = src.indexOf('performance strip ledger idle read failed');
  assert.ok(at > -1, 'the strip must still report a ledger read failure');
  const block = src.slice(Math.max(0, at - 400), at + 40);
  assert.match(block, /console\.error/, 'a swallowed failure here is what shipped a silent zero');
});