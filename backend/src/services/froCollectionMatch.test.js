// Guards for the FRO "Collected" card agreeing with the list it opens.
//
// These are pure string/number helpers (services/froCollectionMatch.js), so the
// assertions here need no database. They exist because the card and the list
// drifted onto two different definitions of "this FRO's collection this month"
// and the reported symptom was a total that was too high -- another FRO's money,
// or the same payment counted twice, landing on one person's total.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_LABELS,
  buildAgentNameMatches,
  dedupeCollectionReceipts,
  escapeLikePattern,
  isCategoryLabel,
  mergeAttributedReceipts,
  namesAnotherWorker,
  normalizeAgentName,
  paymentIdentity,
  receiptMatchesAgentName,
  totalCollectionAmount,
} from './froCollectionMatch.js';

test('agent names match regardless of case and surrounding whitespace', () => {
  const matches = buildAgentNameMatches('  Sushma Ambokar  ');
  assert.equal(receiptMatchesAgentName('sushma ambokar', matches), true);
  assert.equal(receiptMatchesAgentName('  SUSHMA AMBOKAR ', matches), true);
  assert.equal(receiptMatchesAgentName('Sushma  Ambokar', matches), false, 'inner spacing is a different name');
});

test('a different FRO is never matched by a shared first or last name', () => {
  // The bug this replaces: a name was matched with ilike, so any printed name
  // containing this one as a pattern (or vice versa) pulled in their receipts.
  const matches = buildAgentNameMatches('Mamta Pal');
  assert.equal(receiptMatchesAgentName('Mamta Shah', matches), false);
  assert.equal(receiptMatchesAgentName('Mamta', matches), false);
});

test('an underscore in a printed name is literal, not a single-char wildcard', () => {
  // ilike('_') matches any single character, so "Sneha_Patil" used to also
  // match "SnehaXPatil" -- a different person, or a mistyped entry.
  const matches = buildAgentNameMatches('Sneha_Patil');
  assert.equal(receiptMatchesAgentName('SnehaXPatil', matches), false);
  assert.equal(receiptMatchesAgentName('Sneha_Patil', matches), true);
  assert.equal(escapeLikePattern('Sneha_Patil%'), 'Sneha\\_Patil\\%');
});

test('curated spelling variants are credited to the same FRO', () => {
  // Migration 080 exists because imported receipts carry printed-name variants
  // that never matched the canonical name, so those donations were never
  // credited to the FRO who actually collected them.
  const matches = buildAgentNameMatches('Sushma Ambokar', ['Sushma Narendra Ambokar']);
  assert.equal(receiptMatchesAgentName('Sushma Narendra Ambokar', matches), true);
  assert.equal(receiptMatchesAgentName('Sushma Ambokar', matches), true);
});

test('the same row reached twice by both attribution windows is counted once', () => {
  // The invariant the composite key exists for, and the only one it can safely
  // provide. The name window and the log window both return this receipt, so
  // merging them is where a double count would genuinely come from.
  const row = { id: 'r1', payment_id: 'PAY123', receipt_no: 'RC-1', donor_id: 'd1', amount: 5000, receipt_date: '2026-10-02' };
  assert.equal(totalCollectionAmount([row, { ...row }]), 5000);
});

test('payments sharing a generic payment_id description are NOT collapsed', () => {
  // The regression that made this key composite again. receipts.payment_id holds
  // a free-text bank description, not a unique reference: live data has 'NA' on
  // 320 rows, '*Transfer' on 264, 'UPI' on 129, '#####################' on 76.
  // Treating those as one identity hid ~500 real donations (Padmini alone would
  // have lost 326 receipts). Distinct donors and days must stay distinct.
  const rows = [
    { id: 'a', payment_id: 'NA', receipt_no: 'R1', donor_id: 'd1', amount: 500, receipt_date: '2026-10-01' },
    { id: 'b', payment_id: 'NA', receipt_no: 'R2', donor_id: 'd2', amount: 500, receipt_date: '2026-10-02' },
    { id: 'c', payment_id: '*Transfer', receipt_no: 'R3', donor_id: 'd3', amount: 500, receipt_date: '2026-10-03' },
    { id: 'd', payment_id: '#####################', receipt_no: 'R4', donor_id: 'd4', amount: 500, receipt_date: '2026-10-04' },
  ];
  assert.equal(dedupeCollectionReceipts(rows).length, 4, 'four real donations, four rows');
  assert.equal(totalCollectionAmount(rows), 2000);
});

test('two donations differing by donor or day both count even with an identical payment_id', () => {
  // The safe direction, and the one that matters: unless EVERY field of the
  // composite key agrees, nothing is merged.
  const rows = [
    { id: 'a', payment_id: 'NA', receipt_no: 'R1', donor_id: 'd1', amount: 500, receipt_date: '2026-10-01' },
    { id: 'b', payment_id: 'NA', receipt_no: 'R2', donor_id: 'd2', amount: 500, receipt_date: '2026-10-01' },
    { id: 'c', payment_id: 'NA', receipt_no: 'R3', donor_id: 'd1', amount: 500, receipt_date: '2026-10-02' },
  ];
  assert.equal(totalCollectionAmount(rows), 1500);
});

test('two genuine donations from one donor in a day both count', () => {
  // Distinct payment references are distinct payments. Collapsing these would
  // under-report, which is the opposite failure and just as wrong.
  const rows = [
    { id: 'r1', payment_id: 'PAY1', receipt_no: null, donor_id: 'd1', amount: 1000, receipt_date: '2026-10-02' },
    { id: 'r2', payment_id: 'PAY2', receipt_no: null, donor_id: 'd1', amount: 1000, receipt_date: '2026-10-02' },
  ];
  assert.equal(totalCollectionAmount(rows), 2000);
});

test('the same receipt id appearing twice is dropped once', () => {
  // A receipt reached by both the in-month query and the verified-in-month
  // union arrives twice in the merged set.
  const row = { id: 'r1', payment_id: 'PAY1', donor_id: 'd1', amount: 700, receipt_date: '2026-10-05' };
  assert.equal(totalCollectionAmount([row, { ...row }]), 700);
});

test('zero and negative amounts are not collection', () => {
  const rows = [
    { id: 'r1', payment_id: 'P1', donor_id: 'd1', amount: 0, receipt_date: '2026-10-01' },
    { id: 'r2', payment_id: 'P2', donor_id: 'd1', amount: -250, receipt_date: '2026-10-01' },
    { id: 'r3', payment_id: 'P3', donor_id: 'd1', amount: 400, receipt_date: '2026-10-01' },
  ];
  assert.equal(totalCollectionAmount(rows), 400);
});

test('legacy rows with neither payment_id nor receipt_no fall back to donor+amount+date', () => {
  const a = { id: 'r1', payment_id: null, receipt_no: null, donor_id: 'd1', amount: 900, receipt_date: '2026-10-03' };
  const b = { id: 'r2', payment_id: null, receipt_no: null, donor_id: 'd1', amount: 900, receipt_date: '2026-10-03' };
  assert.equal(paymentIdentity(a), paymentIdentity(b), 'same donor, amount and day is one payment');
  const c = { ...b, id: 'r3', receipt_date: '2026-10-04' };
  assert.notEqual(paymentIdentity(a), paymentIdentity(c), 'a different day is a different payment');
});

test('an absent or blank agent name matches nothing', () => {
  const matches = buildAgentNameMatches('Kshitija Jadhav');
  assert.equal(receiptMatchesAgentName(null, matches), false);
  assert.equal(receiptMatchesAgentName('   ', matches), false);
  assert.equal(normalizeAgentName(null), '');
});

test('dedupe keeps the first row for a repeated payment and drops the copy', () => {
  const first = { id: 'r1', payment_id: 'PAY1', donor_id: 'd1', amount: 100, receipt_date: '2026-10-01', mode: 'upi' };
  const copy = { id: 'r2', payment_id: 'PAY1', donor_id: 'd1', amount: 100, receipt_date: '2026-10-01', mode: 'cash' };
  const kept = dedupeCollectionReceipts([first, copy]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].mode, 'upi', 'the first sighting wins so the row detail stays stable');
});

// ---------------------------------------------------------------------------
// Name-first attribution
//
// receipts.log_id is a reliable LINK but not a reliable OWNER: linking a bank
// entry to a donor's pending lead (bankAuditController.js:181) hands the receipt
// that lead's log, and log.fro_worker_id is the ASSIGNMENT's FRO, not whoever
// collected the cash. Trusting the log credited one FRO with another's
// collection -- reported as receipt 83746 (agent_name "Mamta Shah" landing in
// Varsha Tambe's total). So the name wins whenever it resolves to a person.
// ---------------------------------------------------------------------------

test('a name naming this FRO beats a log owned by someone else', () => {
  // The reported bug. Mamta collected it; the donor's pending lead belonged to
  // Varsha's assignment, so the log points at Varsha. The confirmed agent_name
  // is the operator's own record and must win.
  const byName = [{ id: 'r1', log_id: 7, agent_name: 'Mamta Shah', amount: 50, receipt_date: '2026-10-02' }];
  const byLog = [];   // this worker's own log query finds nothing
  const merged = mergeAttributedReceipts(byName, byLog);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attributed_by, 'name');
  assert.equal(totalCollectionAmount(merged), 50, 'the 50 rupees stay with the named FRO');
});

// The resolvers set is every real worker's name (and alias), normalized. Passed
// by the loader so the log fallback can ask "does this receipt name somebody?".
const RESOLVERS = new Set([
  'varsha tambe', 'mamta shah', 'ruchira mhatre', 'ravina joshi', 'priya tiwari',
  'agent 13',
]);

test('the log fallback does NOT claim a receipt agent_name gave to another FRO', () => {
  // Receipt 83746 and three BSCT siblings: stamped 'Mamta Shah', collected under
  // a station log that belongs to Varsha Tambe. Name-first alone was not enough,
  // because the fallback was still additive -- it added these to the station
  // FRO's card on top of her own rows.
  const herOwnRows = [
    { id: 'v1', agent_name: 'Varsha Tambe', amount: 7433, receipt_date: '2026-10-01' },
  ];
  const logFallbackWouldOffer = [
    { id: 'r1', agent_name: 'Mamta Shah', amount: 101, receipt_date: '2026-10-03' },
    { id: 'r2', agent_name: 'Mamta Shah', amount: 1000, receipt_date: '2026-10-05' },
    { id: 'r3', agent_name: 'Mamta Shah', amount: 700, receipt_date: '2026-10-05' },
    { id: 'r4', agent_name: 'Mamta Shah', amount: 50, receipt_date: '2026-10-05' },
  ];
  const merged = mergeAttributedReceipts(herOwnRows, logFallbackWouldOffer, RESOLVERS);
  assert.equal(merged.length, 1, "a colleague's rows are not added");
  assert.equal(totalCollectionAmount(merged), 7433, 'the total is the actual 7,433, not ~10,284');
});

test('a blank, category or agent-labelled name still falls back to the log', () => {
  // The fallback must keep working where it is the ONLY evidence, or real
  // collections disappear. None of these name a real worker.
  const byLog = [
    { id: 's1', agent_name: 'Suspense', amount: 2500, receipt_date: '2026-10-05' },
    { id: 's2', agent_name: null, amount: 700, receipt_date: '2026-10-06' },
    { id: 's3', agent_name: 'Agent 13', amount: 300, receipt_date: '2026-10-07' },
  ];
  const merged = mergeAttributedReceipts([], byLog, RESOLVERS);
  assert.equal(merged.length, 3, 'all three are recovered from the log');
  assert.equal(totalCollectionAmount(merged), 3500);
  merged.forEach((r) => assert.equal(r.attributed_by, 'log'));
});

test('without a resolver set the fallback still runs (fails open, never hides money)', () => {
  // If the resolver lookup ever fails, the safe failure is to over-claim rather
  // than to silently drop a collection someone really made.
  const byLog = [{ id: 'x1', agent_name: 'Mamta Shah', amount: 1000, receipt_date: '2026-10-01' }];
  const merged = mergeAttributedReceipts([], byLog, new Set());
  assert.equal(totalCollectionAmount(merged), 1000);
});

test('namesAnotherWorker recognises a competing claim and ignores labels', () => {
  assert.equal(namesAnotherWorker('Mamta Shah', RESOLVERS), true);
  // Case and outer whitespace fold; INNER spacing does not, matching the resolver
  // keys, which are built from the same normalizeAgentName over real names.
  assert.equal(namesAnotherWorker('  mamta shah ', RESOLVERS), true);
  assert.equal(namesAnotherWorker('Mamta   Shah', RESOLVERS), false, 'a different printed name, not a competing claim on this worker');
  assert.equal(namesAnotherWorker('Nobody At All', RESOLVERS), false);
  // These name no worker, so they must not block the fallback.
  assert.equal(namesAnotherWorker('Suspense', RESOLVERS), false);
  assert.equal(namesAnotherWorker('PG', RESOLVERS), false);
  assert.equal(namesAnotherWorker('', RESOLVERS), false);
  assert.equal(namesAnotherWorker(null, RESOLVERS), false);
});

test('the same receipt is counted once even when both signals see it', () => {
  const row = { id: 'r1', agent_name: 'Varsha Tambe', amount: 7433, receipt_date: '2026-10-01' };
  const merged = mergeAttributedReceipts([row], [row], RESOLVERS);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attributed_by, 'name');
});

test('the same receipt linked to a different FRO log is not double-credited', () => {
  // Both workers query it -- Varsha via the log, Mamta via the name. Each gets
  // their own list, and within one worker it is credited exactly once.
  const byName = [{ id: 'r1', log_id: 7, agent_name: 'Mamta Shah', amount: 50, receipt_date: '2026-10-02' }];
  const byLog = [{ id: 'r1', log_id: 7, agent_name: 'Mamta Shah', amount: 50, receipt_date: '2026-10-02' }];
  const merged = mergeAttributedReceipts(byName, byLog);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attributed_by, 'name');
  assert.equal(totalCollectionAmount(merged), 50);
});

test('a receipt with no resolvable name falls back to its log', () => {
  // Blank agent_name, or a category label: no name evidence exists, so the link
  // is all that is left and this money must not vanish.
  const merged = mergeAttributedReceipts(
    [],
    [{ id: 'r3', log_id: 9, agent_name: 'Suspense', amount: 2500, receipt_date: '2026-10-05' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].attributed_by, 'log');
  assert.equal(totalCollectionAmount(merged), 2500);
});

test('an agent label still resolves while its alias row exists', () => {
  // agent_name is still needed, because an agent's work-as switch stamps
  // "Agent 13" (authController.js:960) and worker_aliases maps it to the FRO.
  const matches = buildAgentNameMatches('Mamta Shah', ['Agent 13']);
  assert.equal(receiptMatchesAgentName('Agent 13', matches), true);
});

test('category labels are never credited to a worker', () => {
  // 'Suspense' is bank money nobody has claimed. Crediting it to an FRO who
  // never collected it would inflate a real person's target attainment.
  for (const label of CATEGORY_LABELS) {
    assert.equal(isCategoryLabel(label), true, `${label} is a category label`);
    assert.equal(isCategoryLabel(` ${label.toUpperCase()} `), true, 'case and padding do not matter');
  }
  // Even in the pathological case of a worker whose name IS one of these, the
  // label must not match itself.
  const matches = buildAgentNameMatches('Suspense');
  assert.equal(receiptMatchesAgentName('Suspense', matches), false);
});

test('a real name that merely contains a category word still matches', () => {
  // Only the whole normalized value is the category; a person called
  // "Library Anne" is a person.
  const matches = buildAgentNameMatches('Library Anne');
  assert.equal(receiptMatchesAgentName('Library Anne', matches), true);
  assert.equal(isCategoryLabel('Library Anne'), false);
});

test('two FROs each keep only their own collection', () => {
  const mamta = mergeAttributedReceipts(
    [{ id: 'r1', log_id: 7, agent_name: 'Mamta Shah', amount: 1000, receipt_date: '2026-10-01' }],
    []
  );
  const varsha = mergeAttributedReceipts(
    [{ id: 'r2', log_id: 8, agent_name: 'Varsha Tambe', amount: 4000, receipt_date: '2026-10-01' }],
    []
  );
  assert.equal(totalCollectionAmount(mamta), 1000);
  assert.equal(totalCollectionAmount(varsha), 4000);
});

test('rows with no id are never counted twice from an unkeyed set', () => {
  // mergeAttributedReceipts keys on receipt id; a row without one cannot be
  // deduped, so it must still not be summed twice when the same unkeyed row
  // arrives from both windows.
  const unkeyed = [{ amount: 750, receipt_date: '2026-10-03', payment_id: 'P9' }];
  const merged = mergeAttributedReceipts(unkeyed, unkeyed);
  assert.equal(totalCollectionAmount(merged), 750, 'payment identity still collapses it');
});

test('the summed total equals the sum of the rows the list renders', () => {
  // The invariant the card depends on: the headline number is the sum of exactly
  // the rows underneath it, after the same dedup both sides apply.
  const rows = [
    { id: 'r1', payment_id: 'P1', donor_id: 'd1', amount: 4000, receipt_date: '2026-10-01' },
    { id: 'r2', payment_id: 'P2', donor_id: 'd2', amount: 4000, receipt_date: '2026-10-02' },
    { id: 'r3', payment_id: 'P1', donor_id: 'd1', amount: 4000, receipt_date: '2026-10-01' },
  ];
  const listRows = dedupeCollectionReceipts(rows);
  const summed = listRows.reduce((s, r) => s + r.amount, 0);
  assert.equal(totalCollectionAmount(rows), summed);
  assert.equal(summed, 8000);
});