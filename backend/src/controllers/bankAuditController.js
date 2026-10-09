import * as BankAudit from '../models/bankAuditModel.js';
import db from '../config/db.js';
import { findAutoMatches } from '../services/autoMatchService.js';
import { confirmMatchCredit } from '../services/creditService.js';
import { getDonorByMobile } from '../models/donorProfileModel.js';
import { createReceipt } from '../models/receiptModel.js';
import { sendPushNotification } from '../services/fcmService.js';
import { resolveOperatorNames } from '../services/operatorNameService.js';

async function getSourceBankName(sourceId) {
  if (!sourceId) return null;
  const { data } = await db.from('bank_audit_sources').select('name').eq('id', sourceId).maybeSingle();
  return data?.name || null;
}

// Who to stamp on a receipt this operator is settling, most specific first:
//
//   1. An impersonating admin gets their own name, so the reconciliation view
//      credits the human doing the work.
//   2. Otherwise the FRO picked on the entry.
//
// Deliberately never the CRM login agent's label: receipts are keyed by FRO, and
// a label here would split one FRO's collections across several report rows.
// Returns null when there is genuinely nobody to name, which leaves agent_name
// NULL rather than writing a placeholder like 'Unknown' that would then be
// counted as a real collector.
const resolveCollectorName = (req, froName) => {
  if (req.user?.impersonation && req.user.imposter_name) return req.user.imposter_name;
  return froName || null;
};

export const listSources = async (req, res) => {
  try {
    const sources = await BankAudit.getSources();
    return res.json(sources);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addSource = async (req, res) => {
  try {
    const { name, kind } = req.body;
    if (!name) return res.status(400).json({ message: 'Source name is required' });
    const source = await BankAudit.createSource(String(name).trim(), kind === 'mop' ? 'mop' : 'bank');
    return res.status(201).json(source);
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ message: 'Source already exists' });
    return res.status(500).json({ message: error.message });
  }
};

export const editSource = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, is_active, sort_order, kind } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (kind === 'bank' || kind === 'mop') updates.kind = kind;
    const source = await BankAudit.updateSource(id, updates);
    return res.json(source);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeSource = async (req, res) => {
  try {
    const { id } = req.params;
    await BankAudit.deleteSource(id);
    return res.json({ message: 'Source deleted' });
  } catch (error) {
    if (error.code === '23503') return res.status(400).json({ message: 'Cannot delete source with existing entries' });
    return res.status(500).json({ message: error.message });
  }
};

function currentMonthIST() {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(new Date().getTime() + istOffset);
  return istNow.getUTCFullYear() + '-' + String(istNow.getUTCMonth() + 1).padStart(2, '0');
}

// A "real" agent is any non-empty name other than the 'Suspense' marker used to
// flag receipts that still sit in the suspense pool.
const realAgentName = (name) => (name && name.trim() && name !== 'Suspense') ? name.trim() : null;

// Map a donor profile to the donor fields stored on a receipt.
const donorProfileReceipt = (d) => ({
  donor_id: d.id,
  donor_name: d.name || null,
  donor_mobile: d.mobile_number || null,
  pan_number: d.pan_number || null,
  address: [d.address_1, d.address_2].filter(Boolean).join(', ') || null,
  email: d.email || null,
  mode: d.mop || null,
  bank_name: d.donors_bank_name || null,
});

// Map a donor profile to the donor fields stored on a bank_audit_entries row.
const donorProfileEntry = (d) => ({
  donor_id: d.id,
  donor_mobile: d.mobile_number || null,
  donor_email: d.email || null,
  donor_pan: d.pan_number || null,
  donor_address_1: d.address_1 || null,
  donor_address_2: d.address_2 || null,
  donor_city: d.city || null,
  donor_pin_code: d.pin_code || null,
});

// Load a donor profile from the donor directory (used when a donor is picked
// via the Search Donor box instead of a lead).
const fetchDonorProfile = async (id) => {
  if (!id) return null;
  const { data } = await db
    .from('donor_profiles')
    .select('id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported, mop, donors_bank_name')
    .eq('id', id)
    .maybeSingle();
  return data || null;
};

// Fetch a pending lead log (fro_donor_logs) together with its donor profile +
// FRO worker so a bank audit entry can be linked to it. Throws if the log is
// already processed. If the log is already linked to a receipt (e.g. a suspense
// claim), the existing receipt id is exposed on `existing_receipt_id` so the
// save path can reuse it instead of creating a duplicate. When `currentLogId`
// matches, the pending/processed checks are skipped (idempotent edit).
const getClaimableLog = async (logId, currentLogId = null) => {
  if (!logId) return null;
    const { data: logs, error: logErr } = await db
      .from('fro_donor_logs')
      .select(`
        id, amount_collected, accounts_status, fro_worker_id, payment_mode,
        fro_assignments!inner(
          id, donor_id, fro_worker_id,
          donor_profiles!inner(id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported, mop, donors_bank_name),
          workers!inner(id, name, login_id)
        )
      `)
      .eq('id', logId)
      .limit(1);
    if (logErr) throw logErr;
    if (!logs || logs.length === 0) throw new Error('Selected lead not found');
    const log = logs[0];

  const { data: existingReceipt, error: receiptErr } = await db
    .from('receipts')
    .select('id')
    .eq('log_id', logId)
    .maybeSingle();
  if (receiptErr) throw receiptErr;
  log.existing_receipt_id = existingReceipt?.id || null;

  if (String(logId) !== String(currentLogId) && log.accounts_status !== 'pending') {
    throw new Error(`Selected lead is already ${log.accounts_status || 'processed'}`);
  }
  return log;
};

// Resolve receipt + entry fields when a lead log is linked to a bank audit
// entry, and verify the lead (clears it from the pending picker + shows in the
// donor's history). Returns null when no log is linked.
const resolveLogLink = async ({ log_id, actorId, currentLogId }) => {
  if (!log_id) return null;
  const log = await getClaimableLog(log_id, currentLogId);
  const assignment = log.fro_assignments;
  const donor = assignment?.donor_profiles || {};
  const worker = assignment?.workers || {};
  if (!donor.id) throw new Error('Selected lead has no donor info');

  const now = new Date().toISOString();
  await db.from('fro_donor_logs').update({
    accounts_status: 'verified',
    verified_at: now,
    verified_by: actorId,
  }).eq('id', log.id);

  return {
    receipt: {
      log_id: log.id,
      donor_id: donor.id,
      agent_name: worker?.name || null,
      donor_name: donor.name || null,
      donor_mobile: donor.mobile_number || null,
      pan_number: donor.pan_number || null,
      address: [donor.address_1, donor.address_2].filter(Boolean).join(', ') || null,
      email: donor.email || null,
      bank_name: donor.donors_bank_name || null,
      mode: log.payment_mode || donor.mop || 'Bank',
      project_id: donor.project_supported || null,
    },
    existing_receipt_id: log.existing_receipt_id || null,
    entry: {
      donor_id: donor.id,
      donor_mobile: donor.mobile_number || null,
      donor_email: donor.email || null,
      donor_pan: donor.pan_number || null,
      donor_address_1: donor.address_1 || null,
      donor_address_2: donor.address_2 || null,
      donor_city: donor.city || null,
      donor_pin_code: donor.pin_code || null,
    },
    lead_amount: log.amount_collected,
  };
};

export const listEntries = async (req, res) => {
  try {
    const { date_from, date_to, source_id, status } = req.query;
    const entries = await BankAudit.getEntries({ date_from, date_to, source_id, status });

    // Expose the linked receipt's agent/log/donor on each entry so the Edit
    // form can prefill the Agent dropdown and lock an already-claimed Log.
    for (const e of entries || []) {
      const r = e.receipts;
      if (r) {
        e.agent_name = r.agent_name || null;
        e.log_id = r.log_id || null;
        e.donor_id = r.donor_id || null;
        e.donor_name = r.donor_name || null;
        // The entry's own saved MOP / received bank win; a blank receipt value
        // must never blank out what Accounts set on the entry (verify copies
        // entry.mode onto the receipt anyway).
        e.mode = e.mode || r.mode || null;
        e.bank_name = e.bank_name || r.bank_name || null;
        const lead = Array.isArray(r.fro_donor_logs) ? (r.fro_donor_logs[0] || null) : r.fro_donor_logs;
        e.lead_amount = lead?.amount_collected || null;
      }
      // An entry whose receipt is still unlinked (no donor, no log) is only
      // suspense when it is "truly suspense" — BOTH the agent name and the
      // donor mobile are missing. Once an agent name OR a donor mobile is
      // attached (FRO claim / import FSE / Accounts assignment), the money is
      // handled and leaves the Accounts suspense pool, consistent with the bare
      // suspense rule in getUnlinkedReceipts.
      // A receipt with a receipt_no is also never suspense — it has been
      // accounted for regardless of the other fields.
      const hasReceipt = !!r;
      e.kind = (
        (hasReceipt && !r.donor_id && !r.log_id && !r.receipt_no
          && !BankAudit.isPriyankShahAgent(r.agent_name)
          && BankAudit.isBlankSuspenseValue(r.agent_name)
          && BankAudit.isBlankSuspenseValue(r.donor_mobile))
        || (!hasReceipt && !e.donor_id && !e.match_status && !e.matched_lead_log_id)
      )
        ? 'suspense'
        : 'entry';
      delete e.receipts;
    }

    // An entry whose linked receipt was claimed by an FRO (receipts.log_id set,
    // lead still pending) shows who made the claim on the entry card too, so
    // bank-audited claims stay visible without needing a separate suspense card.
    // Manual-verify rows also resolve the saved FRO's name for the SAVED tag.
    const mvFroIds = [...new Set((entries || []).map((e) => e.verify_fro_worker_id).filter(Boolean))];
    if (mvFroIds.length > 0) {
      const { data: mvWorkers, error: mvWorkersErr } = await db
        .from('workers').select('id, name').in('id', mvFroIds);
      if (mvWorkersErr) throw mvWorkersErr;
      const mvNameById = Object.fromEntries((mvWorkers || []).map((w) => [w.id, w.name]));
      for (const e of entries || []) {
        if (e.verify_fro_worker_id) e.verify_fro_name = mvNameById[e.verify_fro_worker_id] || null;
      }
    }
    // Receipt-linked logs drive the primary "Claimed by" tag; after a receipt
    // go-back the entry only keeps its match link, so fall back to the matched
    // lead's FRO (same pending-log rule) to keep the claim visible.
    const entryLogIds = [...new Set((entries || []).flatMap((e) => [e.log_id, e.matched_lead_log_id]).filter(Boolean))];
    if (entryLogIds.length > 0) {
      const { data: entryLogs, error: entryLogErr } = await db
        .from('fro_donor_logs')
        .select(`
          id, accounts_status, operator_id,
          workers!fro_donor_logs_fro_worker_id_fkey(name),
          fro_assignments!inner(
            donor_profiles!inner(name, mobile_number)
          )
        `)
        .in('id', entryLogIds)
        .eq('accounts_status', 'pending');
      if (entryLogErr) throw entryLogErr;
      // operator_id is the ACTOR behind the claim (Work As / cover session) and
      // has no FK — resolve it separately and prefer it over the covered FRO.
      const claimOperatorNames = await resolveOperatorNames((entryLogs || []).map((l) => l.operator_id));
      const claimedByMap = {};
      const claimedDonorMap = {};
      for (const l of entryLogs || []) {
        claimedByMap[l.id] = claimOperatorNames.get(String(l.operator_id))?.name || l.workers?.name || null;
        const donor = l.fro_assignments?.donor_profiles;
        claimedDonorMap[l.id] = donor ? { name: donor.name || null, mobile: donor.mobile_number || null } : null;
      }
      for (const e of entries || []) {
        if (e.log_id && claimedByMap[e.log_id]) e.claimed_by = claimedByMap[e.log_id];
        // Receipt gone (go-back) but the match survived — show the claimant
        // from the matched pending lead so the tag doesn't vanish.
        if (!e.claimed_by && !e.log_id && e.matched_lead_log_id && claimedByMap[e.matched_lead_log_id]) {
          e.claimed_by = claimedByMap[e.matched_lead_log_id];
        }
        const cd = (e.log_id ? claimedDonorMap[e.log_id] : null)
          || (!e.log_id && e.matched_lead_log_id ? claimedDonorMap[e.matched_lead_log_id] : null);
        if (cd) {
          e.claimed_donor_name = cd.name;
          e.claimed_donor_mobile = cd.mobile;
        }
      }
    }

    // Enrich entries that have a suggested match with the lead's donor + FRO so
    // the UI can show who the entry matched against. `match_lead` carries the
    // full donor profile (same shape as the pending-lead picker) so the Edit
    // form can auto-fill all donor details + the FRO agent on open.
    const logIds = [...new Set((entries || []).map((e) => e.matched_lead_log_id).filter(Boolean))];
    if (logIds.length > 0) {
      const { data: logs } = await db
        .from('fro_donor_logs')
        .select(`
          id, amount_collected, operator_id,
          fro_assignments!inner(
            donor_id,
            donor_profiles!inner(id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported),
            workers!inner(id, name)
          ),
          workers!fro_donor_logs_fro_worker_id_fkey(id, name)
        `)
        .in('id', logIds);
      const matchOperatorNames = await resolveOperatorNames((logs || []).map((l) => l.operator_id));
      const matchMap = {};
      for (const l of logs || []) {
        const assignment = l.fro_assignments;
        const donor = assignment?.donor_profiles || {};
        // The FRO shown here must be whoever ACTUALLY claimed: operator_id is
        // the actor during a Work As / cover session, fro_worker_id the covered
        // FRO, and the assignment owner only the last fallback — the assignment
        // stays with the owner while the claim is made from their account.
        //
        // Two different names fall out of that: `fro_name` is what a human reads
        // (Agent 21 -> their linked worker, Muskan Khan), while
        // match_lead.agent_name is PREFILLED INTO the receipt's agent_name, so it
        // must stay the agent label that receipts are already stamped with.
        const op = matchOperatorNames.get(String(l.operator_id));
        const displayName = op?.name || l.workers?.name || assignment?.workers?.name || '';
        const creditName = op?.label || op?.name || l.workers?.name || assignment?.workers?.name || '';
        const worker = { id: l.workers?.id, name: displayName };
        matchMap[l.id] = {
          donor_name: donor.name || 'Unknown',
          fro_name: worker.name || 'Unknown',
          match_lead: {
            log_id: l.id,
            amount: l.amount_collected,
            donor_id: assignment?.donor_id || null,
            donor_name: donor.name || '',
            donor_mobile: donor.mobile_number || '',
            donor_email: donor.email || '',
            donor_pan: donor.pan_number || '',
            donor_address_1: donor.address_1 || '',
            donor_address_2: donor.address_2 || '',
            donor_city: donor.city || '',
            donor_pin_code: donor.pin_code || '',
            donor_project: donor.project_supported || '',
            agent_name: creditName,
          },
        };
      }
      for (const e of entries || []) {
        const mm = e.matched_lead_log_id ? matchMap[e.matched_lead_log_id] : null;
        if (mm) {
          e.match_donor = mm.donor_name;
          e.match_fro = mm.fro_name;
          e.match_lead = mm.match_lead;
        }
      }
    }

    // NOTE: Bare suspense receipts, claimed suspense, and orphaned receipts
    // have been removed from this list. Only actual bank_audit_entries show here now.
    // The 1180+ bare receipts and claimed receipts were flooding the Suspense tab.

    return res.json(entries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addEntry = async (req, res) => {
  try {
    const { source_id, amount, payment_id, check_id, transaction_date, remarks, payer_name, payment_time, project_id, agent_name, log_id, donor_id, mode } = req.body;
    if (!source_id || !amount || !transaction_date) {
      return res.status(400).json({ message: 'Source, amount, and transaction date are required' });
    }

    const link = await resolveLogLink({ log_id, actorId: req.user.id });

    let receiptId = link?.existing_receipt_id || null;
    let receiptNo = null;

    // Resolve the received bank name from the selected source.
    const receivedBankName = await getSourceBankName(source_id);

    // When no lead is linked but a donor was picked from the donor directory,
    // the donor profile is the authoritative source for donor details (DB name,
    // not the text typed into the audit form).
    const pickedDonor = await fetchDonorProfile(donor_id);

    // If no explicit donor_id but a mobile number was provided, reverse-lookup
    // the donor profile by mobile so the entry is linked to an existing donor.
    const donorMobile = String(req.body.donor_mobile || '').replace(/[^\d]/g, '');
    const resolvedDonor = pickedDonor || (donorMobile.length >= 10 ? (await db
      .from('donor_profiles')
      .select('id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported, mop, donors_bank_name')
      .eq('mobile_number', donorMobile)
      .maybeSingle()).data || null : null);

    // The receipt's project decides its number sequence. The linked receipt /
    // picked donor win; the form value is next; never silently force 'bsct'
    // (that is what gave Ashray money the next BSCT number). When no NGO can be
    // determined, leave it null so the entry stays unnumbered instead of
    // stealing a number from the Being Sevak counter.
    const ngo = link?.receipt?.project_id || resolvedDonor?.project_supported || project_id || null;

    // Donor-derived fields for the receipt + bank_audit_entries row. A linked
    // lead wins; a picked donor profile is next; otherwise fall back to the
    // form values.
    const donorFields = link?.receipt
      ? { donor_mobile: link.receipt.donor_mobile, pan_number: link.receipt.pan_number, address: link.receipt.address, email: link.receipt.email, mode: link.receipt.mode, bank_name: link.receipt.bank_name, donor_id: link.receipt.donor_id }
      : resolvedDonor
      ? donorProfileReceipt(resolvedDonor)
      : { donor_mobile: req.body.donor_mobile || null, pan_number: req.body.donor_pan || null, address: req.body.donor_address_1 || null, email: req.body.donor_email || null, mode: null, bank_name: null, donor_id: null };
    const entryDonorFields = link?.entry
      ? { ...link.entry, donor_id: link.receipt.donor_id }
      : resolvedDonor
      ? donorProfileEntry(resolvedDonor)
      : { donor_mobile: req.body.donor_mobile || null, donor_email: req.body.donor_email || null, donor_pan: req.body.donor_pan || null, donor_address_1: req.body.donor_address_1 || null, donor_address_2: req.body.donor_address_2 || null, donor_city: req.body.donor_city || null, donor_pin_code: req.body.donor_pin_code || null, donor_id: null };

    // A bank-audit-created receipt is a suspense donation unless the creator
    // filled in BOTH an agent name and a donor (payer) name. When it stays
    // suspense, tag the receipt agent as 'Suspense' so it appears in the
    // suspense pool for an FRO to claim instead of being treated as a known
    // donation. When a lead is linked, the lead's donor + FRO are authoritative
    // (never suspense).
    const donorName = link?.receipt.donor_name || resolvedDonor?.name || payer_name || null;
    const donorKnown = !!(link || resolvedDonor);
    const priyankAgent = BankAudit.isPriyankShahAgent(agent_name);
    const agentKnown = link?.receipt.agent_name || realAgentName(agent_name);
    const suspenseAgent = (donorKnown || priyankAgent) ? (agentKnown || 'Priyank Shah') : 'Suspense';

    if (receiptId) {
      const receiptFields = {
        amount,
        project_id: link?.receipt.project_id || ngo,
        donor_name: donorName || 'Unknown',
        agent_name: suspenseAgent,
        ...donorFields,
        mode: req.body.mode || donorFields.mode || null,
        payment_id: payment_id || null,
        bank_name: receivedBankName || donorFields.bank_name || null,
        receipt_date: transaction_date,
        receipt_time: payment_time || null,
      };
      const { data: updatedReceipt, error: rErr } = await db.from('receipts').update(receiptFields).eq('id', receiptId).select('id, receipt_no').single();
      if (rErr && !updatedReceipt) throw new Error(`Failed to update linked receipt ${receiptId}: ${rErr.message}`);
      if (updatedReceipt?.receipt_no) {
        receiptNo = updatedReceipt.receipt_no;
      } else {
        receiptNo = await BankAudit.getNextReceiptNo(link?.receipt.project_id || ngo);
        const { error: numErr } = await db.from('receipts').update({ receipt_no: receiptNo }).eq('id', receiptId);
        if (numErr) throw numErr;
      }
    }
    // No receipt is created at audit-entry time — a receipt is generated only
    // when the money is verified/attributed (manual verify / verifyLead /
    // ensureReceiptNumber). This keeps one receipt per donation and prevents
    // unnumbered suspense receipts from leaking into send/claim flows.

    const entry = await BankAudit.createEntry({
      source_id,
      amount,
      payment_id: payment_id || null,
      check_id: check_id || null,
      transaction_date,
      remarks: remarks || null,
      payer_name: payer_name || null,
      payment_time: payment_time || null,
      project_id: link?.receipt.project_id || ngo,
      ...entryDonorFields,
      mode: req.body.mode || null,
      bank_name: receivedBankName || null,
      agent_name: suspenseAgent || null,
      created_by: req.user.id,
      receipt_no: receiptNo,
      receipt_id: receiptId,
    });

    findAutoMatches().catch((err) => console.error('Auto-match after addEntry failed:', err.message));

    // Notify every active FRO that a new bank-audit entry was created, so the
    // toaster fires on the FRO panel. Best effort only — a notification failure
    // must never abort the entry-creation response.
    try {
      const { data: froWorkers } = await db
        .from('workers')
        .select('id')
        .eq('department', 'fro')
        .eq('is_active', true);
      if (froWorkers && froWorkers.length) {
        const donorLabel = payer_name || link?.receipt?.donor_name || 'donor';
        await db.from('notification_log').insert(
          froWorkers.map((f) => ({
            worker_id: f.id,
            type: 'new_audit',
            title: 'New Audit Entry',
            body: `A new bank audit entry was created for ${donorLabel} (\u20B9${Number(amount).toLocaleString('en-IN')}).`,
            sent_at: new Date().toISOString(),
          }))
        );
      }
    } catch (err) { console.error('Failed to notify FROs of new audit entry:', err.message); }

    return res.status(201).json(entry);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { source_id, amount, payment_id, check_id, transaction_date, remarks, payer_name, payment_time, project_id, agent_name, log_id, donor_id, mode } = req.body;
    const updates = {};
    if (source_id !== undefined) updates.source_id = source_id;
    if (source_id !== undefined) updates.bank_name = await getSourceBankName(source_id);
    if (amount !== undefined) updates.amount = amount;
    if (payment_id !== undefined) updates.payment_id = payment_id;
    if (check_id !== undefined) updates.check_id = check_id;
    if (transaction_date !== undefined) updates.transaction_date = transaction_date;
    if (remarks !== undefined) updates.remarks = remarks;
    if (payer_name !== undefined) updates.payer_name = payer_name;
    if (payment_time !== undefined) updates.payment_time = payment_time || null;
    if (project_id !== undefined) updates.project_id = project_id;
    // Persist MOP on the audit entry itself (receipts get it below); without
    // this the edit modal keeps showing the old/blank mode after a save.
    if (mode !== undefined) updates.mode = mode || null;

    const { data: existing } = await db
      .from('bank_audit_entries')
      .select('id, receipt_id, editable_until, donor_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ message: 'Entry not found' });
    if (existing.editable_until && new Date(existing.editable_until) < new Date()) {
      return res.status(400).json({ message: 'Edit window has expired. This entry is no longer editable.' });
    }

    const { data: currentReceipt } = existing.receipt_id
      ? await db.from('receipts').select('id, log_id').eq('id', existing.receipt_id).maybeSingle()
      : { data: null };

    // Only re-resolve the log link when the user is changing to a different lead.
    // Re-saving the same log_id would flip accounts_status back to 'verified',
    // hiding the lead from the Dashboard's pending view prematurely.
    const currentLogId = currentReceipt?.log_id || null;
    const logIdChanged = log_id && String(log_id) !== String(currentLogId);
    const link = logIdChanged
      ? await resolveLogLink({ log_id, actorId: req.user.id, currentLogId })
      : null;

    // The picked lead belongs to a different receipt (a suspense claim) — never
    // point this entry's receipt at a second lead / duplicate the link.
    if (link?.existing_receipt_id && link.existing_receipt_id !== existing.receipt_id) {
      return res.status(409).json({ message: 'Selected lead is already linked to a receipt' });
    }

    // When no lead is linked but a donor was picked from the donor directory,
    // the donor profile is authoritative for donor details (DB name, not the
    // text typed into the audit form).
    const pickedDonor = await fetchDonorProfile(donor_id);
    const editDonorMobile = String(req.body.donor_mobile || '').replace(/[^\d]/g, '');
    const resolvedDonor = pickedDonor || (editDonorMobile.length >= 10 ? (await db
      .from('donor_profiles')
      .select('id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported, mop, donors_bank_name')
      .eq('mobile_number', editDonorMobile)
      .maybeSingle()).data || null : null);

    if (existing.receipt_id) {
      const receiptUpdate = {};
      if (amount !== undefined) receiptUpdate.amount = amount;
      if (mode !== undefined) receiptUpdate.mode = mode || null;
      if (source_id !== undefined) {
        const bankName = await getSourceBankName(source_id);
        if (bankName) receiptUpdate.bank_name = bankName;
      }
      if (link) {
        Object.assign(receiptUpdate, link.receipt);
        if (!receiptUpdate.project_id) receiptUpdate.project_id = project_id || 'bsct';
        if (payment_time !== undefined) receiptUpdate.receipt_time = payment_time || null;
      } else if (resolvedDonor) {
        Object.assign(receiptUpdate, donorProfileReceipt(resolvedDonor));
        if (agent_name !== undefined) {
          const effAgent = realAgentName(agent_name);
          receiptUpdate.agent_name = (effAgent && resolvedDonor.name) ? effAgent : (BankAudit.isPriyankShahAgent(agent_name) ? 'Priyank Shah' : 'Suspense');
        }
        if (project_id !== undefined) receiptUpdate.project_id = project_id || 'bsct';
      } else {
        const { data: curRec } = await db.from('receipts').select('donor_name').eq('id', existing.receipt_id).maybeSingle();
        const effDonor = payer_name !== undefined ? (payer_name || null) : (curRec?.donor_name || null);
        if (payer_name !== undefined) receiptUpdate.donor_name = effDonor;
        if (agent_name !== undefined) {
          const effAgent = realAgentName(agent_name);
          receiptUpdate.agent_name = (effAgent && effDonor) ? effAgent : (BankAudit.isPriyankShahAgent(agent_name) ? 'Priyank Shah' : 'Suspense');
        }
        if (req.body.donor_mobile !== undefined) receiptUpdate.donor_mobile = req.body.donor_mobile || null;
        if (project_id !== undefined) receiptUpdate.project_id = project_id || 'bsct';
      }
      const { error: rErr } = await db.from('receipts').update(receiptUpdate).eq('id', existing.receipt_id);
      if (rErr) throw rErr;
    }

    if (link) {
      // Lead is authoritative for donor details; amount/payment come from form.
      updates.donor_id = link.entry.donor_id;
      for (const f of ['donor_mobile', 'donor_email', 'donor_pan', 'donor_address_1', 'donor_address_2', 'donor_city', 'donor_pin_code']) {
        updates[f] = link.entry[f];
      }
    } else if (resolvedDonor) {
      Object.assign(updates, donorProfileEntry(resolvedDonor));
    } else {
      for (const f of ['donor_mobile', 'donor_email', 'donor_pan', 'donor_address_1', 'donor_address_2', 'donor_city', 'donor_pin_code']) {
        if (req.body[f] !== undefined) updates[f] = req.body[f] || null;
      }
    }

    const entry = await BankAudit.updateEntry(id, updates);

    // A donor name typed in the entry editor renames the master donor profile
    // and the linked receipt (same rule as Manual Verify / receipt edit).
    const typedName = typeof req.body.donor_name === 'string' ? req.body.donor_name.trim() : '';
    if (typedName) {
      const targetDonorId = donor_id || resolvedDonor?.id || existing.donor_id || null;
      if (targetDonorId) {
        const { data: prof } = await db
          .from('donor_profiles').select('id, name').eq('id', targetDonorId).maybeSingle();
        if (prof && prof.name !== typedName) {
          await db.from('donor_profiles').update({ name: typedName }).eq('id', prof.id);
        }
      }
      if (existing.receipt_id) {
        await db.from('receipts').update({ donor_name: typedName }).eq('id', existing.receipt_id);
      }
    }

    return res.json(entry);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { data: entry } = await db.from('bank_audit_entries').select('receipt_id').eq('id', id).maybeSingle();
    if (entry?.receipt_id) {
      await BankAudit.deleteReceiptSafely(entry.receipt_id, 'Bank audit entry deleted');
    }
    await BankAudit.deleteEntry(id);
    return res.json({ message: 'Entry deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const editSuspenseReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const { donor_name, donor_mobile, amount, receipt_date, payment_id, project_id, agent_name, log_id, mode } = req.body;
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return res.status(400).json({ message: 'Invalid suspense receipt id' });

    // Resolve a picked lead log (idempotent — suspense receipts have no log yet).
    const link = await resolveLogLink({ log_id, actorId: req.user.id });

    // If the picked lead is already linked to a receipt (a suspense claim), it
    // represents different money — never attach it to another suspense receipt.
    if (link?.existing_receipt_id && link.existing_receipt_id !== numId) {
      return res.status(409).json({ message: 'Selected lead is already linked to a receipt' });
    }

    const updates = {};
    if (link) {
      Object.assign(updates, link.receipt);
    if (donor_name !== undefined) updates.payer_name = donor_name || null;
      if (project_id !== undefined) updates.project_id = project_id || link.receipt.project_id || 'bsct';
      else if (!updates.project_id) updates.project_id = 'bsct';
    } else {
      if (donor_name !== undefined) updates.donor_name = donor_name;
      if (donor_mobile !== undefined) updates.donor_mobile = donor_mobile;
      if (agent_name !== undefined) {
        const effAgent = realAgentName(agent_name);
        updates.agent_name = (effAgent && donor_name) ? effAgent : (BankAudit.isPriyankShahAgent(agent_name) ? 'Priyank Shah' : 'Suspense');
      }
    if (project_id !== undefined) updates.project_id = project_id;
    if (mode !== undefined) updates.mode = mode || null;
    if (agent_name !== undefined) updates.agent_name = agent_name || null;
    }
    if (amount !== undefined) updates.amount = amount;
    if (receipt_date !== undefined) updates.receipt_date = receipt_date;
    if (payment_id !== undefined) updates.payment_id = payment_id;
    if (mode !== undefined) updates.mode = mode || null;

    // Claimed suspense (log_id set via an FRO claim) can also be edited here —
    // only receipts already resolved to a donor are off-limits.
    const { data, error } = await db
      .from('receipts')
      .update(updates)
      .eq('id', numId)
      .is('donor_id', null)
      .select('id, receipt_no, donor_name, donor_mobile, amount, receipt_date, payment_id, project_id, agent_name, donor_id, log_id, created_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: 'Suspense receipt not found' });

    // Keep any linked bank_audit_entries row's donor contact info in sync.
    if (link) {
      const entryUpdates = { donor_id: link.entry.donor_id, donor_mobile: link.entry.donor_mobile };
      for (const f of ['donor_email', 'donor_pan', 'donor_address_1', 'donor_address_2', 'donor_city', 'donor_pin_code']) {
        entryUpdates[f] = link.entry[f];
      }
      const { data: entry } = await db.from('bank_audit_entries').select('id').eq('receipt_id', numId).maybeSingle();
      if (entry) await BankAudit.updateEntry(entry.id, entryUpdates);
    }

    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const removeSuspenseReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return res.status(400).json({ message: 'Invalid suspense receipt id' });

    const { data: existing } = await db
      .from('receipts')
      .select('id, log_id')
      .eq('id', numId)
      .is('donor_id', null)
      .maybeSingle();
    if (!existing) return res.status(404).json({ message: 'Suspense receipt not found' });
    if (existing.log_id) return res.status(400).json({ message: 'Claimed suspense can\'t be deleted from audit; release the claim in Lead Verification first' });

    await BankAudit.deleteReceiptSafely(numId, 'Suspense receipt deleted');
    return res.json({ message: 'Suspense receipt deleted' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getSummary = async (req, res) => {
  try {
    const { date_from, date_to, status } = req.query;
    const summary = await BankAudit.getSourceSummary({ date_from, date_to, status });
    return res.json(summary);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const suggestEntries = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const entries = await BankAudit.suggestEntries(q);
    return res.json(entries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Unverified, unmatched bank audit entries for the lead-detail dropdown so
// Accounts can manually pair a lead to a bank statement row.
export const listAvailableEntries = async (req, res) => {
  try {
    const entries = await BankAudit.getAvailableEntries();
    return res.json(entries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const SUSPENSE_PREFIX = 'suspense-';

// Manually link a suspense receipt (money with no donor yet) to a lead WITHOUT
// verifying it. The lead stays 'pending'; the admin later clicks Verify, and the
// existing verifyLead flow claims the linked receipt (via log_id) and generates
// it into receipts. Mirrors the entry manual-match semantics: matched now,
// credited/verified later.
const manualMatchSuspense = async ({ rawId, logId, actorId }) => {
  const receiptId = parseInt(rawId.slice(SUSPENSE_PREFIX.length), 10);
  if (isNaN(receiptId)) throw Object.assign(new Error('Invalid suspense receipt id'), { status: 400 });

  const { data: receipt, error: rErr } = await db
    .from('receipts')
    .select('id, receipt_no, donor_name, donor_mobile, amount, receipt_date, receipt_time, project_id, payment_id, agent_name, log_id, mode, pan_number, address, email')
    .eq('id', receiptId)
    .is('donor_id', null)
    .maybeSingle();
  if (rErr) throw rErr;
  if (!receipt) throw Object.assign(new Error('Suspense receipt not found'), { status: 404 });

  // Claimed suspense (an FRO claim set receipts.log_id to a pending lead, donor
  // not resolved yet): matching it to that same lead is a no-op success — the
  // money is already attached. Matching it to a different lead would orphan the
  // FRO's pending claim, so block that instead of reporting "not found".
  if (receipt.log_id) {
    if (String(receipt.log_id) === String(logId)) {
      return { receipt, matched: true, already: true };
    }
    throw Object.assign(new Error('This suspense is already claimed — verify that claim in Lead Verification instead of re-matching'), { status: 409 });
  }

  const log = await getClaimableLog(logId);
  if (!log) throw Object.assign(new Error('Selected lead not found'), { status: 404 });

  // A lead may already hold an unclaimed link (an import or a previous match).
  // Manual matching is allowed to take over: the old unclaimed receipt is
  // unlinked and returns to the suspense pool. Auto-matched cards and credited
  // receipts are left alone.
  if (log.existing_receipt_id && log.existing_receipt_id !== receiptId) {
    const { data: existing, error: ee } = await db
      .from('receipts')
      .select('id, donor_id, log_id')
      .eq('id', log.existing_receipt_id)
      .maybeSingle();
    if (ee) throw ee;
    if (!existing || existing.donor_id) {
      throw Object.assign(new Error('Selected lead is already linked to a credited receipt'), { status: 409 });
    }
    await db.from('receipts').update({ log_id: null }).eq('id', existing.id);
  }

  const donor = log.fro_assignments?.donor_profiles || {};
  const worker = log.fro_assignments?.workers || {};
  if (!donor.id) throw Object.assign(new Error('Selected lead has no donor info'), { status: 400 });

  try { await BankAudit.enrichDonorProfileFromReceipt(donor.id, receipt); }
  catch (e) { console.error('Failed to enrich donor profile from suspense receipt:', e.message); }

  const matchNo = await BankAudit.nextMatchNo();

  const receiptPatch = {
    ...donorProfileReceipt(donor),
    log_id: log.id,
    agent_name: worker?.name || null,
    project_id: receipt.project_id || donor.project_supported || 'bsct',
    mode: log.payment_mode || donor.mop || 'Bank',
  };
  if (!receiptPatch.donor_name) receiptPatch.donor_name = receipt.donor_name || null;

  const { data, error } = await db
    .from('receipts')
    .update(receiptPatch)
    .eq('id', receiptId)
    .is('donor_id', null)
    .is('log_id', null)
    .select('id, receipt_no, donor_name, donor_mobile, amount, receipt_date, payment_id, project_id, agent_name, donor_id, log_id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw Object.assign(new Error('Suspense receipt already claimed'), { status: 409 });

  // Override the lead's payment fields from the receipt (mirror of
  // syncEntryToLead): the audit/receipt data always wins over the lead's.
  const { data: leadPay } = await db
    .from('fro_donor_logs')
    .select('upi_transaction_id, payment_from, transaction_datetime, payment_mode')
    .eq('id', logId)
    .maybeSingle();
  const patch = {};
  if (leadPay) {
    if (receipt.payment_id) patch.upi_transaction_id = receipt.payment_id;
    if (receipt.donor_name) patch.payment_from = receipt.donor_name;
    if (receipt.receipt_date) {
      patch.transaction_datetime = receipt.receipt_time
        ? `${receipt.receipt_date}T${receipt.receipt_time}`
        : receipt.receipt_date;
    }
    patch.payment_mode = receipt.mode || (receipt.payment_id ? 'UPI' : 'Bank Transfer');
  }
  if (Object.keys(patch).length > 0) {
    await db.from('fro_donor_logs').update(patch).eq('id', logId);
  }

  // Keep any linked bank_audit_entries row in sync (rare for pool suspense).
  const { data: entry } = await db.from('bank_audit_entries').select('id').eq('receipt_id', receiptId).maybeSingle();
  if (entry) {
    await db.from('bank_audit_entries').update({
      matched_lead_log_id: logId,
      match_status: 'matched',
      match_source: 'manual',
      matched_by: actorId,
      match_no: matchNo,
      matched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...donorProfileEntry(donor),
    }).eq('id', entry.id);
  }

  return { receipt: data, match_no: matchNo, matched: true };
};

// Link an entry to a lead as a MANUAL match (no credit yet). The credit happens
// later through the bank audit Confirm Match or the lead's verify action.
export const manualMatch = async (req, res) => {
  try {
    const { id } = req.params;
    const { log_id: logId } = req.body || {};
    if (!logId) return res.status(400).json({ message: 'log_id is required' });

    if (String(id).startsWith(SUSPENSE_PREFIX)) {
      const result = await manualMatchSuspense({ rawId: String(id), logId, actorId: req.user.id });
      return res.json(result);
    }

    const { data: entry, error: entryErr } = await db
      .from('bank_audit_entries')
      .select('id, status, match_status, match_source, matched_lead_log_id')
      .eq('id', id)
      .maybeSingle();
    if (entryErr) throw entryErr;
    if (!entry) return res.status(404).json({ message: 'Bank audit entry not found' });
    if (entry.status === 'verified') return res.status(400).json({ message: 'This bank audit entry is already verified' });
    if (entry.match_status && String(entry.matched_lead_log_id) !== String(logId)) {
      if (entry.match_source === 'auto' || entry.match_status === 'confirmed') {
        const msg = entry.match_status === 'confirmed'
          ? 'This bank audit entry is confirmed — leave it'
          : 'This bank audit entry is auto-matched — leave it';
        return res.status(409).json({ message: msg });
      }
    }

    const result = await BankAudit.manualMatchEntry(id, logId, req.user.id);
    return res.json(result);
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({ message: error.message });
  }
};

export const markEntryVerified = async (req, res) => {
  try {
    const { id } = req.params;
    const entry = await BankAudit.verifyEntry(id);
    return res.json(entry);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Save the FRO + donor details typed into the Manual Verify form onto the bank
// audit entry WITHOUT verifying it or generating a receipt — a draft save so
// Accounts can resume the verify later without re-entering the details.
export const saveManualVerifyDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fro_worker_id, donor_mobile, donor_name, donor_address, donor_pan,
      donor_email, donor_city, donor_pin_code, donor_address_2, donor_id,
      verify_type, verify_fro_worker_id,
    } = req.body || {};

    const isSuspense = String(id).startsWith(SUSPENSE_PREFIX);
    const receiptId = isSuspense ? parseInt(id.replace(SUSPENSE_PREFIX, ''), 10) : null;

    if (isSuspense) {
      const { data: receipt, error: rErr } = await db
        .from('receipts').select('*').eq('id', receiptId).maybeSingle();
      if (rErr) throw rErr;
      if (!receipt) return res.status(404).json({ message: 'Suspense receipt not found' });

      const updates = {};
      if (donor_mobile !== undefined) updates.donor_mobile = donor_mobile ? String(donor_mobile).replace(/[^\d]/g, '') || null : null;
      if (donor_name !== undefined) updates.donor_name = donor_name || null;
      if (donor_pan !== undefined) updates.pan_number = donor_pan || null;
      if (donor_address !== undefined) updates.address = donor_address || null;
      if (donor_email !== undefined) updates.email = donor_email || null;

      if (fro_worker_id) {
        const isStaticFro = String(fro_worker_id).startsWith('static-');
        if (!isStaticFro) {
          const { data: worker } = await db.from('workers').select('name').eq('id', fro_worker_id).maybeSingle();
          if (worker?.name) updates.agent_name = worker.name;
        }
      }
      if (verify_type !== undefined) updates.verify_type = verify_type || null;
      if (verify_fro_worker_id !== undefined) updates.verify_fro_worker_id = verify_fro_worker_id || null;

      if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'Nothing to save' });
      const { data: saved, error: uErr } = await db.from('receipts').update(updates).eq('id', receiptId).select().single();
      if (uErr) throw uErr;

      // Edited MV name renames the linked master donor profile too.
      const typedName = (donor_name || '').trim();
      if (typedName && donor_id) {
        const { data: prof } = await db
          .from('donor_profiles').select('id, name').eq('id', donor_id).maybeSingle();
        if (prof && prof.name !== typedName) {
          await db.from('donor_profiles').update({ name: typedName }).eq('id', prof.id);
        }
      }

      return res.json(saved);
    }

    const { data: entry, error: eErr } = await db
      .from('bank_audit_entries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (eErr) throw eErr;
    if (!entry) return res.status(404).json({ message: 'Bank audit entry not found' });

    const updates = {};

    if (fro_worker_id) {
      const isStaticFro = String(fro_worker_id).startsWith('static-');
      let froName = null;
      if (isStaticFro) {
        froName = fro_worker_id === 'static-priyank-shah' ? 'Priyank Shah' : fro_worker_id === 'static-suspense' ? 'Suspense' : null;
      } else {
        const { data: worker } = await db
          .from('workers')
          .select('name')
          .eq('id', fro_worker_id)
          .maybeSingle();
        if (worker?.name) froName = worker.name;
      }
      // When impersonating, stamp the operator's name as agent.
      if (req.user?.impersonation && req.user.imposter_name) froName = req.user.imposter_name;
      if (froName) updates.agent_name = froName;
    }

    if (verify_type !== undefined) updates.verify_type = verify_type || null;
    if (verify_fro_worker_id !== undefined) updates.verify_fro_worker_id = verify_fro_worker_id || null;
    // Saving an FRO via the MV form stamps the verify type when none is set
    // (the Type dropdown is gone) so tiles can show the SAVED tag.
    if (fro_worker_id && !entry.verify_type && updates.verify_type === undefined) updates.verify_type = 'fro';

    if (donor_mobile !== undefined) updates.donor_mobile = donor_mobile ? String(donor_mobile).replace(/[^\d]/g, '') || null : null;
    // donor_name intentionally does NOT touch payer_name — the bank statement
    // name is immutable here. The typed donor name lands in mv_donor_name so
    // reopening the MV form prefills it (verify still uses it for the donor
    // profile / receipt).
    if (donor_name !== undefined) updates.mv_donor_name = donor_name || null;
    if (donor_address !== undefined) updates.donor_address_1 = donor_address || null;
    if (donor_address_2 !== undefined) updates.donor_address_2 = donor_address_2 || null;
    if (donor_pan !== undefined) updates.donor_pan = donor_pan || null;
    if (donor_email !== undefined) updates.donor_email = donor_email || null;
    if (donor_city !== undefined) updates.donor_city = donor_city || null;
    if (donor_pin_code !== undefined) updates.donor_pin_code = donor_pin_code || null;
    if (donor_id !== undefined) updates.donor_id = donor_id || null;

    if (Object.keys(updates).length === 0) return res.status(400).json({ message: 'Nothing to save' });

    const saved = await BankAudit.updateEntry(id, updates);

    // An edited MV donor name renames the master donor profile immediately
    // (Save button / auto-save), not only at verify time.
    const typedName = typeof donor_name === 'string' ? donor_name.trim() : '';
    if (typedName && (donor_id || entry.donor_id)) {
      const { data: prof } = await db
        .from('donor_profiles').select('id, name').eq('id', donor_id || entry.donor_id).maybeSingle();
      if (prof && prof.name !== typedName) {
        await db.from('donor_profiles').update({ name: typedName }).eq('id', prof.id);
      }
    }

    // Sync the linked receipt so the kind check (listEntries) sees updated
    // values and moves the entry out of the Suspense pool.
    if (entry.receipt_id) {
      const rcptUpdates = {};
      if (updates.agent_name !== undefined) rcptUpdates.agent_name = updates.agent_name;
      if (updates.donor_mobile !== undefined) rcptUpdates.donor_mobile = updates.donor_mobile;
      if (typedName) rcptUpdates.donor_name = typedName;
      if (updates.donor_pan !== undefined) rcptUpdates.pan_number = updates.donor_pan;
      if (updates.donor_address_1 !== undefined) rcptUpdates.address = updates.donor_address_1;
      if (updates.donor_email !== undefined) rcptUpdates.email = updates.donor_email;
      if (updates.donor_id !== undefined) rcptUpdates.donor_id = updates.donor_id || null;
      if (Object.keys(rcptUpdates).length > 0) {
        await db.from('receipts').update(rcptUpdates).eq('id', entry.receipt_id);
      }
    }

    return res.json(saved);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Manual Verify: attribute an unmatched bank audit entry to a specific FRO +
// donor. Some FROs record donations on a PC (no FRO-app log row exists), so
// Accounts picks the FRO and the donor's mobile. The flow resolves-or-creates
// the donor, assigns it to the FRO, writes a verified donation log (crediting
// the FRO + adding to donor history), settles the bank entry, and generates a
// receipt.
export const manualVerifyEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fro_worker_id, donor_mobile, donor_name, donor_address, donor_pan,
      donor_email, donor_city, donor_pin_code, donor_address_2, project_id,
      verify_type, verify_fro_worker_id, credit_to_fro_worker_id, donor_id,
    } = req.body || {};

    const mobile = String(donor_mobile || '').replace(/[^\d]/g, '');
    if (mobile.length < 10) return res.status(400).json({ message: 'Please enter a valid donor mobile number' });

    // ── Suspense receipt path ──────────────────────────────────────
    const isSuspense = String(id).startsWith(SUSPENSE_PREFIX);
    if (isSuspense) {
      const receiptId = parseInt(id.replace(SUSPENSE_PREFIX, ''), 10);
      const { data: receipt, error: rErr } = await db
        .from('receipts').select('*').eq('id', receiptId).maybeSingle();
      if (rErr) throw rErr;
      if (!receipt) return res.status(404).json({ message: 'Suspense receipt not found' });

      // Resolve or create donor
      const { data: existingDonor } = await db
        .from('donor_profiles').select('*').eq('mobile_number', mobile).maybeSingle();
      let donorId = existingDonor?.id || null;
      const donorName = (donor_name || existingDonor?.name || 'Unknown').trim();
      const donorAddress = donor_address || existingDonor?.address_1 || null;
      const donorPan = donor_pan || existingDonor?.pan_number || null;
      const donorEmail = donor_email || existingDonor?.email || null;

      // Explicit name edit on the MV form renames the master donor profile
      // (same rule as the verify action) instead of being silently ignored.
      if (existingDonor) {
        const patch = {};
        const typedName = (donor_name || '').trim();
        if (typedName && existingDonor.name !== typedName) patch.name = typedName;
        if (!existingDonor.address_1 && donor_address) patch.address_1 = donor_address;
        if (!existingDonor.pan_number && donor_pan) patch.pan_number = donor_pan;
        if (!existingDonor.email && donor_email) patch.email = donor_email;
        if (Object.keys(patch).length > 0) await db.from('donor_profiles').update(patch).eq('id', donorId);
      } else {
        const { data: newDonor } = await db.from('donor_profiles').insert({
          name: donorName, mobile_number: mobile,
          address_1: donorAddress, pan_number: donorPan, email: donorEmail,
          project_supported: receipt.project_id || 'bsct',
        }).select('id').single();
        donorId = newDonor?.id || null;
      }

      // Update the receipt with donor info
      const receiptPatch = { donor_name: donorName, donor_mobile: mobile, donor_id: donorId };
      if (donorPan) receiptPatch.pan_number = donorPan;
      if (donorAddress) receiptPatch.address = donorAddress;
      if (donorEmail) receiptPatch.email = donorEmail;

      // Assign receipt number if missing
      if (!receipt.receipt_no) {
        const receiptNo = await BankAudit.getNextReceiptNo(receipt.project_id || 'bsct');
        receiptPatch.receipt_no = receiptNo;
      }

      await db.from('receipts').update(receiptPatch).eq('id', receiptId);

      // If this receipt was claimed by an FRO (has a log_id), mark the lead
      // as verified so it disappears from the pending Leads list.
      if (receipt.log_id) {
        try {
          await db.from('fro_donor_logs')
            .update({ accounts_status: 'verified', verified_at: new Date().toISOString(), verified_by: req.user?.id || null })
            .eq('id', receipt.log_id)
            .eq('accounts_status', 'pending');
        } catch (e) { console.error('Failed to verify claimed lead from suspense receipt:', e.message); }
      }

      return res.json({
        message: `Suspense receipt verified. Receipt No: ${receiptPatch.receipt_no || receipt.receipt_no || ''}`,
        receipt_no: receiptPatch.receipt_no || receipt.receipt_no,
        receipt_id: receiptId,
        donor_id: donorId,
      });
    }

    // ── Regular bank audit entry path ──────────────────────────────
    // Load the bank audit entry.
    const { data: entry, error: eErr } = await db
      .from('bank_audit_entries')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (eErr) throw eErr;
    if (!entry) return res.status(404).json({ message: 'Bank audit entry not found' });
    if (entry.status === 'verified') {
      const proj = entry.project_id || 'bsct';

      // If this entry was linked to a claimed lead, mark the claim as verified.
      if (entry.matched_lead_log_id) {
        try {
          await db.from('fro_donor_logs')
            .update({ accounts_status: 'verified', verified_at: new Date().toISOString(), verified_by: req.user.id })
            .eq('id', entry.matched_lead_log_id)
            .eq('accounts_status', 'pending');
        } catch (e) { console.error('Failed to verify claimed lead from already-verified entry:', e.message); }
      }

      // Case 1: receipt is linked — just assign a number if missing
      if (entry.receipt_id) {
        const { data: rcpt } = await db.from('receipts')
          .select('id, receipt_no, project_id').eq('id', entry.receipt_id).maybeSingle();
        if (rcpt && !rcpt.receipt_no) {
          const receiptNo = await BankAudit.getNextReceiptNo(proj);
          await db.from('receipts').update({ receipt_no: receiptNo }).eq('id', rcpt.id);
          await db.from('bank_audit_entries').update({ receipt_no: receiptNo }).eq('id', id);
          return res.json({ message: 'Entry was already verified — receipt number assigned.', receipt_no: receiptNo, receipt_id: rcpt.id });
        }
        if (rcpt?.receipt_no) {
          return res.status(400).json({ message: `Already verified. Receipt No: ${rcpt.receipt_no}`, receipt_no: rcpt.receipt_no });
        }
      }

      // Case 2: no receipt linked — create one from the entry's data
      const receiptNo = await BankAudit.getNextReceiptNo(proj);
      // The entry's own FRO, else the FRO the donor actually sits with. Without
      // this the receipt is born with a NULL agent_name and never counts towards
      // anyone's collection -- which is how receipts end up reading "Not assigned".
      let entryCollector = String(entry.agent_name || '').trim() || null;
      if (!entryCollector) {
        const donorForEntry = entry.donor_id || null;
        if (donorForEntry) {
          const { data: asgRows } = await db
            .from('fro_assignments')
            .select('workers(name)')
            .eq('donor_id', donorForEntry)
            .not('status', 'eq', 'reassigned')
            .order('updated_at', { ascending: false })
            .limit(1);
          entryCollector = asgRows?.[0]?.workers?.name || null;
        }
      }

      const receipt = await createReceipt({
        receipt_no: receiptNo,
        project_id: proj,
        donor_name: entry.payer_name || entry.donor_name || 'Unknown',
        donor_mobile: entry.donor_mobile || null,
        amount: entry.amount || 0,
        pan_number: entry.donor_pan || null,
        address: [entry.donor_address_1, entry.donor_address_2].filter(Boolean).join(', ') || null,
        email: entry.donor_email || null,
        bank_name: entry.bank_name || null,
        mode: entry.mode || null,
        payment_id: entry.payment_id || null,
        agent_name: entryCollector,
        purpose: 'Bank Audit Entry',
        generated_by: req.user.id,
        receipt_date: entry.transaction_date || new Date().toISOString(),
        receipt_time: entry.payment_time || null,
        donor_id: entry.donor_id || null,
      });
      await db.from('bank_audit_entries').update({ receipt_id: receipt.id, receipt_no: receiptNo }).eq('id', id);
      return res.json({ message: 'Entry was already verified — receipt created and number assigned.', receipt_no: receiptNo, receipt_id: receipt.id });
    }

    // Resolve the FRO worker (must be an FRO) — optional for receipt_sent flow.
    // `null` when the receipt_sent flow sends none: writing the placeholder
    // 'Unknown' would make an unassigned receipt look assigned to a person.
    const isStaticFro = fro_worker_id ? String(fro_worker_id).startsWith('static-') : false;
    let froName = null;
    let workerId = fro_worker_id || null;
    if (fro_worker_id) {
      if (isStaticFro) {
        froName = fro_worker_id === 'static-priyank-shah' ? 'Priyank Shah' : fro_worker_id === 'static-suspense' ? 'Suspense' : null;
        workerId = null;
      } else {
        const { data: worker, error: wErr } = await db
          .from('workers')
          .select('id, name, login_id, department, is_active')
          .eq('id', fro_worker_id)
          .maybeSingle();
        if (wErr) throw wErr;
        if (!worker || worker.is_active === false) return res.status(404).json({ message: 'Selected FRO not found' });
        froName = worker.name || null;
      }
    }
    // When impersonating, stamp the operator's name as agent so the
    // bank reconciliation view credits the actual person doing the work.
    if (req.user?.impersonation && req.user.imposter_name) {
      froName = req.user.imposter_name;
      if (req.user.imposter_id) workerId = req.user.imposter_id;
    }
    const collectorName = resolveCollectorName(req, froName);

    // Resolve the original owner's name for cross-FRO verify notes.
    let credit_to_fro_worker_name = null;
    if (credit_to_fro_worker_id && credit_to_fro_worker_id !== fro_worker_id) {
      const { data: ownerWorker } = await db
        .from('workers')
        .select('name')
        .eq('id', credit_to_fro_worker_id)
        .maybeSingle();
      credit_to_fro_worker_name = ownerWorker?.name || null;
    }

    const amount = Number(entry.amount || 0);
    const now = new Date().toISOString();
    const VALID_PROJECT_OVERRIDES = ['library', 'pg'];
    // Never silently force 'bsct' as the number sequence: an entry whose NGO is
    // unknown (e.g. Ashray money with no resolvable project) must NOT draw from
    // the Being Sevak counter. Require the NGO before numbering instead.
    const project = (project_id && VALID_PROJECT_OVERRIDES.includes(project_id)) ? project_id : BankAudit.canonicalProject(entry.project_id || req.body.project_id || null);
    if (!project) {
      return res.status(400).json({ message: 'Receipt NGO is unknown. Please set the NGO for this entry before verifying.' });
    }
    const entryAddress = [entry.donor_address_1, entry.donor_address_2].filter(Boolean).join(', ') || null;
    const ngoId = await BankAudit.ngoIdFromProjectId(project);

    // Compute editable_until = end of current month for static FROs.
    const editableUntil = isStaticFro ? (() => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).toISOString();
    })() : null;

    const result = await db.transaction(async ({ from }) => {
      // Resolve or create the donor profile — prefer explicit donor_id if provided.
      let donor = donor_id ? (await db.from('donor_profiles').select('*').eq('id', donor_id).maybeSingle()).data : null;
      if (!donor) donor = await getDonorByMobile(mobile);
      if (!donor) {
        const { data: created, error: dErr } = await from('donor_profiles').insert({
          name: (donor_name || entry.payer_name || 'Unknown').trim(),
          mobile_number: mobile,
          address_1: donor_address || entryAddress || null,
          address_2: donor_address_2 || null,
          pan_number: donor_pan || entry.donor_pan || null,
          email: donor_email || entry.donor_email || null,
          city: donor_city || null,
          pin_code: donor_pin_code || null,
          project_supported: project,
        }).select().single();
        if (dErr) throw dErr;
        donor = created;
      } else {
        // Fill blanks on an existing donor (only where currently empty).
        const patch = {};
        if (donor_address && !donor.address_1) patch.address_1 = donor_address;
        else if (entryAddress && !donor.address_1) patch.address_1 = entryAddress;
        if (donor_address_2 && !donor.address_2) patch.address_2 = donor_address_2;
        if (donor_pan && !donor.pan_number) patch.pan_number = donor_pan;
        else if (entry.donor_pan && !donor.pan_number) patch.pan_number = entry.donor_pan;
        if (donor_name && donor.name !== donor_name.trim()) patch.name = donor_name.trim();
        if (donor_email && !donor.email) patch.email = donor_email;
        else if (entry.donor_email && !donor.email) patch.email = entry.donor_email;
        if (donor_city && !donor.city) patch.city = donor_city;
        if (donor_pin_code && !donor.pin_code) patch.pin_code = donor_pin_code;
        if (Object.keys(patch).length > 0) {
          patch.updated_at = now;
          await from('donor_profiles').update(patch).eq('id', donor.id);
        }
      }
      const donorId = donor.id;

      // ── No FRO selected → "receipt_sent" path ──────────────────────────────
      // Receipt is generated so the donor can receive it, but no FRO is credited
      // yet. The entry stays visible for an FRO to claim later.
      if (!fro_worker_id) {
        const receiptNo = await BankAudit.getNextReceiptNo(project);
        const receipt = await createReceipt({
          receipt_no: receiptNo,
          project_id: project,
          donor_name: (donor_name || entry.payer_name || donor.name || 'Unknown').trim(),
          donor_mobile: mobile,
          amount,
          pan_number: donor_pan || entry.donor_pan || donor.pan_number || null,
          address: donor_address || entryAddress || donor.address_1 || null,
          email: donor_email || entry.donor_email || donor.email || null,
          bank_name: entry.bank_name || donor.donors_bank_name || null,
          mode: entry.mode || null,
          payment_id: entry.payment_id || null,
          agent_name: null,
          purpose: 'Bank Audit Manual Verify (Receipt Sent)',
          generated_by: req.user.id,
          donor_id: donorId,
          receipt_date: entry.transaction_date || now,
          receipt_time: entry.payment_time || null,
        });

        await from('bank_audit_entries').update({
          status: 'receipt_sent',
          receipt_id: receipt.id,
          receipt_no: receipt.receipt_no || null,
          donor_id: donorId,
          payer_name: entry.payer_name || donor.name || null,
          donor_mobile: mobile,
          donor_email: donor_email || entry.donor_email || donor.email || null,
          donor_pan: donor_pan || entry.donor_pan || donor.pan_number || null,
          donor_address_1: donor_address || entryAddress || donor.address_1 || null,
          donor_address_2: donor_address_2 || donor.address_2 || null,
          updated_at: now,
        }).eq('id', entry.id);

        return { receiptSent: true, donorId, amount, receipt };
      }

      // ── FRO provided → existing full-verify path ───────────────────────────
      let logId = null;
      if (!isStaticFro) {
        // CROSS-FRO VERIFY: when credit_to_fro_worker_id is provided and differs
        // from fro_worker_id, the donor already belongs to another FRO (the original
        // owner). We use the original owner's existing assignment for the log, but
        // credit goes to the verifying FRO (fro_worker_id). No new assignment is created.
        let isCrossFro = !!(credit_to_fro_worker_id && credit_to_fro_worker_id !== fro_worker_id);
        let assignment = null;

        if (isCrossFro) {
          // Find the ORIGINAL OWNER's existing assignment.
          let ownerAsgnQuery = from('fro_assignments')
            .select('id')
            .eq('donor_id', donorId)
            .eq('fro_worker_id', credit_to_fro_worker_id)
            .or('status.neq.reassigned,status.is.null')
            .order('assigned_at', { ascending: false })
            .limit(1);
          if (ngoId) ownerAsgnQuery = ownerAsgnQuery.eq('ngo_id', ngoId);
          const { data: ownerAsgn } = await ownerAsgnQuery.maybeSingle();
          if (ownerAsgn) {
            assignment = ownerAsgn;
          } else {
            // Original owner has no assignment — fall back to normal flow.
            isCrossFro = false;
          }
        }

        if (!isCrossFro) {
          // Normal flow: find or create an open assignment linking donor + FRO + NGO.
          let asgnQuery = from('fro_assignments')
            .select('id')
            .eq('donor_id', donorId)
            .eq('fro_worker_id', fro_worker_id)
            .or('status.neq.reassigned,status.is.null')
            .order('assigned_at', { ascending: false })
            .limit(1);
          if (ngoId) asgnQuery = asgnQuery.eq('ngo_id', ngoId);
          const { data: existingAsgn } = await asgnQuery.maybeSingle();
          assignment = existingAsgn || null;
          if (!assignment && ngoId) {
            const { data: anyActive } = await from('fro_assignments')
              .select('id')
              .eq('donor_id', donorId)
              .eq('ngo_id', ngoId)
              .or('status.neq.reassigned,status.is.null')
              .order('assigned_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (anyActive) {
              assignment = anyActive;
            }
          }
          if (!assignment) {
            const { data: createdAsgn, error: asErr } = await from('fro_assignments').insert({
              donor_id: donorId,
              fro_worker_id: fro_worker_id,
              ngo_id: ngoId,
              status: 'donation_collected',
              assigned_by: null,
            }).select().single();
            if (asErr) throw asErr;
            assignment = createdAsgn;
          }
        }

        // Write the verified donation log -> credits the VERIFYING FRO.
        // In cross-FRO mode: assignment_id = original owner's, fro_worker_id = verifier.
        const { data: log, error: lErr } = await from('fro_donor_logs').insert({
          assignment_id: assignment.id,
          donor_id: donorId,
          fro_worker_id: fro_worker_id,
          action: 'donation',
          amount_collected: amount,
          payment_mode: entry.mode || (entry.payment_id ? 'UPI' : 'Bank Transfer'),
          upi_transaction_id: entry.payment_id || null,
          payment_from: entry.payer_name || null,
          transaction_datetime: entry.transaction_date || now,
          accounts_status: 'verified',
          verified_at: now,
          verified_by: req.user.id,
          created_by: req.user.id,
          notes: isCrossFro
            ? `Cross-FRO verify: ${froName} verified donor of ${credit_to_fro_worker_name || 'another FRO'} (${entry.payment_id || 'N/A'})`
            : `Manually verified from bank audit entry (${entry.payment_id || 'N/A'})`,
        }).select().single();
        if (lErr) throw lErr;
        logId = log.id;

        // Increment donor totals.
        await from('donor_profiles').update({
          total_amount: Math.round(((donor.total_amount || 0) + amount) * 100) / 100,
          donation_count: (donor.donation_count || 0) + 1,
          last_donation_date: entry.transaction_date || now.slice(0, 10),
          updated_at: now,
        }).eq('id', donorId);
      }

      // Settle the bank audit entry.
      const matchNo = await BankAudit.nextMatchNo();
      const entryPatch = {
        status: 'verified',
        donor_id: donorId,
        agent_name: collectorName,
        match_status: isStaticFro ? 'matched' : 'confirmed',
        match_source: 'manual',
        match_no: matchNo,
        matched_by: req.user.id,
        matched_at: now,
        updated_at: now,
        payer_name: entry.payer_name || donor.name || null,
        donor_mobile: mobile,
        donor_email: donor_email || entry.donor_email || donor.email || null,
        donor_pan: donor_pan || entry.donor_pan || donor.pan_number || null,
        donor_address_1: donor_address || entryAddress || donor.address_1 || null,
        donor_address_2: donor_address_2 || donor.address_2 || null,
        donor_city: donor_city || donor.city || null,
        donor_pin_code: donor_pin_code || donor.pin_code || null,
      };
      if (verify_type) entryPatch.verify_type = verify_type;
      if (verify_fro_worker_id) entryPatch.verify_fro_worker_id = verify_fro_worker_id;
      if (credit_to_fro_worker_id && credit_to_fro_worker_id !== fro_worker_id) {
        entryPatch.verify_type = 'cross_fro';
        entryPatch.verify_fro_worker_id = credit_to_fro_worker_id;
      }
      if (editableUntil) entryPatch.editable_until = editableUntil;
      if (isStaticFro) entryPatch.match_source = 'static_fro';
      await from('bank_audit_entries').update(entryPatch).eq('id', entry.id);

      // Generate the receipt (uses the entered address/PAN where available).
      // Reuse the entry's existing receipt if one exists — never create a second
      // receipt for the same money (fixes duplicate receipts on re-verify).
      let receipt = null;
      if (entry.receipt_id) {
        const { data: existingReceipt } = await from('receipts')
          .select('id, receipt_no')
          .eq('id', entry.receipt_id)
          .maybeSingle();
        if (existingReceipt) {
          const patch = {
            receipt_no: existingReceipt.receipt_no || await BankAudit.getNextReceiptNo(project),
            donor_name: (donor_name || entry.payer_name || donor.name || 'Unknown').trim(),
            donor_mobile: mobile,
            amount,
            pan_number: donor_pan || entry.donor_pan || donor.pan_number || null,
            address: donor_address || entryAddress || null,
            email: donor_email || entry.donor_email || donor.email || null,
            bank_name: entry.bank_name || donor.donors_bank_name || null,
            mode: entry.mode || null,
            payment_id: entry.payment_id || null,
            agent_name: collectorName,
            donor_id: donorId,
            receipt_date: entry.transaction_date || now,
            receipt_time: entry.payment_time || null,
          };
          if (logId) patch.log_id = logId;
          const { data: upReceipt } = await from('receipts').update(patch).eq('id', existingReceipt.id).select().single();
          receipt = upReceipt;
        }
      }
      if (!receipt) {
        receipt = await createReceipt({
          log_id: logId,
          receipt_no: await BankAudit.getNextReceiptNo(project),
          project_id: project,
          donor_name: (donor_name || entry.payer_name || donor.name || 'Unknown').trim(),
          donor_mobile: mobile,
          amount,
          pan_number: donor_pan || entry.donor_pan || donor.pan_number || null,
          address: donor_address || entryAddress || null,
          email: donor_email || entry.donor_email || donor.email || null,
          bank_name: entry.bank_name || donor.donors_bank_name || null,
          mode: entry.mode || null,
          payment_id: entry.payment_id || null,
          agent_name: collectorName,
          purpose: 'Bank Audit Manual Verify',
          generated_by: req.user.id,
          donor_id: donorId,
          receipt_date: entry.transaction_date || now,
          receipt_time: entry.payment_time || null,
        });
      }

      await from('bank_audit_entries').update({
        receipt_id: receipt.id,
        receipt_no: receipt.receipt_no || null,
      }).eq('id', entry.id);

      // If this entry was linked to a claimed lead, mark the claim as verified
      // so it no longer shows in Leads as pending.
      if (entry.matched_lead_log_id) {
        try {
          await from('fro_donor_logs')
            .update({ accounts_status: 'verified', verified_at: now, verified_by: req.user.id })
            .eq('id', entry.matched_lead_log_id)
            .eq('accounts_status', 'pending');
        } catch (e) { console.error('Failed to verify claimed lead from manual verify:', e.message); }
      }

      return { logId, donorId, amount, match_no: matchNo, receipt };
    });

    // Notify the FRO (FCM + notification_log) — only when an FRO was selected.
    if (fro_worker_id && !isStaticFro) {
      try {
        const notifTitle = 'Lead Verified';
        const notifBody = `Your lead for ${result.receipt?.donor_name || 'donor'} (\u20B9${amount.toLocaleString('en-IN')}) was verified. Receipt: ${result.receipt?.receipt_no || ''}`;
        let fcmLogged = false;
        try {
          const pushResult = await sendPushNotification(fro_worker_id, notifTitle, notifBody, 'lead_verified', result.logId);
          fcmLogged = !!pushResult;
        } catch (err) { console.error('FCM send error:', err.message); }
        if (!fcmLogged) {
          await db.from('notification_log').insert({
            worker_id: fro_worker_id,
            type: 'lead_verified',
            title: notifTitle,
            body: notifBody,
            fro_donor_log_id: String(result.logId),
            sent_at: now,
          });
        }
      } catch (err) { console.error('Failed to create verified notification:', err.message); }
    }

    if (result.receiptSent) {
      return res.json({
        message: 'Receipt generated. FRO can claim later.',
        donor_id: result.donorId,
        receipt_no: result.receipt?.receipt_no || null,
        receipt_id: result.receipt?.id || null,
      });
    }

    return res.json({
      message: isStaticFro
        ? `Entry verified with ${froName}. Receipt generated. Entry remains editable until ${new Date(editableUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.`
        : 'Entry manually verified, FRO credited, and receipt generated',
      donor_id: result.donorId,
      log_id: result.logId,
      amount: result.amount,
      match_no: result.match_no,
      receipt_no: result.receipt?.receipt_no || null,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// Check if a donor (by mobile) already has active fro_assignments from other FROs.
// Returns the list of existing assignments so the frontend can detect conflicts
// during manual verify.
export const checkDonorAssignment = async (req, res) => {
  try {
    const { mobile } = req.query;
    if (!mobile) return res.status(400).json({ message: 'Mobile is required' });

    const cleanMobile = String(mobile).replace(/[^\d]/g, '');
    if (cleanMobile.length < 10) return res.json({ assigned: false, assignments: [] });

    // Find all donor_profiles with this mobile
    const { data: profiles } = await db
      .from('donor_profiles')
      .select('id')
      .eq('mobile_number', cleanMobile);

    if (!profiles || profiles.length === 0) return res.json({ assigned: false, assignments: [] });

    const donorIds = profiles.map(p => p.id);

    // Find active fro_assignments for these donors
    const { data: assignments } = await db
      .from('fro_assignments')
      .select('id, donor_id, fro_worker_id, ngo_id, station, status, assigned_at')
      .in('donor_id', donorIds)
      .not('status', 'eq', 'reassigned')
      .order('assigned_at', { ascending: false });

    if (!assignments || assignments.length === 0) return res.json({ assigned: false, assignments: [] });

    // Resolve worker names and NGO names
    const workerIds = [...new Set(assignments.map(a => a.fro_worker_id).filter(Boolean))];
    const ngoIds = [...new Set(assignments.map(a => a.ngo_id).filter(Boolean))];

    const [workersRes, ngosRes] = await Promise.all([
      workerIds.length > 0 ? db.from('workers').select('id, name').in('id', workerIds) : { data: [] },
      ngoIds.length > 0 ? db.from('ngos').select('id, name').in('id', ngoIds) : { data: [] },
    ]);

    const workerMap = Object.fromEntries((workersRes.data || []).map(w => [w.id, w.name]));
    const ngoMap = Object.fromEntries((ngosRes.data || []).map(n => [n.id, n.name]));

    const enriched = assignments.map(a => ({
      assignment_id: a.id,
      donor_id: a.donor_id,
      fro_worker_id: a.fro_worker_id,
      fro_name: workerMap[a.fro_worker_id] || 'Unknown',
      ngo_id: a.ngo_id,
      ngo_name: ngoMap[a.ngo_id] || null,
      station: a.station || null,
      status: a.status,
    }));

    return res.json({ assigned: true, assignments: enriched });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listNgoSuspense = async (req, res) => {
  try {
    const entries = await BankAudit.getSuspenseForNgo();
    return res.json(entries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const linkSuspenseToDonor = async (req, res) => {
  try {
    const { id } = req.params;
    const { donor_id } = req.body;
    if (!donor_id) return res.status(400).json({ message: 'Donor ID is required' });

    const { data: entry } = await db
      .from('bank_audit_entries')
      .select('amount, payment_id')
      .eq('id', id)
      .single();
    if (!entry) return res.status(404).json({ message: 'Entry not found' });

    const result = await BankAudit.linkSuspenseToDonor(id, donor_id);

    const { data: assignment } = await db
      .from('fro_assignments')
      .select('id, fro_worker_id')
      .eq('donor_id', donor_id)
      .not('status', 'eq', 'reassigned')
      .maybeSingle();

    if (assignment?.fro_worker_id) {
      await db.from('fro_donor_logs').insert({
        assignment_id: assignment.id,
        donor_id: donor_id,
        fro_worker_id: assignment.fro_worker_id,
        action: 'donation',
        amount_collected: entry.amount,
        accounts_status: 'verified',
        verified_at: new Date().toISOString(),
        verified_by: req.user.id,
        created_by: req.user.id,
        notes: `Auto-credited via suspense linking (Payment: ${entry.payment_id || 'N/A'})`,
      });
    }

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const markSuspenseUnmatched = async (req, res) => {
  try {
    const { id } = req.params;
    const userName = req.user?.name || req.user?.login_id || 'Unknown';
    const entry = await BankAudit.markSuspenseUnmatched(id, userName);
    return res.json(entry);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const searchDonorsForSuspense = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const ngoIds = []; // will be scoped by user's NGO access if needed
    const donors = await BankAudit.searchDonorsForSuspense(q, ngoIds);
    return res.json(donors);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const listFroSuspense = async (req, res) => {
  try {
    const entries = await BankAudit.getSuspenseForFro(req.user.id);
    const filtered = entries.filter(e => {
      if (!e.receipts) return true;
      const r = e.receipts;
      if (r.donor_id) return false;
      if (!BankAudit.isBlankSuspenseValue(r.agent_name) || !BankAudit.isBlankSuspenseValue(r.donor_mobile)) return false;
      return true;
    });
    return res.json(filtered);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const resolveSuspenseEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const { screenshot_url, donor_details, donor_name, donor_mobile, amount, disposition_category, disposition_detail } = req.body;
    const entry = await BankAudit.resolveSuspense(id, screenshot_url, donor_details);

    // Also create a fro_donor_log entry for this resolved suspense
    if (donor_name) {
      try {
        // Create or find donor profile
        const { data: existingDonor } = await db
          .from('donor_profiles')
          .select('id')
          .eq('name', donor_name)
          .maybeSingle();
        let donorId = existingDonor?.id;
        if (!donorId) {
          const { data: newDonor } = await db
            .from('donor_profiles')
            .insert({ name: donor_name, mobile_number: donor_mobile || `NOCELL-${Date.now()}` })
            .select()
            .single();
          donorId = newDonor?.id;
        }

        if (donorId) {
          // Create fro_assignment
          const { data: assignment } = await db
            .from('fro_assignments')
            .insert({
              donor_id: donorId,
              fro_worker_id: req.user.id,
              status: disposition_detail === 'lead_done' ? 'lead_done' : 'callback',
            })
            .select()
            .single();

          if (assignment) {
            await db.from('fro_donor_logs').insert({
              assignment_id: assignment.id,
              fro_worker_id: assignment.fro_worker_id,
              action: disposition_detail === 'lead_done' ? 'donation' : disposition_category || 'follow_up',
              disposition_category: disposition_category || 'other',
              disposition_detail: disposition_detail || 'resolved_suspense',
              amount_collected: amount || entry.amount || 0,
              accounts_status: disposition_detail === 'lead_done' ? 'pending' : 'pending',
            });
          }
        }
      } catch (err) { console.error('Failed to create lead from suspense:', err.message); }
    }

    return res.json(entry);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const searchFroDispositions = async (req, res) => {
  try {
    const { q } = req.query;
    const entries = await BankAudit.searchFroDispositions(req.user.id, q || '');
    return res.json(entries);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const runAutoMatch = async (req, res) => {
  try {
    const result = await findAutoMatches();
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const confirmMatch = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await confirmMatchCredit(id, req.user.id);
    if (result.error) return res.status(result.error).json({ message: result.message });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const clearMatch = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await db
      .from('bank_audit_entries')
      .update({
        match_status: 'cleared',
        matched_lead_log_id: null,
        match_score: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*, bank_audit_sources(name)')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: 'Entry not found' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Search pending lead logs (accounts_status='pending', lead_done dispositions)
// with donor + FRO details for the "Log" picker in the New/Edit Entry modal.
// Claimed leads (linked to a suspense receipt) are included — the save path
// reuses the existing receipt instead of double-claiming.
export const searchPendingLeads = async (req, res) => {
  try {
    const { q } = req.query;
    const term = (q || '').trim().toLowerCase();

    let query = db
      .from('fro_donor_logs')
      .select(`
        id, amount_collected, accounts_status, fro_worker_id, created_at,
        fro_assignments!inner(
          donor_id,
          donor_profiles!inner(id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported),
          workers!inner(id, name, login_id)
        )
      `)
      .eq('action', 'disposition')
      .eq('disposition_detail', 'lead_done')
      .eq('accounts_status', 'pending')
      .order('created_at', { ascending: false })
      .limit(30);

    if (term && term.length >= 2) {
      const escaped = term.replace(/%/g, '\\%').replace(/_/g, '\\_');
      query = query.or(
        `fro_assignments.donor_profiles.name.ilike.%${escaped}%,` +
        `fro_assignments.donor_profiles.mobile_number.ilike.%${escaped}%,` +
        `fro_assignments.workers.name.ilike.%${escaped}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const result = (data || []).map(r => {
      const donor = r.fro_assignments?.donor_profiles || {};
      const worker = r.fro_assignments?.workers || {};
      return {
        log_id: r.id,
        amount: r.amount_collected,
        donor_id: r.fro_assignments?.donor_id || null,
        donor_name: donor.name || '',
        donor_mobile: donor.mobile_number || '',
        donor_email: donor.email || '',
        donor_pan: donor.pan_number || '',
        donor_address_1: donor.address_1 || '',
        donor_address_2: donor.address_2 || '',
        donor_city: donor.city || '',
        donor_pin_code: donor.pin_code || '',
        donor_project: donor.project_supported || '',
        agent_name: worker.name || '',
        created_at: r.created_at || null,
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// One-time batch sync: for every bank_audit_entries row whose linked receipt has
// stale / blank fields, copy the entry's agent_name, payer_name, donor_mobile
// etc. onto the receipt so the kind check classifies the entry correctly.
export const syncReceiptFields = async (req, res) => {
  try {
    const { data: entries, error: eErr } = await db
      .from('bank_audit_entries')
      .select('id, receipt_id, payer_name, agent_name, donor_mobile, donor_pan, donor_address_1, donor_email')
      .not('receipt_id', 'is', null);
    if (eErr) throw eErr;

    let synced = 0;
    for (const e of entries || []) {
      const { data: r } = await db.from('receipts').select('id, agent_name, donor_name, donor_mobile, pan_number, address, email').eq('id', e.receipt_id).maybeSingle();
      if (!r) continue;

      const patch = {};
      if (BankAudit.isBlankSuspenseValue(r.agent_name) && e.agent_name && !BankAudit.isBlankSuspenseValue(e.agent_name)) patch.agent_name = e.agent_name;
      if (BankAudit.isBlankSuspenseValue(r.donor_name) && e.payer_name) patch.donor_name = e.payer_name;
      if (BankAudit.isBlankSuspenseValue(r.donor_mobile) && e.donor_mobile) patch.donor_mobile = e.donor_mobile;
      if (BankAudit.isBlankSuspenseValue(r.pan_number) && e.donor_pan) patch.pan_number = e.donor_pan;
      if (BankAudit.isBlankSuspenseValue(r.address) && e.donor_address_1) patch.address = e.donor_address_1;
      if (BankAudit.isBlankSuspenseValue(r.email) && e.donor_email) patch.email = e.donor_email;

      if (Object.keys(patch).length > 0) {
        await db.from('receipts').update(patch).eq('id', r.id);
        synced++;
      }
    }
    return res.json({ message: `Synced ${synced} receipt(s)`, total: entries?.length || 0, synced });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
