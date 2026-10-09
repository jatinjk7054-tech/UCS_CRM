import db from '../config/db.js';
import { nextMatchNo, syncEntryToLead, getUnlinkedReceipts, enrichDonorProfileFromReceipt } from '../models/bankAuditModel.js';
import { resolveOperatorName } from './operatorNameService.js';

const MIN_SCORE = 75;
const MARGIN = 10;
const DATE_WINDOW_DAYS = 3;

// The matching engine is O(entries × candidates) in-memory work. On the shared
// 2-core host it used to run unrestricted: every payment scrape / bank audit
// import re-scanned ALL unverified entries and ALL receipts/leads, blocking the
// event loop and doubling RSS as concurrent scrapes each loaded the same pools.
// These bounds keep a run finite and cooperative:
const MAX_ENTRIES_PER_RUN = Number(process.env.AUTOMATCH_MAX_ENTRIES || 1500); // newest unverified entries per run
const MAX_LEADS_PER_RUN = Number(process.env.AUTOMATCH_MAX_LEADS || 2000);      // pending leads to score against
const YIELD_EVERY = 50;                                                          // let other requests breathe every N rows

const yieldNow = () => new Promise((r) => setImmediate(r));

// One engine run at a time. If a scrape lands while a previous match is still
// working, skip it (callers treat no-match as success) instead of stacking a
// second copy that would burn 2x CPU/memory.
let engineBusy = false;
async function withEngineGuard(name, fn, fnResult) {
  if (engineBusy) {
    console.warn(`[autoMatch] ${name}: previous run still active — skipping this run`);
    return fnResult;
  }
  engineBusy = true;
  try {
    return await fn();
  } finally {
    engineBusy = false;
  }
}

// ─── Name normalization / fuzzy matching ───────────────────
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'smt', 'shri', 'shree', 'kumari', 'kumar', 'sir', 'sd', 's/o', 'd/o', 'c/o']);

export const normalizeName = (name) => {
  const cleaned = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .filter((w) => w.length > 0 && !TITLES.has(w))
    .join(' ');
};

export const nameMatch = (a, b) => {
  const na = normalizeName(String(a || '').replace(/don@/gi, ''));
  const nb = normalizeName(String(b || '').replace(/don@/gi, ''));
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = na.split(' ')[0];
  const fb = nb.split(' ')[0];
  if (fa && fb && fa === fb && fa.length >= 3) return true;
  if (na.includes(nb) || nb.includes(na)) return na.length >= 3 && nb.length >= 3;
  const dist = levenshtein(na, nb);
  const ratio = 1 - dist / Math.max(na.length, nb.length);
  return ratio >= 0.7;
};

const levenshtein = (a, b) => {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.splice(0, n + 1, ...cur);
  }
  return prev[n];
};

const daysBetween = (a, b) => {
  const da = new Date(a);
  const dbDate = new Date(b);
  if (isNaN(da) || isNaN(dbDate)) return null;
  return Math.abs((da.getTime() - dbDate.getTime()) / 86400000);
};

// ─── Scoring ───────────────────────────────────────────────
// entry: bank_audit_entries row; lead: fro_donor_logs row (with fro_assignments + donor_profiles)
export const scoreEntryLead = (entry, lead) => {
  let score = 0;
  const reasons = [];

  const entryPid = String(entry.payment_id || '').trim().toUpperCase();
  const leadPid = String(lead.upi_transaction_id || '').trim().toUpperCase();
  if (entryPid && leadPid && entryPid === leadPid) {
    score += 100;
    reasons.push('payment ID matches');
  }

  if (Number(entry.amount) === Number(lead.amount_collected)) {
    score += 30;
    reasons.push('amount matches');
  }

  const donor = lead.fro_assignments?.donor_profiles;
  if (nameMatch(entry.payer_name, donor?.name)) {
    score += 25;
    reasons.push('name matches');
  }

  const entryNgo = String(entry.project_id || '').toLowerCase();
  const donorNgo = String(donor?.project_supported || '').toLowerCase();
  if (entryNgo && donorNgo && entryNgo === donorNgo) {
    score += 20;
    reasons.push('NGO matches');
  }

  const leadDate = lead.transaction_datetime || lead.verified_at || lead.created_at;
  const diff = daysBetween(entry.transaction_date, leadDate);
  if (diff !== null && diff <= DATE_WINDOW_DAYS) {
    score += 25;
    reasons.push('date matches');
  }

  return { score: Math.min(score, 100), reasons };
};

// Link a matched suspense receipt to a lead without verifying it (the lead
// stays pending; the admin Verify action later claims the receipt via log_id
// and generates it into receipts).
const linkSuspenseToLead = async (receipt, lead) => {
  const donor = lead.fro_assignments?.donor_profiles || {};
  // Agent stamp comes from whoever ACTUALLY collected: the lead's operator_id
  // during a Work As / cover session (the person at the keyboard). The covered
  // FRO (fro_worker_id) is only the answer when no operator was recorded, and
  // the assignment owner is the last fallback.
  let agentName = null;
  const operatorName = await resolveOperatorName(lead.operator_id);
  if (operatorName?.label || operatorName?.name) {
    agentName = operatorName.label || operatorName.name;
  } else if (lead.fro_worker_id) {
    if (String(lead.fro_worker_id) === String(lead.fro_assignments?.fro_worker_id)) {
      agentName = lead.fro_assignments?.workers?.name || null;
    } else {
      const { data: cwRow } = await db.from('workers').select('name').eq('id', lead.fro_worker_id).maybeSingle();
      agentName = cwRow?.name || null;
    }
  }
  if (!agentName) agentName = lead.fro_assignments?.workers?.name || null;
  const receiptPatch = {
    log_id: lead.id,
    donor_id: donor.id || null,
    donor_name: donor.name || receipt.donor_name || null,
    donor_mobile: donor.mobile_number || null,
    agent_name: agentName,
    project_id: receipt.project_id || donor.project_supported || 'bsct',
    pan_number: donor.pan_number || null,
    address: [donor.address_1, donor.address_2].filter(Boolean).join(', ') || null,
    email: donor.email || null,
    bank_name: donor.donors_bank_name || null,
    mode: lead.payment_mode || donor.mop || (receipt.mode || 'Bank'),
  };
  await db
    .from('receipts')
    .update(receiptPatch)
    .eq('id', receipt.id)
    .is('donor_id', null)
    .is('log_id', null);

  try { await enrichDonorProfileFromReceipt(donor.id, receipt); }
  catch (e) { console.error('Failed to enrich donor profile from suspense receipt:', e.message); }

  const { data: leadPay } = await db
    .from('fro_donor_logs')
    .select('upi_transaction_id, payment_from, transaction_datetime, payment_mode')
    .eq('id', lead.id)
    .maybeSingle();
  const leadPatch = {};
  if (leadPay) {
    // The audit/receipt data is the source of truth: it always overrides the
    // lead's payment fields when a suspense receipt is auto-linked.
    if (receipt.payment_id) leadPatch.upi_transaction_id = receipt.payment_id;
    if (receipt.donor_name) leadPatch.payment_from = receipt.donor_name;
    if (receipt.receipt_date) {
      leadPatch.transaction_datetime = receipt.receipt_time
        ? `${receipt.receipt_date}T${receipt.receipt_time}`
        : receipt.receipt_date;
    }
    leadPatch.payment_mode = receipt.mode || (receipt.payment_id ? 'UPI' : 'Bank Transfer');
  }
  if (Object.keys(leadPatch).length > 0) {
    await db.from('fro_donor_logs').update(leadPatch).eq('id', lead.id);
  }
};

// ─── Engine ────────────────────────────────────────────────
// ─── Payment-id receipt pass ───────────────────────────────
// Statement rows whose payment id / UTR already has a receipt are DONE — they
// were collected and receipted outside the audit flow, so nobody ever flipped
// the entry's status. Verify + link such entries automatically when the match
// is unambiguous. Tier 1: identical normalized payment id + identical amount.
// Tier 2: FROs often key their own reference (or typo the UTR), so fall back
// to a UNIQUE same-amount, +-1-day, shared-name-token receipt — only when
// exactly one such receipt exists. Tier 3: bank statements sometimes mask the
// payer name entirely ("R***************"), so match on the payer's mobile
// instead when the name yields no tokens.
const normPay = (v) => String(v || '').replace(/[^A-Za-z0-9]/g, '');
const normTokens = (v) => String(v || '')
  .toLowerCase()
  .replace(/\s*\(.*?\)\s*/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .split(' ')
  .filter((w) => w.length >= 3 && !TITLES.has(w));

const linkEntriesWithReceiptsRaw = async () => {
  const { data: entries, error: eErr } = await db
    .from('bank_audit_entries')
    .select('id, amount, payment_id, transaction_date, payer_name, donor_mobile')
    .eq('status', 'unverified')
    .is('receipt_id', null)
    .order('transaction_date', { ascending: false })
    .range(0, MAX_ENTRIES_PER_RUN - 1);
  if (eErr) throw eErr;

  const { data: receipts, error: rErr } = await db
    .from('receipts')
    .select('id, receipt_no, amount, payment_id, donor_id, agent_name, donor_name, donor_mobile, receipt_date')
    .not('donor_mobile', 'is', null)
    .gte('receipt_date', new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10));
  if (rErr) throw rErr;

  // A receipt can settle at most one statement row.
  const { data: claimed, error: cErr } = await db
    .from('bank_audit_entries')
    .select('receipt_id')
    .not('receipt_id', 'is', null);
  if (cErr) throw cErr;
  const claimedIds = new Set((claimed || []).map((x) => String(x.receipt_id)));

  const byPay = new Map();
  for (const r of receipts || []) {
    const k = normPay(r.payment_id);
    if (!k) continue;
    if (!byPay.has(k)) byPay.set(k, []);
    byPay.get(k).push(r);
  }
  const dayMs = 86400000;
  const withinDay = (r, entry) =>
    Math.abs(new Date(r.receipt_date).getTime() - new Date(entry.transaction_date).getTime()) <= dayMs;
  const sameAmount = (r, entry) =>
    Math.abs(parseFloat(r.amount || 0) - parseFloat(entry.amount || 0)) < 0.01;
  const fuzzyCandidates = (entry, pool) => {
    const etoks = normTokens(entry.payer_name);
    if (!etoks.length) return [];
    const eday = new Date(entry.transaction_date).getTime();
    return pool.filter((r) => {
      if (Math.abs(parseFloat(r.amount || 0) - parseFloat(entry.amount || 0)) >= 0.01) return false;
      if (Math.abs(new Date(r.receipt_date).getTime() - eday) > dayMs) return false;
      const rtoks = normTokens(r.donor_name);
      return etoks.some((t) => rtoks.includes(t));
    });
  };
  const mobileCandidates = (entry, pool) => {
    const mob = String(entry.donor_mobile || '').replace(/\D/g, '');
    if (mob.length < 10) return [];
    return pool.filter(
      (r) => sameAmount(r, entry) && withinDay(r, entry) && String(r.donor_mobile).replace(/\D/g, '') === mob
    );
  };

  const usedReceipts = new Set();
  let linked = 0;
  let iteration = 0;
  for (const entry of entries || []) {
    iteration += 1;
    if (iteration % YIELD_EVERY === 0) await yieldNow();
    let pick = null;
    const k = normPay(entry.payment_id);
    if (k) {
      const cands = (byPay.get(k) || [])
        .filter((r) => !claimedIds.has(String(r.id)) && !usedReceipts.has(String(r.id)))
        .filter((r) => Math.abs(parseFloat(r.amount || 0) - parseFloat(entry.amount || 0)) < 0.01);
      if (cands.length === 1) pick = { receipt: cands[0], source: 'payment_id' };
    }
    if (!pick) {
      const pool = (receipts || []).filter((r) => !claimedIds.has(String(r.id)) && !usedReceipts.has(String(r.id)));
      const cands = fuzzyCandidates(entry, pool);
      if (cands.length === 1) pick = { receipt: cands[0], source: 'receipt_fuzzy' };
    }
    if (!pick) {
      const pool = (receipts || []).filter((r) => !claimedIds.has(String(r.id)) && !usedReceipts.has(String(r.id)));
      const cands = mobileCandidates(entry, pool);
      if (cands.length === 1) pick = { receipt: cands[0], source: 'receipt_mobile' };
    }
    if (!pick) continue;
    const r = pick.receipt;
    const matchNo = await nextMatchNo();
    const { error: uErr } = await db
      .from('bank_audit_entries')
      .update({
        status: 'verified',
        match_status: 'matched',
        match_source: pick.source,
        match_no: matchNo,
        matched_at: new Date().toISOString(),
        receipt_id: r.id,
        receipt_no: r.receipt_no,
        donor_id: r.donor_id,
        agent_name: r.agent_name,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)
      .eq('status', 'unverified');
    if (uErr) throw uErr;
    usedReceipts.add(String(r.id));
    linked++;
  }
  return linked;
};

const findAutoMatchesRaw = async () => {
  // Settle UTR-backed entries first so they never reach lead matching.
  await linkEntriesWithReceiptsRaw();

  const { data: entries, error: eErr } = await db
    .from('bank_audit_entries')
    .select('id, amount, payer_name, payment_id, transaction_date, project_id, receipt_id, status')
    .eq('status', 'unverified')
    .is('match_status', null)
    .order('transaction_date', { ascending: false })
    .range(0, MAX_ENTRIES_PER_RUN - 1);
  if (eErr) throw eErr;

  const { data: leads, error: lErr } = await db
    .from('fro_donor_logs')
    .select(`
      id, fro_worker_id, operator_id, amount_collected, upi_transaction_id, transaction_datetime, verified_at, created_at,
      fro_assignments!inner(
        donor_id,
        fro_worker_id,
        donor_profiles!inner(id, name, mobile_number, project_supported, pan_number, address_1, address_2, email, donors_bank_name, mop),
        workers(id, name, login_id)
      )
    `)
    .eq('action', 'disposition')
    .eq('disposition_detail', 'lead_done')
    .eq('accounts_status', 'pending')
    .order('created_at', { ascending: true })
    .range(0, MAX_LEADS_PER_RUN - 1);
  if (lErr) throw lErr;

  // Never auto-link a second receipt onto a lead that already holds one.
  const { data: existing, error: exErr } = await db
    .from('receipts')
    .select('log_id')
    .not('log_id', 'is', null);
  if (exErr) throw exErr;
  const existingLogs = new Set((existing || []).map((r) => String(r.log_id)));
  const autoLeads = (leads || []).filter((l) => !existingLogs.has(String(l.id)));

  const matched = [];
  let entryIteration = 0;
  for (const entry of entries || []) {
    entryIteration += 1;
    if (entryIteration % YIELD_EVERY === 0) await yieldNow();
    let best = null;
    let second = null;
    for (const lead of autoLeads || []) {
      const res = scoreEntryLead(entry, lead);
      if (!best || res.score > best.score) {
        second = best;
        best = { lead, ...res };
      } else if (!second || res.score > second.score) {
        second = { lead, ...res };
      }
    }
    if (best && best.score >= MIN_SCORE && (!second || best.score - second.score > MARGIN)) {
      matched.push({ kind: 'entry', entry, lead: best.lead, score: best.score, reasons: best.reasons });
    }
  }

  // ── Suspense receipt pass: auto-link anonymous money to a pending lead ──
  // Uses the same scoring engine (payment id / amount / NGO / date signals) and
  // the same thresholds. Links the receipt to the lead WITHOUT verifying it.
  const suspenseReceipts = ((await getUnlinkedReceipts()) || []).slice(0, MAX_ENTRIES_PER_RUN);
  let suspenseIteration = 0;
  for (const receipt of suspenseReceipts || []) {
    suspenseIteration += 1;
    if (suspenseIteration % YIELD_EVERY === 0) await yieldNow();
    const pseudo = {
      id: `suspense-${receipt.id}`,
      payment_id: receipt.payment_id,
      amount: receipt.amount,
      payer_name: receipt.donor_name,
      project_id: receipt.project_id,
      transaction_date: receipt.receipt_date,
    };
    let best = null;
    let second = null;
    for (const lead of autoLeads || []) {
      const res = scoreEntryLead(pseudo, lead);
      if (!best || res.score > best.score) {
        second = best;
        best = { lead, ...res };
      } else if (!second || res.score > second.score) {
        second = { lead, ...res };
      }
    }
    if (best && best.score >= MIN_SCORE && (!second || best.score - second.score > MARGIN)) {
      const matchNo = await nextMatchNo();
      await linkSuspenseToLead(receipt, best.lead);
      matched.push({
        kind: 'suspense',
        entry: { id: pseudo.id },
        match_no: matchNo,
        lead: best.lead,
        score: best.score,
        reasons: best.reasons,
      });
    }
  }

  for (const m of matched) {
    if (m.kind === 'suspense') continue;
    const matchNo = await nextMatchNo();
    await db.from('bank_audit_entries').update({
      matched_lead_log_id: m.lead.id,
      match_score: m.score,
      match_status: 'matched',
      match_no: matchNo,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', m.entry.id);
    await syncEntryToLead(m.entry.id, m.lead.id);
  }

  return {
    matched: matched.length,
    matches: matched.map((m) => ({
      entry_id: m.entry.id,
      lead_id: m.lead.id,
      score: m.score,
      reasons: m.reasons,
      kind: m.kind,
    })),
  };
};

// Public entry points: guarded so only one engine run happens at a time.
// Skipped runs return the same shape callers already handle (0 matches).
export const linkEntriesWithReceipts = () =>
  withEngineGuard('linkEntriesWithReceipts', linkEntriesWithReceiptsRaw, 0);

export const findAutoMatches = () =>
  withEngineGuard('findAutoMatches', findAutoMatchesRaw, { matched: 0, matches: [], skipped: true });
