import db from '../config/db.js';
import { createReceipt, findReceiptByLogId } from '../models/receiptModel.js';
import { sendPushNotification } from '../services/fcmService.js';
import { confirmMatchCredit } from '../services/creditService.js';
import { getEntryByPaymentId, getNextReceiptNo, isBlankSuspenseValue, projectCodeFromNgoId, cancelReceiptNo, voidReceipt, deleteReceiptSafely, bulkDeleteReceipts, getReceiptNumbers as modelGetReceiptNumbers } from '../models/bankAuditModel.js';
import { getSetting, upsertSetting } from '../models/settingsModel.js';
import { nameMatch } from '../services/autoMatchService.js';
import { formatModeLabel } from '../services/modeLabels.js';
import { normalizeAgentName, resolveAgentToWorker } from '../utils/workerNameMatch.js';
import { receiptsForDonor } from '../services/receiptLookup.js';
import { resolveOperatorNames, resolveOperatorName } from '../services/operatorNameService.js';
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Receipt-to-assignment bridge ──────────────────────────────────────────
// Receipt/donor-link paths set receipt.donor_id (and agent_name) without always
// creating a fro_assignments row, and every FRO view is assignment-scoped, so
// such donors stay invisible to FROs. These helpers ensure an assignment exists
// (status 'donation_collected') whenever a receipt resolves to an FRO worker.
const PLACEHOLDER_AGENT_SET = new Set(['suspense', 'pg', 'library', 'na']);

const ngoIdFromProjectCode = async (client, projectId) => {
  const code = String(projectId || '').trim().toLowerCase();
  if (!code) return null;
  const { data } = await client.from('ngos').select('id').ilike('name', code).maybeSingle();
  return data?.id || null;
};

const resolveWorkerStation = async (client, workerId, ngoId, fallback) => {
  if (workerId && ngoId) {
    const { data } = await client.from('fro_station_assignments')
      .select('fro_worker_id, station')
      .eq('fro_worker_id', workerId)
      .eq('ngo_id', ngoId)
      .maybeSingle();
    if (data?.station) return data.station;
  }
  return fallback || null;
};

// fro_assignments.assigned_by is a FK to users(id), but the persona behind a
// CRM login can be a workers-table row (e.g. FRO with department accounts/admin)
// whose UUID lives in workers, not users. Writing that UUID into assigned_by
// trips fro_assignments_assigned_by_fkey. Resolve the actor to a genuine users.id
// (NULL when the token subject is not a users row, e.g. worker logins / env admin).
const resolveAssignedBy = async (user) => {
  if (!user) return null;
  const { id, email } = user;
  if (!id || id === 0 || id === -1) return null;
  if (!email) return null;
  try {
    const { data, error } = await db.from('users').select('id').eq('id', id).maybeSingle();
    if (error) {
      console.error('resolveAssignedBy: users lookup failed (falling back to null):', error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.error('resolveAssignedBy: unexpected error (falling back to null):', e.message);
    return null;
  }
};

const ensureAssignmentForDonorReceipt = async ({ client = db, receipt, workerId }) => {
  if (!receipt?.donor_id) return { created: false, assignment: null, reason: 'no_donor' };
  if (!workerId) return { created: false, assignment: null, reason: 'no_worker' };
  const agent = String(receipt.agent_name || '').trim();
  if (!agent || PLACEHOLDER_AGENT_SET.has(agent.toLowerCase())) {
    return { created: false, assignment: null, reason: 'placeholder_agent' };
  }
  const ngoId = await ngoIdFromProjectCode(client, receipt.project_id);
  if (!ngoId) return { created: false, assignment: null, reason: 'no_ngo' };

  const { data: existing } = await client.from('fro_assignments')
    .select('id, donor_id, fro_worker_id, ngo_id, status')
    .eq('donor_id', receipt.donor_id)
    .eq('ngo_id', ngoId)
    .limit(20);
  const active = (existing || []).find(a => a.status === null || a.status !== 'reassigned');
  if (active) return { created: false, assignment: active, reason: 'already_assigned' };

  const station = await resolveWorkerStation(client, workerId, ngoId, receipt.station || null);
  const now = new Date().toISOString();
  const { data: assignment, error } = await client.from('fro_assignments').insert({
    donor_id: receipt.donor_id,
    fro_worker_id: workerId,
    ngo_id: ngoId,
    station,
    status: 'donation_collected',
    assigned_at: now,
  }).select().single();
  if (error) throw error;

  try {
    const { data: ngoRow } = await client.from('ngos').select('name').eq('id', ngoId).maybeSingle();
    await client.from('donor_profiles')
      .update({ ngo: ngoRow?.name ?? null, station: station ?? null })
      .eq('id', receipt.donor_id);
  } catch (syncErr) {
    console.error('ensureAssignmentForDonorReceipt: donor-profile sync failed (non-fatal):', syncErr.message);
  }

  return { created: true, assignment, reason: 'created' };
};

export const getLeadList = async (req, res) => {
  try {
    const { status } = req.query;

    let query = db
      .from('fro_donor_logs')
      .select(`
        id, action, disposition_category, disposition_detail, amount_collected,
        payment_screenshot_url, accounts_status, pan_number, notes, remark, created_at, verified_at,
        upi_transaction_id, transaction_datetime, payment_from, payment_mode,
        assignment_id, fro_worker_id, operator_id,
        workers!fro_donor_logs_fro_worker_id_fkey(id, name, login_id),
        fro_assignments!inner(
          id,
          donor_id,
          fro_worker_id,
          ngo_id,
          status,
          ngos!left(id, name),
          donor_profiles!inner(id, name, mobile_number, city, pan_number, address_1, email, project_supported, donation_count, total_amount, birth_date, donors_bank_name),
          workers!inner(id, name, login_id)
        )
      `)
      .eq('action', 'disposition')
      .eq('disposition_detail', 'lead_done')
      .not('fro_worker_id', 'is', null)
      .order('created_at', { ascending: false });

    if (status) {
      query = query.eq('accounts_status', status);
    }

    const { data, error } = await query;

    if (error) throw error;

    // The claim ACTOR (Work As operator) lives in operator_id, which spans the
    // workers / users / crm_agents id spaces, so resolve those ids to names in
    // one batch and prefer them over the covered FRO below.
    const operatorNames = await resolveOperatorNames((data || []).map(r => r.operator_id));

    const logIds = (data || []).map(r => r.id);
    const receiptMap = {};
    let entrySourceMap = {};
    let entryPayerMap = {};
    const leadMatchMap = {};
    if (logIds.length) {
      const { data: claimedReceipts, error: receiptErr } = await db
        .from('receipts')
        .select('id, receipt_no, donor_id, donor_mobile, donor_name, bank_payer_name, payment_id, mode, pan_number, log_id')
        .in('log_id', logIds);
      if (!receiptErr) {
        for (const rc of (claimedReceipts || [])) {
          if (rc.log_id != null && !receiptMap[rc.log_id]) receiptMap[rc.log_id] = rc;
        }
        const receiptIds = (claimedReceipts || []).map(rc => rc.id).filter(Boolean);
        if (receiptIds.length) {
          const { data: linkedEntries } = await db
            .from('bank_audit_entries')
            .select('receipt_id, source_id, payer_name, bank_audit_sources(name)')
            .in('receipt_id', receiptIds);
          entrySourceMap = {};
          entryPayerMap = {};
          for (const en of (linkedEntries || [])) {
            if (en.receipt_id != null) entrySourceMap[en.receipt_id] = en.bank_audit_sources?.name || null;
            if (en.receipt_id != null && en.payer_name) entryPayerMap[en.receipt_id] = en.payer_name;
          }
        }
      }

      const { data: matchedEntries, error: matchErr } = await db
        .from('bank_audit_entries')
        .select('id, matched_lead_log_id, match_status, match_source, match_no, match_score, payment_id, check_id, payer_name, transaction_date, payment_time, receipt_id, donor_pan, donor_address_1, donor_address_2, mode, source_id, bank_audit_sources(name)')
        .in('matched_lead_log_id', logIds)
        .in('match_status', ['matched', 'confirmed']);
      if (!matchErr) {
        for (const me of (matchedEntries || [])) {
          if (me.matched_lead_log_id != null && !leadMatchMap[me.matched_lead_log_id]) {
            leadMatchMap[me.matched_lead_log_id] = me;
          }
        }
      }
    }

    const result = (data || []).map(r => {
      const profile = r.fro_assignments?.donor_profiles || {};
      const match = leadMatchMap[r.id] || null;
      const profileAddr = [profile.address_1, profile.address_2].filter(Boolean).join(', ');
      const matchAddr = match ? [match.donor_address_1, match.donor_address_2].filter(Boolean).join(', ') : '';
      // The linked bank audit entry is the source of truth for the money
      // details shown on the pending lead: its payment id, txn time, payer, and
      // mode override what was stored at claim time (works for already-claimed
      // leads too, not just new claims).
      const matchTxn = match?.transaction_date
        ? (() => {
            const d = String(match.transaction_date);
            const datePart = d.includes('T') ? d.slice(0, 10) : d;
            // Bank payment times are IST wall-clock; send with the explicit
            // offset so it displays as the bank's time regardless of browser tz.
            return match.payment_time ? `${datePart}T${match.payment_time}+05:30` : `${datePart}T00:00:00+05:30`;
          })()
        : null;
      const matchMode = match?.mode || ((match?.payment_id || match?.check_id) ? (match.payment_id ? 'UPI' : 'Cheque') : null);
      return {
      log_id: r.id,
      amount: r.amount_collected,
      screenshot_url: r.payment_screenshot_url,
      accounts_status: r.accounts_status,
      pan_number: r.pan_number || receiptMap[r.id]?.pan_number || '',
      notes: r.notes,
      remark: r.remark,
      rejection_reason: r.rejection_reason,
      created_at: r.created_at,
      assignment_id: r.assignment_id,
      assignment_status: r.fro_assignments?.status || 'lead_done',
      donor_id: r.fro_assignments?.donor_id,
      donor_name: r.fro_assignments?.donor_profiles?.name || 'Unknown',
      original_payer: receiptMap[r.id]?.bank_payer_name || receiptMap[r.id]?.donor_name || entryPayerMap[receiptMap[r.id]?.id] || '',
      audit_name: receiptMap[r.id]?.bank_payer_name || receiptMap[r.id]?.donor_name || entryPayerMap[receiptMap[r.id]?.id] || r.fro_assignments?.donor_profiles?.bank_donor_name || '',
      donor_mobile: r.fro_assignments?.donor_profiles?.mobile_number || receiptMap[r.id]?.donor_mobile || '',
      donor_city: r.fro_assignments?.donor_profiles?.city || '',
      donor_pan: profile.pan_number || match?.donor_pan || r.pan_number || '',
      donor_address: profileAddr || matchAddr || '',
      donor_address_2: profile.address_2 || match?.donor_address_2 || '',
      donor_email: r.fro_assignments?.donor_profiles?.email || '',
      donor_bank_name: r.fro_assignments?.donor_profiles?.donors_bank_name || '',
      donor_project: (r.fro_assignments?.ngos?.name === 'BSCT' ? 'bsct' : r.fro_assignments?.ngos?.name === 'AFLF' ? 'aflf' : r.fro_assignments?.ngos?.name === 'MANN' ? 'mann' : r.fro_assignments?.donor_profiles?.project_supported) || '',
      donor_dob: r.fro_assignments?.donor_profiles?.birth_date || '',
      donation_count: r.fro_assignments?.donor_profiles?.donation_count || 0,
      total_donated: r.fro_assignments?.donor_profiles?.total_amount || 0,
      upi_transaction_id: (match && match.payment_id) ? match.payment_id : (r.upi_transaction_id || receiptMap[r.id]?.payment_id || null),
      transaction_datetime: matchTxn || r.transaction_datetime || null,
      payment_from: (match && match.payer_name) ? match.payer_name : (r.payment_from || receiptMap[r.id]?.bank_payer_name || receiptMap[r.id]?.donor_name || null),
      audit_source: match?.bank_audit_sources?.name || entrySourceMap[receiptMap[r.id]?.id] || null,
      audit_entry_id: match?.id ?? null,
      audit_mop: match?.mode || null,
      payment_mode: matchMode || r.payment_mode || receiptMap[r.id]?.mode || null,
      verified_at: r.verified_at || null,
      agent_id: r.operator_id || r.fro_worker_id,
      // Claim attribution: operator_id is the ACTOR (who was at the keyboard
      // during a Work As / cover session), fro_worker_id is the COVERED FRO.
      // Accounts must see the person who actually claimed, so the operator
      // wins whenever one was recorded; rows claimed without a cover fall back
      // to the credited worker, then the assignment owner.
      agent_name: operatorNames.get(String(r.operator_id))?.name || r.workers?.name || r.fro_assignments?.workers?.name || 'Priyank Shah',
      agent_login: operatorNames.get(String(r.operator_id))?.login || r.workers?.login_id || r.fro_assignments?.workers?.login_id || '',
      claimant_name: operatorNames.get(String(r.operator_id))?.name || r.workers?.name || r.fro_assignments?.workers?.name || 'Priyank Shah',
      claimant_login: operatorNames.get(String(r.operator_id))?.login || r.workers?.login_id || r.fro_assignments?.workers?.login_id || '',
      claimed_receipt: receiptMap[r.id] || null,
      received_source: entrySourceMap[receiptMap[r.id]?.id] || null,
      bank_match: match
        ? {
            entry_id: match.id,
            match_status: match.match_status,
            match_source: match.match_source || 'auto',
            match_no: match.match_no || null,
            match_score: match.match_score || null,
          }
        : null,
    };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const verifyLead = async (req, res) => {
  try {
    const { logId } = req.params;
    const {
      pan_number, notes,
      donor_name, donor_receipt_name, donor_mobile, donor_city, donor_email, donor_pan, donor_address, donor_dob,
      upi_transaction_id, transaction_datetime, payment_from, payment_mode,
    } = req.body;

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, ngo_id, ngos(name), workers!left(name), donor_profiles!inner(id, name, mobile_number, city, address_1, address_2, email, pan_number, project_supported, donors_bank_name))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    if (log.accounts_status !== 'pending') {
      return res.status(400).json({ message: `This lead has already been ${log.accounts_status || 'processed'}` });
    }

    const assignmentId = log.fro_assignments?.id;
    const donorProfile = log.fro_assignments?.donor_profiles;
    if (!assignmentId || !donorProfile) {
      return res.status(400).json({ message: 'Associated assignment/donor not found' });
    }

// Credit rule for the receipt's agent_name (drives FRO collection totals):
// while impersonating (Acting FRO), credit goes to the real operator
// (imposter_name) — same as Audit Manual Verify; then to the lead's ACTOR
// (fro_donor_logs.operator_id, recorded when the claim was made during a Work As
// / cover session); otherwise to the FRO who owns the lead's assignment. Without
// this the receipt is created with a NULL agent_name and never shows in anyone's
// collection — and a claim made from a covered account would credit the covered
// FRO while every other claim display names the actor.
//
// Receipts name the FRO, never the CRM login agent working that FRO's data:
// agent_name is what collection reports group by, so a label here would split
// one FRO's totals across several rows.
let agentStamp = req.user?.impersonation && req.user.imposter_name
  ? req.user.imposter_name
  : null;
if (!agentStamp) {
  const claimOperator = await resolveOperatorName(log.operator_id);
  // The agent LABEL, not the human's name: receipts.agent_name is stamped from
  // the JWT's imposter_name (the label) at claim time too, and collection
  // reports group by agent_name — mixing the two would split one person's
  // totals across two rows.
  agentStamp = claimOperator?.label || claimOperator?.name || log.fro_assignments?.workers?.name || null;
}

    // The NGO a lead is assigned under is the per-lead truth for which project
    // (and therefore which receipt-number sequence) its money belongs to. The
    // donor profile's project_supported is only a fallback — it is frequently
    // unset, which would wrongly fall through to the 'bsct' default and give an
    // Ashray receipt the next number from the BSCT sequence.
    let project = donorProfile?.project_supported || 'bsct';
    try {
      project = await projectCodeFromNgoId(log.fro_assignments?.ngo_id) || project;
    } catch (err) { console.error('Failed to resolve project from assignment NGO:', err.message); }

    // ── Manual bank-audit link path ─────────────────────────────────────────
    // Accounts can pick an unmatched bank audit entry next to the UPI id. That
    // entry is linked + credited through the same pipeline as a confirmed
    // auto-match. If no entry is picked, fall back to an already manually
    // linked entry (from the lead-detail "Save" action) so Verify reuses it.
    const { bank_audit_entry_id } = req.body;
    let linkedEntryId = bank_audit_entry_id || null;
    if (!linkedEntryId) {
      try {
        const { data: autoLinked } = await db
          .from('bank_audit_entries')
          .select('id')
          .eq('matched_lead_log_id', logId)
          .eq('match_status', 'matched')
          .eq('match_source', 'manual')
          .maybeSingle();
        if (autoLinked?.id) linkedEntryId = autoLinked.id;
      } catch (err) { console.error('Failed to find manually linked entry:', err.message); }
    }

    if (linkedEntryId) {
      const { data: linkedEntry, error: leErr } = await db
        .from('bank_audit_entries')
        .select('id, status, match_status, matched_lead_log_id')
        .eq('id', linkedEntryId)
        .maybeSingle();
      if (leErr) throw leErr;
      if (!linkedEntry) return res.status(400).json({ message: 'Selected bank audit entry not found' });
      if (linkedEntry.status === 'verified') return res.status(400).json({ message: 'Selected bank audit entry is already verified' });
      if (linkedEntry.match_status && linkedEntry.matched_lead_log_id != null && String(linkedEntry.matched_lead_log_id) !== String(logId)) {
        return res.status(409).json({ message: 'Selected bank audit entry is already matched to another lead' });
      }

      const donorId = log.fro_assignments?.donor_id;
      if (donorId) {
        const donorUpdate = { updated_at: new Date().toISOString() };
        if (donor_name !== undefined) donorUpdate.name = donor_name || null;
        if (donor_mobile !== undefined) donorUpdate.mobile_number = donor_mobile || null;
        if (donor_city !== undefined) donorUpdate.city = donor_city || null;
        if (donor_email !== undefined) donorUpdate.email = donor_email || null;
        if (donor_pan !== undefined || pan_number) donorUpdate.pan_number = pan_number || donor_pan || null;
        if (donor_address !== undefined) donorUpdate.address_1 = donor_address || null;
        if (donor_dob !== undefined) donorUpdate.birth_date = donor_dob || null;
        try { await db.from('donor_profiles').update(donorUpdate).eq('id', donorId); }
        catch (err) { console.error('Failed to update donor profile:', err); }
      }

      // Log edits (kept pending; the credit step sets it verified).
      const logPatch = {};
      if (pan_number !== undefined) logPatch.pan_number = pan_number || null;
      if (notes !== undefined) logPatch.notes = notes || null;
      if (upi_transaction_id !== undefined) logPatch.upi_transaction_id = upi_transaction_id || null;
      if (transaction_datetime !== undefined) logPatch.transaction_datetime = transaction_datetime || null;
      if (payment_from !== undefined) logPatch.payment_from = payment_from || null;
      if (payment_mode !== undefined) logPatch.payment_mode = payment_mode || null;
      if (Object.keys(logPatch).length > 0) {
        await db.from('fro_donor_logs').update(logPatch).eq('id', logId);
      }

      if (!linkedEntry.match_status) {
        await db.from('bank_audit_entries').update({
          matched_lead_log_id: logId,
          match_status: 'matched',
          match_source: 'manual',
          matched_by: req.user.id,
          matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', linkedEntry.id);
      }

      const credit = await confirmMatchCredit(linkedEntry.id, req.user.id);
      if (credit?.error) return res.status(credit.error).json({ message: credit.message });
      return res.status(200).json({ ...credit, message: 'Lead verified and bank audit entry credited' });
    }

    const donorId = log.fro_assignments?.donor_id;

    // Apply the Accounts-entered lead edits immediately (these never change the
    // lead's accounts_status, so a later failure keeps the lead pending and
    // visible in Lead Verification).
    const logPatch = { pan_number: pan_number || log.pan_number || null, notes: notes || log.notes || null };
    if (upi_transaction_id !== undefined) logPatch.upi_transaction_id = upi_transaction_id || null;
    if (transaction_datetime !== undefined) logPatch.transaction_datetime = transaction_datetime || null;
    if (payment_from !== undefined) logPatch.payment_from = payment_from || null;
    if (payment_mode !== undefined) logPatch.payment_mode = payment_mode || null;
    const { error: patchLogError } = await db
      .from('fro_donor_logs')
      .update(logPatch)
      .eq('id', logId);
    if (patchLogError) throw patchLogError;

    // Create or link the receipt BEFORE the lead is marked verified: if any of
    // this fails the lead stays pending (still in Lead Verification, retryable)
    // instead of vanishing. The verified flag is written only at the very end.
    const existing = await findReceiptByLogId(logId);
    let receipt = existing || null;
    if (!existing) {
      const donorName = donor_receipt_name || donorProfile?.name || 'Unknown';
      const receiptData = {
        log_id: parseInt(logId),
        project_id: project,
        donor_name: donorName,
        donor_mobile: donorProfile?.mobile_number || null,
        amount: log.amount_collected || 0,
        pan_number: pan_number || log.pan_number || donorProfile?.pan_number || null,
        address: [donor_address || donorProfile?.address_1, donorProfile?.address_2].filter(Boolean).join(', ') || null,
        email: donorProfile?.email || null,
        bank_name: donorProfile?.donors_bank_name || null,
        mode: payment_mode || null,
        agent_name: agentStamp,
        purpose: 'General Donation',
        generated_by: req.user.id,
        donor_id: donorId,
        receipt_date: transaction_datetime || log.transaction_datetime || new Date().toISOString(),
      };
      // A receipt-number collision (UNIQUE project_id + receipt_no) can happen
      // when the counter fell behind the numbers already on file; the counter
      // advances on every allocation, so retry with a fresh number instead of
      // failing the verify.
      let receiptNo = await getNextReceiptNo(project);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          receipt = await createReceipt({ ...receiptData, receipt_no: receiptNo });
          break;
        } catch (createErr) {
          const msg = String(createErr?.message || createErr || '');
          const isDup = createErr?.code === '23505' || /duplicate key/i.test(msg);
          if (!isDup || attempt === 2) throw createErr;
          receiptNo = await getNextReceiptNo(project);
          console.error(`Receipt number collision on verify (attempt ${attempt + 1}), retrying:`, msg);
        }
      }
    } else {
      // Receipt already exists (e.g. created for a bank audit entry or a suspense
      // claim). Link it to the verified donor and mark its bank audit entry done.
      const profileName = donorProfile?.name;
      const oldPayerName = existing.donor_name && existing.donor_name !== profileName ? existing.donor_name : null;
      const receiptPatch = {
        donor_id: donorId,
        donor_name: donor_receipt_name || profileName || existing.donor_name || 'Unknown',
        donor_mobile: donorProfile?.mobile_number || existing.donor_mobile || null,
        bank_payer_name: existing.bank_payer_name || oldPayerName || null,
        bank_name: donorProfile?.donors_bank_name || null,
        address: [donor_address || donorProfile?.address_1, donorProfile?.address_2].filter(Boolean).join(', ') || null,
        agent_name: (!existing.agent_name || existing.agent_name === 'Suspense') ? (agentStamp || existing.agent_name) : existing.agent_name,
      };
      if (!existing.receipt_no) {
        existing.receipt_no = await getNextReceiptNo(existing.project_id || project);
        receiptPatch.receipt_no = existing.receipt_no;
      }
      const { error: linkReceiptErr } = await db.from('receipts').update(receiptPatch).eq('id', existing.id);
      if (linkReceiptErr) throw new Error(`Failed to link existing receipt to donor: ${linkReceiptErr.message}`);
      try {
        await db.from('bank_audit_entries').update({
          donor_id: donorId,
          status: 'verified',
          matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          receipt_no: existing.receipt_no || null,
        }).eq('receipt_id', existing.id);
      } catch (err) { console.error('Failed to mark bank audit entry verified:', err.message); }
    }

    // Settle the bank audit entry for this money (linked to the receipt, or
    // matching the lead's UPI transaction id) so it leaves the audit fully
    // credited (status verified, linked to the lead + receipt) instead of a
    // bare "verified" row.
    try {
      let bankEntry = null;
      try {
        const { data } = await db.from('bank_audit_entries').select('*').eq('receipt_id', receipt.id).maybeSingle();
        bankEntry = data || null;
      } catch (err) { console.error('Failed to find entry by receipt:', err.message); }
      if (!bankEntry && upi_transaction_id) {
        try { bankEntry = await getEntryByPaymentId(upi_transaction_id); }
        catch (err) { console.error('Failed to find entry by payment id:', err.message); }
      }
      if (bankEntry && bankEntry.status !== 'verified') {
        const settlePatch = {
          status: 'verified',
          donor_id: donorId,
          matched_lead_log_id: logId,
          match_status: 'confirmed',
          matched_by: req.user.id,
          matched_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          receipt_id: receipt.id,
          receipt_no: receipt.receipt_no || null,
        };
        if (!bankEntry.match_no) {
          try {
            const { rows } = await db._pool.query("SELECT nextval('bank_audit_match_no_seq') AS n");
            settlePatch.match_no = 'MTCH-' + String(rows[0].n).padStart(6, '0');
          } catch (err) { console.error('Match no allocation failed:', err.message); }
        }
        await db.from('bank_audit_entries').update(settlePatch).eq('id', bankEntry.id);
      }
    } catch (err) { console.error('Failed to settle bank audit entry on verify:', err.message); }

    // Everything the receipt depends on has succeeded — only now mark the lead
    // verified (this is what removes it from Lead Verification) and credit the
    // donor + assignment.
    const now = new Date().toISOString();
    const { error: updateLogError } = await db
      .from('fro_donor_logs')
      .update({
        accounts_status: 'verified',
        verified_at: now,
        verified_by: req.user.id,
      })
      .eq('id', logId);

    if (updateLogError) throw updateLogError;

    const { error: updateAsgnError } = await db
      .from('fro_assignments')
      .update({
        status: 'donation_collected',
        last_contacted_at: now,
      })
      .eq('id', assignmentId);

    if (updateAsgnError) throw updateAsgnError;

    if (donorId) {
      const donorUpdate = { updated_at: now };
      if (donor_name !== undefined) donorUpdate.name = donor_name || null;
      if (donor_mobile !== undefined) donorUpdate.mobile_number = donor_mobile || null;
      if (donor_city !== undefined) donorUpdate.city = donor_city || null;
      if (donor_email !== undefined) donorUpdate.email = donor_email || null;
      if (donor_pan !== undefined || pan_number) donorUpdate.pan_number = pan_number || donor_pan || null;
      if (donor_address !== undefined) donorUpdate.address_1 = donor_address || null;
      if (donor_dob !== undefined) donorUpdate.birth_date = donor_dob || null;
      try {
        const { data: donor } = await db
          .from('donor_profiles')
          .select('total_amount, donation_count')
          .eq('id', donorId)
          .single();
        donorUpdate.total_amount = (donor?.total_amount || 0) + (log.amount_collected || 0);
        donorUpdate.donation_count = (donor?.donation_count || 0) + 1;
        await db.from('donor_profiles').update(donorUpdate).eq('id', donorId);
      } catch (err) { console.error('Failed to update donor totals:', err); }
    }

    // Notify FRO that their lead was verified (FCM + notification_log)
    const froWorkerId = log.fro_worker_id;
    const donorName = log.fro_assignments?.donor_profiles?.name || 'Unknown';
    if (froWorkerId) {
      try {
        const notifTitle = 'Lead Verified';
        const notifBody = `Your lead for ${donorName} (₹${log.amount_collected || 0}) has been verified. Receipt: ${receipt?.receipt_no || ''}`;
        const refId = /^\d+$/.test(String(logId)) ? parseInt(logId) : null;
        let fcmLogged = false;
        try {
          const pushResult = await sendPushNotification(froWorkerId, notifTitle, notifBody, 'lead_verified', refId);
          fcmLogged = !!pushResult;
        } catch (err) { console.error('FCM send error:', err.message); }
        if (!fcmLogged) {
          await db.from('notification_log').insert({
            worker_id: froWorkerId,
            type: 'lead_verified',
            title: notifTitle,
            body: notifBody,
            fro_donor_log_id: String(logId),
            sent_at: new Date().toISOString(),
          });
        }
      } catch (err) { console.error('Failed to create verified notification:', err.message); }
    }

    return res.json({ message: 'Lead verified, receipt generated', receipt });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Done Lead ─────────────────────────────────────────────
// Simplified verify for leads where the receipt already exists (e.g. receipt_sent
// flow: Accounts created the receipt, FRO claimed, now Accounts just closes out).

export const doneLead = async (req, res) => {
  try {
    const { logId } = req.params;

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, ngo_id, ngos(name), workers!left(name), donor_profiles!inner(id, name, mobile_number, city, address_1, address_2, email, pan_number, project_supported, donors_bank_name))')
      .eq('id', logId)
      .limit(1);
    if (logError || !logs || logs.length === 0) return res.status(404).json({ message: 'Log entry not found' });
    const log = logs[0];
    if (log.accounts_status !== 'pending') {
      return res.status(400).json({ message: `This lead has already been ${log.accounts_status || 'processed'}` });
    }

    const assignment = log.fro_assignments;
    const donorProfile = assignment?.donor_profiles;
    const donorId = assignment?.donor_id;
    if (!assignment?.id || !donorProfile) return res.status(400).json({ message: 'Associated assignment/donor not found' });

    const existing = await findReceiptByLogId(logId);
    if (!existing?.receipt_no) {
      return res.status(400).json({ message: 'No receipt found for this lead — use Verify instead' });
    }

    const amount = Number(log.amount_collected || 0);
    const now = new Date().toISOString();

    const result = await db.transaction(async ({ from }) => {
      // Mark the lead verified.
      await from('fro_donor_logs').update({
        accounts_status: 'verified',
        verified_at: now,
        verified_by: req.user.id,
      }).eq('id', logId);

      // Update assignment.
      await from('fro_assignments').update({
        status: 'donation_collected',
        last_contacted_at: now,
      }).eq('id', assignment.id);

      // Credit donor totals.
      const { data: donorRow } = await from('donor_profiles')
        .select('total_amount, donation_count, last_donation_date')
        .eq('id', donorId)
        .single();
      const date = now.slice(0, 10);
      await from('donor_profiles').update({
        total_amount: Math.round(((donorRow?.total_amount || 0) + amount) * 100) / 100,
        donation_count: (donorRow?.donation_count || 0) + 1,
        last_donation_date: !donorRow?.last_donation_date || date > donorRow.last_donation_date ? date : donorRow.last_donation_date,
        updated_at: now,
      }).eq('id', donorId);

      // Mark any linked bank_audit_entries as verified.
      try {
        await from('bank_audit_entries').update({
          status: 'verified',
          matched_at: now,
          updated_at: now,
        }).eq('receipt_id', existing.id);
      } catch (err) { console.error('Failed to mark bank audit entry verified:', err.message); }

      return { receipt_no: existing.receipt_no };
    });

    // Notify the FRO.
    const froWorkerId = log.fro_worker_id;
    const froName = log.fro_assignments?.workers?.name || 'An FRO';
    if (froWorkerId) {
      try {
        const notifTitle = 'Lead Completed';
        const notifBody = `Lead for ${donorProfile.name || 'donor'} (₹${amount.toLocaleString('en-IN')}) completed. Receipt: ${result.receipt_no}`;
        let fcmLogged = false;
        try {
          const pushResult = await sendPushNotification(froWorkerId, notifTitle, notifBody, 'lead_verified', parseInt(logId));
          fcmLogged = !!pushResult;
        } catch (err) { console.error('FCM send error:', err.message); }
        if (!fcmLogged) {
          await db.from('notification_log').insert({
            worker_id: froWorkerId,
            type: 'lead_verified',
            title: notifTitle,
            body: notifBody,
            fro_donor_log_id: String(logId),
            sent_at: now,
          });
        }
      } catch (err) { console.error('Failed to create done notification:', err.message); }
    }

    return res.json({ message: 'Lead completed', receipt_no: result.receipt_no });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Quick Verify (Priyank Shah default) ────────────────────
// When a lead has no FRO agent, accounts can quickly verify it under the
// default agent name "Priyank Shah" without filling donor details.

export const quickVerifyLead = async (req, res) => {
  try {
    const { logId } = req.params;
    const { donor_name, donor_mobile, donor_pan, donor_address, donor_city, donor_email, project } = req.body;

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, ngo_id, ngos(name), donor_profiles!inner(id, name, mobile_number, city, address_1, address_2, email, pan_number, project_supported, donors_bank_name))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) return res.status(404).json({ message: 'Lead not found' });
    const log = logs[0];
    if (log.accounts_status !== 'pending') return res.status(400).json({ message: `Lead is already ${log.accounts_status}` });

    const assignmentId = log.fro_assignments?.id;
    const donorProfile = log.fro_assignments?.donor_profiles;
    if (!assignmentId) return res.status(400).json({ message: 'No assignment found' });

    let resolvedProject = project || donorProfile?.project_supported || 'bsct';
    try { resolvedProject = await projectCodeFromNgoId(log.fro_assignments?.ngo_id) || resolvedProject; } catch {}

    const finalDonorName = donor_name || 'Priyank Shah';

    const existing = await findReceiptByLogId(logId);
    let receipt = existing || null;

    if (!existing) {
      const receiptNo = await getNextReceiptNo(resolvedProject);
      receipt = await createReceipt({
        log_id: parseInt(logId),
        receipt_no: receiptNo,
        project_id: resolvedProject,
        donor_name: finalDonorName,
        donor_mobile: donor_mobile || donorProfile?.mobile_number || null,
        amount: log.amount_collected || 0,
        pan_number: donor_pan || donorProfile?.pan_number || null,
        address: donor_address || donorProfile?.address_1 || null,
        email: donor_email || donorProfile?.email || null,
        bank_name: donorProfile?.donors_bank_name || null,
        mode: log.payment_mode || null,
        purpose: 'General Donation',
        agent_name: 'Priyank Shah',
        generated_by: req.user.id,
        donor_id: log.fro_assignments?.donor_id || null,
        receipt_date: log.transaction_datetime || new Date().toISOString(),
      });
    } else {
      await db.from('receipts').update({
        donor_name: finalDonorName,
        agent_name: 'Priyank Shah',
        donor_mobile: donor_mobile || existing.donor_mobile || null,
      }).eq('id', existing.id);
    }

    const now = new Date().toISOString();
    await db.from('fro_donor_logs').update({
      accounts_status: 'verified',
      verified_at: now,
      verified_by: req.user.id,
    }).eq('id', logId);

    await db.from('fro_assignments').update({
      status: 'donation_collected',
      last_contacted_at: now,
    }).eq('id', assignmentId);

    const donorId = log.fro_assignments?.donor_id;
    if (donorId) {
      try {
        const { data: donor } = await db.from('donor_profiles').select('total_amount, donation_count').eq('id', donorId).single();
        await db.from('donor_profiles').update({
          total_amount: (donor?.total_amount || 0) + (log.amount_collected || 0),
          donation_count: (donor?.donation_count || 0) + 1,
          updated_at: now,
        }).eq('id', donorId);
      } catch (err) { console.error('Failed to update donor totals:', err.message); }
    }

    return res.json({ message: 'Lead verified under Priyank Shah', receipt });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Suspense ─────────────────────────────────────────────

export const getSuspenseList = async (req, res) => {
  try {
    const { status } = req.query;
    let query = db
      .from('suspense_donations')
      .select('*')
      .order('created_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createSuspense = async (req, res) => {
  try {
    const { donor_name, amount, transaction_date, notes } = req.body;
    if (!donor_name || !amount) {
      return res.status(400).json({ message: 'Donor name and amount are required' });
    }

    const { data, error } = await db
      .from('suspense_donations')
      .insert({ donor_name, amount, transaction_date, notes })
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const addSuspenseNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    if (!notes) return res.status(400).json({ message: 'Notes are required' });

    const { data: existing } = await db
      .from('suspense_donations')
      .select('notes')
      .eq('id', id)
      .single();

    if (!existing) return res.status(404).json({ message: 'Suspense entry not found' });

    const updatedNotes = existing.notes
      ? existing.notes + '\n---\n' + new Date().toLocaleString() + ': ' + notes
      : new Date().toLocaleString() + ': ' + notes;

    const { data, error } = await db
      .from('suspense_donations')
      .update({ notes: updatedNotes })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const assignSuspense = async (req, res) => {
  try {
    const { id } = req.params;
    const { fro_worker_id } = req.body;
    if (!fro_worker_id) return res.status(400).json({ message: 'FRO worker ID is required' });

    const { data, error } = await db
      .from('suspense_donations')
      .update({ assigned_to_fro_id: fro_worker_id, assigned_at: new Date().toISOString(), status: 'resolved' })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const rejectLead = async (req, res) => {
  try {
    const { logId } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ message: 'Rejection reason is required' });
    }

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, ngo_id, station, donor_profiles!inner(id, name, mobile_number))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    if (log.accounts_status !== 'pending') {
      return res.status(400).json({ message: `This lead has already been ${log.accounts_status || 'processed'}` });
    }

    const assignmentId = log.fro_assignments?.id;
    if (!assignmentId) {
      return res.status(400).json({ message: 'Associated assignment not found' });
    }

    const { error: updateLogError } = await db
      .from('fro_donor_logs')
      .update({
        accounts_status: 'rejected',
        rejection_reason: reason,
        verified_by: req.user.id,
        verified_at: new Date().toISOString(),
        notes: reason,
      })
      .eq('id', logId);

    if (updateLogError) throw updateLogError;

    const { error: updateAsgnError } = await db
      .from('fro_assignments')
      .update({
        status: 'payment_rejected',
        last_contacted_at: new Date().toISOString(),
        notes: reason,
      })
      .eq('id', assignmentId);

    if (updateAsgnError) throw updateAsgnError;

    // Return any suspense receipt attached to the rejected lead back to the
    // suspense pool (unclaimed) so another FRO can claim it.
    try {
      await db.from('receipts').update({ log_id: null }).eq('log_id', parseInt(logId, 10));
    } catch (err) { console.error('Failed to clear receipt log_id on rejection:', err.message); }

    // Fully revert the linked bank audit entry so the money leaves the matched
    // state and re-enters the unclaimed suspense pool: clear the claim match
    // (matched_lead_log_id / match_status / match_no / matched_by/at) and the
    // claim-linked donor fields, and set status back to unverified. Without
    // this the entry keeps an orange "MATCHED" line and is excluded from the
    // FRO suspense pool (which filters matched_lead_log_id IS NULL), so the
    // rejected money can never be claimed again. The entry keeps its
    // receipt_id so the receipt (number intact) returns to the pool too.
    // Capture the claim-linked bank audit entries before reverting them: their
    // receipt_id / payer_name drive the receipt cleanup that returns the money
    // to the suspense pool as a bare, correctly-named suspense receipt.
    let rejectedEntries = [];
    try {
      const { data: entries } = await db
        .from('bank_audit_entries')
        .select('id, receipt_id, payer_name')
        .eq('matched_lead_log_id', logId);
      rejectedEntries = entries || [];
    } catch (err) { console.error('Failed to read bank audit entries on lead rejection:', err.message); }

    try {
      await db.from('bank_audit_entries').update({
        status: 'unverified',
        matched_lead_log_id: null,
        match_status: null,
        match_source: null,
        match_no: null,
        matched_by: null,
        matched_at: null,
        donor_id: null,
        donor_mobile: null,
        donor_email: null,
        donor_pan: null,
        donor_address_1: null,
        donor_address_2: null,
        donor_city: null,
        donor_pin_code: null,
        updated_at: new Date().toISOString(),
      }).eq('matched_lead_log_id', logId);
    } catch (err) { console.error('Failed to revert bank audit entry on lead rejection:', err.message); }

    // Restore the linked suspense receipt to its bare state so the rejected
    // money re-enters the FRO suspense pool under the bank-statement name (the
    // audit's payer_name) instead of the FRO's submitted donor details, and the
    // wrong donor info can't leak into auto-match or the Accounts suspense cards.
    try {
      for (const entry of rejectedEntries) {
        if (!entry.receipt_id) continue;
        await db.from('receipts').update({
          donor_name: entry.payer_name || null,
          donor_id: null,
          donor_mobile: null,
          pan_number: null,
          address: null,
          email: null,
        }).eq('id', entry.receipt_id);
      }
    } catch (err) { console.error('Failed to reset suspense receipt on lead rejection:', err.message); }

    if (log.fro_assignments?.donor_id) {
      await db.from('donor_profiles').update({ updated_at: new Date().toISOString() }).eq('id', log.fro_assignments.donor_id);
    }

    const froWorkerId = log.fro_worker_id;
    const assignmentNgoId = log.fro_assignments?.ngo_id;
    const assignmentStation = log.fro_assignments?.station;
    const donorName = log.fro_assignments?.donor_profiles?.name || 'Unknown';
    let froNotified = false;
    let ticketCreated = false;

    const notifTitle = 'Lead Rejected by Accounts';
    const notifBody = `Your lead for ${donorName} (₹${log.amount_collected || 0}) was rejected. Reason: ${reason}`;
    const refId = /^\d+$/.test(String(logId)) ? parseInt(logId) : null;

    if (froWorkerId) {
      let fcmLogged = false;
      try {
        const pushResult = await sendPushNotification(froWorkerId, notifTitle, notifBody, 'lead_rejected', refId);
        fcmLogged = !!pushResult;
      } catch (err) { console.error('FCM send error:', err.message); }

      if (!fcmLogged) {
        try {
          await db.from('notification_log').insert({
            worker_id: froWorkerId,
            type: 'lead_rejected',
            title: notifTitle,
            body: notifBody,
            fro_donor_log_id: String(logId),
            sent_at: new Date().toISOString(),
          });
        } catch (err) { console.error('Failed to create notification_log entry:', err.message); }
      }
      froNotified = true;
    }

    // Determine ngo_id (integer): worker_ngo_allocations > assignment's ngo_id > station's ngo_id
    let ngoId = null;
    if (froWorkerId) {
      try {
        const { data: alloc } = await db
          .from('worker_ngo_allocations')
          .select('ngo_id')
          .eq('worker_id', froWorkerId)
          .not('ngo_id', 'is', null)
          .limit(1)
          .maybeSingle();
        if (alloc?.ngo_id) ngoId = alloc.ngo_id;
      } catch (err) { console.error('Failed to fetch worker ngo allocation:', err.message); }
    }
    if (!ngoId && assignmentNgoId && typeof assignmentNgoId === 'number') {
      ngoId = assignmentNgoId;
    }
    if (!ngoId && assignmentStation) {
      try {
        const { data: stationAssign } = await db
          .from('fro_station_assignments')
          .select('ngo_id')
          .eq('station', assignmentStation)
          .not('ngo_id', 'is', null)
          .limit(1)
          .maybeSingle();
        if (stationAssign?.ngo_id) ngoId = stationAssign.ngo_id;
      } catch (err) { console.error('Failed to fetch station ngo:', err.message); }
    }

    try {
      await db.from('rejected_lead_tickets').insert({
        fro_donor_log_id: logId,
        fro_worker_id: froWorkerId,
        ngo_id: ngoId,
        donor_name: donorName,
        amount: log.amount_collected || 0,
        rejection_reason: reason,
        status: 'pending_review',
      });
      ticketCreated = true;
    } catch (err) { console.error('Failed to create rejected lead ticket:', err.message); }

    if (ngoId) {
      try {
        await db.from('alerts').insert({
          ngo_id: ngoId,
          type: 'lead_rejected',
          title: 'Lead Rejected',
          description: `${donorName} (₹${log.amount_collected || 0}) lead rejected. Reason: ${reason}`,
          donor_name: donorName,
        });
      } catch (err) { console.error('Failed to create alert:', err.message); }
    }

    return res.json({ message: 'Lead rejected', froWorkerId, froNotified, ticketCreated });  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Send a lead back to the FRO as if the lead_done disposition never happened.
// Works for pending (incl. suspense-claimed) and already-verified leads: any
// verification side-effects are reversed, the claimed suspense receipt returns
// to the pool, the disposition log is removed, and the assignment reopens so the
// FRO can rework it from scratch.
export const goBackLead = async (req, res) => {
  try {
    const { logId } = req.params;
    const { reason } = req.body || {};

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, fro_worker_id, donor_id, status, donor_profiles!inner(id, name, mobile_number))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    if (log.action !== 'disposition' || log.disposition_detail !== 'lead_done') {
      return res.status(400).json({ message: 'Only lead verification entries can be sent back' });
    }

    if (!['pending', 'verified'].includes(log.accounts_status)) {
      return res.status(400).json({ message: `This lead is ${log.accounts_status || 'processed'} and cannot be sent back` });
    }

    const assignmentId = log.fro_assignments?.id;
    const donorId = log.fro_assignments?.donor_id;

    // Reverse verification side-effects if the lead was already verified.
    if (log.accounts_status === 'verified') {
      const { error: revertError } = await db
        .from('fro_donor_logs')
        .update({ accounts_status: 'pending', verified_at: null, verified_by: null })
        .eq('id', logId);
      if (revertError) throw revertError;

      if (donorId) {
        try {
          const { data: donor } = await db
            .from('donor_profiles')
            .select('total_amount, donation_count')
            .eq('id', donorId)
            .single();
          const amount = Number(log.amount_collected || 0);
          await db.from('donor_profiles').update({
            total_amount: Math.max(0, (donor?.total_amount || 0) - amount),
            donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
            updated_at: new Date().toISOString(),
          }).eq('id', donorId);
        } catch (err) { console.error('Failed to reverse donor totals on go-back:', err.message); }
      }
    }

    // Receipt handling: revert any linked bank audit entry, then either delete
    // a verification-only receipt or release the money back to the pool. Either
    // way the receipt number is cancelled so it can be reused.
    const receipt = await findReceiptByLogId(logId);
    if (receipt) {
      const { data: entry } = await db.from('bank_audit_entries').select('id, match_status').eq('receipt_id', receipt.id).maybeSingle();
      if (entry) {
        // Keep the entry↔lead match so go-back restores the pre-verification
        // state; only downgrade confirmed → matched so Accounts can re-confirm.
        const entryPatch = {
          status: 'unverified',
          donor_id: null,
          donor_mobile: null,
          donor_email: null,
          donor_pan: null,
          donor_address_1: null,
          donor_address_2: null,
          donor_city: null,
          donor_pin_code: null,
          receipt_id: null,
          receipt_no: null,
          updated_at: new Date().toISOString(),
        };
        if (entry.match_status && entry.match_status !== 'matched') entryPatch.match_status = 'matched';
        const { error: eErr } = await db.from('bank_audit_entries').update(entryPatch).eq('id', entry.id);
        if (eErr) console.error('Failed to revert bank audit entry on go-back:', eErr.message);
      }

      // Void the receipt instead of deleting it or erasing its number — the
      // receipt number stays in the book (no gap) and the receipt stops counting.
      try { await voidReceipt(receipt.id, 'Lead sent back to FRO'); }
      catch (err) { console.error('Failed to void receipt on go-back:', err.message); }
    }

    // Revert an entry auto-verified from the lead's UPI transaction id.
    if (log.upi_transaction_id) {
      try {
        const autoEntry = await getEntryByPaymentId(log.upi_transaction_id, 'verified');
        if (autoEntry?.id) {
          await db.from('bank_audit_entries').update({ status: 'unverified', updated_at: new Date().toISOString() }).eq('id', autoEntry.id);
        }
      } catch (err) { console.error('Failed to revert auto-verified entry on go-back:', err.message); }
    }

    // Clear child references, then remove the disposition log (cleared disposition).
    try { await db.from('notification_log').delete().in('fro_donor_log_id', [logId]); }
    catch (err) { console.warn('notification_log cleanup skipped:', err.message); }
    try { await db.from('rejected_lead_tickets').delete().in('fro_donor_log_id', [logId]); }
    catch (err) { console.warn('rejected_lead_tickets cleanup skipped:', err.message); }
    const { error: delError } = await db.from('fro_donor_logs').delete().eq('id', logId);
    if (delError) throw delError;

    // Reopen the assignment so the FRO sees the lead again and can rework it.
    if (assignmentId) {
      const { error: asgnError } = await db
        .from('fro_assignments')
        .update({ status: 'pending', last_contacted_at: new Date().toISOString() })
        .eq('id', assignmentId);
      if (asgnError) throw asgnError;
    }

    // Notify the FRO that their lead was sent back.
    const froWorkerId = log.fro_worker_id;
    const donorName = log.fro_assignments?.donor_profiles?.name || 'Unknown';
    if (froWorkerId) {
      const notifTitle = 'Lead Sent Back';
      const notifBody = reason
        ? `Your lead for ${donorName} (\u20B9${log.amount_collected || 0}) was sent back. Reason: ${reason}`
        : `Your lead for ${donorName} (\u20B9${log.amount_collected || 0}) was sent back \u2014 please rework it.`;
      const refId = /^\d+$/.test(String(logId)) ? parseInt(logId, 10) : null;
      let fcmLogged = false;
      try {
        const pushResult = await sendPushNotification(froWorkerId, notifTitle, notifBody, 'lead_sent_back', refId);
        fcmLogged = !!pushResult;
      } catch (err) { console.error('FCM send error:', err.message); }
      if (!fcmLogged) {
        try {
          await db.from('notification_log').insert({
            worker_id: froWorkerId,
            type: 'lead_sent_back',
            title: notifTitle,
            body: notifBody,
            fro_donor_log_id: String(logId),
            sent_at: new Date().toISOString(),
          });
        } catch (err) { console.error('Failed to create notification_log entry:', err.message); }
      }
    }

    return res.json({ message: 'Lead sent back to the FRO', log_id: logId });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const undoLeadVerification = async (req, res) => {
  try {
    const { logId } = req.params;

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('*, fro_assignments!inner(id, donor_id, donor_profiles!inner(id, name, mobile_number))')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    if (log.action !== 'disposition' || log.disposition_detail !== 'lead_done') {
      return res.status(400).json({ message: 'Only lead verification entries can be undone' });
    }

    if (log.accounts_status !== 'verified') {
      return res.status(400).json({ message: `This lead is ${log.accounts_status || 'processed'} and cannot be undone` });
    }

    const donorId = log.fro_assignments?.donor_id;
    const assignmentId = log.fro_assignments?.id;

    // Bring the lead back to Lead Verification.
    const { error: revertError } = await db
      .from('fro_donor_logs')
      .update({ accounts_status: 'pending', verified_at: null, verified_by: null })
      .eq('id', logId);
    if (revertError) throw revertError;

    // Reopen the assignment so the donor's status returns to pending.
    if (assignmentId) {
      try {
        await db
          .from('fro_assignments')
          .update({ status: 'pending', last_contacted_at: new Date().toISOString() })
          .eq('id', assignmentId);
      } catch (err) { console.error('Failed to reopen assignment on undo:', err.message); }
    }

    // Reverse the donor totals added during verification.
    if (donorId) {
      try {
        const { data: donor } = await db
          .from('donor_profiles')
          .select('total_amount, donation_count')
          .eq('id', donorId)
          .single();
        const amount = Number(log.amount_collected || 0);
        await db.from('donor_profiles').update({
          total_amount: Math.max(0, (donor?.total_amount || 0) - amount),
          donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
          updated_at: new Date().toISOString(),
        }).eq('id', donorId);
      } catch (err) { console.error('Failed to reverse donor totals on undo:', err.message); }
    }

    // Cancel the receipt: a verification-only receipt is deleted outright; a
    // receipt tied to bank money is released back to the pool. Either way the
    // number is freed so the next verification reuses it. The linked bank audit
    // entry is sent back to Bank Audit (unverified, receipt-unlinked, match kept).
    const receipt = await findReceiptByLogId(logId);
    if (receipt) {
      const { data: entry } = await db.from('bank_audit_entries').select('id, match_status').eq('receipt_id', receipt.id).maybeSingle();
      if (entry) {
        // Keep the entry↔lead match so undo restores the pre-verification
        // state; only downgrade confirmed → matched so Accounts can re-confirm.
        const entryPatch = {
          status: 'unverified',
          donor_id: null,
          donor_mobile: null,
          donor_email: null,
          donor_pan: null,
          donor_address_1: null,
          donor_address_2: null,
          donor_city: null,
          donor_pin_code: null,
          receipt_id: null,
          receipt_no: null,
          updated_at: new Date().toISOString(),
        };
        if (entry.match_status && entry.match_status !== 'matched') entryPatch.match_status = 'matched';
        const { error: eErr } = await db.from('bank_audit_entries').update(entryPatch).eq('id', entry.id);
        if (eErr) console.error('Failed to revert bank audit entry on undo:', eErr.message);
      }

      if ((receipt.purpose === 'General Donation' || entry) && !receipt.sent) {
        try { await voidReceipt(receipt.id, 'Lead verification undone'); }
        catch (err) { console.error('Failed to void receipt on undo:', err.message); }
      } else {
        try { await voidReceipt(receipt.id, 'Lead verification undone'); }
        catch (err) { console.error('Failed to void receipt on undo:', err.message); }
      }
    }

    // Revert an entry auto-verified from the lead's UPI transaction id.
    if (log.upi_transaction_id) {
      try {
        const autoEntry = await getEntryByPaymentId(log.upi_transaction_id, 'verified');
        if (autoEntry?.id) {
          await db.from('bank_audit_entries').update({ status: 'unverified', updated_at: new Date().toISOString() }).eq('id', autoEntry.id);
        }
      } catch (err) { console.error('Failed to revert auto-verified entry on undo:', err.message); }
    }

    // Clear child references.
    try { await db.from('notification_log').delete().in('fro_donor_log_id', [logId]); }
    catch (err) { console.warn('notification_log cleanup skipped:', err.message); }
    try { await db.from('rejected_lead_tickets').delete().in('fro_donor_log_id', [logId]); }
    catch (err) { console.warn('rejected_lead_tickets cleanup skipped:', err.message); }

    return res.json({ message: 'Lead returned to Lead Verification', log_id: logId });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Universal receipt go-back: works for ANY receipt (with or without log_id,
// from manual verify, bank audit, lead verification, CSV import, etc.).
export const undoReceipt = async (req, res) => {
  try {
    const { receiptId } = req.params;
    const { data: receipt, error: rErr } = await db
      .from('receipts').select('*').eq('id', receiptId).maybeSingle();
    if (rErr) throw rErr;
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const donorId = receipt.donor_id;
    const logId = receipt.log_id;
    const projectId = receipt.project_id;

    // 1. Revert linked bank_audit_entry if any. The entry↔lead match survives
    // (downgraded confirmed → matched) so go-back restores the pre-verification
    // state and Accounts can re-confirm without re-matching.
    const { data: entry } = await db.from('bank_audit_entries')
      .select('id, match_status').eq('receipt_id', receipt.id).maybeSingle();
    if (entry) {
      const entryPatch = {
        // agent_name (the claiming FRO's stamp) is kept: go-back restores the
        // pre-verification state, it must not anonymise the claimant.
        status: 'unverified', donor_id: null,
        donor_mobile: null, donor_email: null, donor_pan: null,
        donor_address_1: null, donor_address_2: null, donor_city: null, donor_pin_code: null,
        receipt_id: null, receipt_no: null, updated_at: new Date().toISOString(),
      };
      if (entry.match_status && entry.match_status !== 'matched') entryPatch.match_status = 'matched';
      await db.from('bank_audit_entries').update(entryPatch).eq('id', entry.id);
    }

    // 2. Revert fro_donor_log if linked.
    if (logId) {
      try {
        const { data: log } = await db.from('fro_donor_logs')
          .select('id, action, disposition_detail, accounts_status, amount_collected, fro_worker_id, fro_assignments!inner(id, status, donor_id, ngo_id)')
          .eq('id', logId).maybeSingle();
        if (log) {
          // Revert the log to pending.
          await db.from('fro_donor_logs').update({
            accounts_status: 'pending', verified_at: null, verified_by: null,
          }).eq('id', logId);
          // Reopen assignment if it was donation_collected.
          const asgn = log.fro_assignments;
          if (asgn?.id && asgn.status === 'donation_collected') {
            await db.from('fro_assignments').update({
              status: 'pending', last_contacted_at: new Date().toISOString(),
            }).eq('id', asgn.id);
          }
          // Reverse donor totals.
          if (asgn?.donor_id && log.accounts_status === 'verified') {
            try {
              const { data: donor } = await db.from('donor_profiles')
                .select('total_amount, donation_count').eq('id', asgn.donor_id).single();
              const amt = Number(log.amount_collected || 0);
              await db.from('donor_profiles').update({
                total_amount: Math.max(0, (donor?.total_amount || 0) - amt),
                donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
                updated_at: new Date().toISOString(),
              }).eq('id', asgn.donor_id);
            } catch (e) { console.error('donor totals revert failed:', e.message); }
          }
          // Clean up child references.
          try { await db.from('notification_log').delete().in('fro_donor_log_id', [logId]); } catch (_) {}
          try { await db.from('rejected_lead_tickets').delete().in('fro_donor_log_id', [logId]); } catch (_) {}
        }
      } catch (e) { console.error('fro_donor_log revert failed:', e.message); }
    }

    // 3. Reverse donor totals from the receipt itself (if no log but has donor_id).
    if (donorId && !logId) {
      try {
        const { data: donor } = await db.from('donor_profiles')
          .select('total_amount, donation_count').eq('id', donorId).single();
        const amt = Number(receipt.amount || 0);
        await db.from('donor_profiles').update({
          total_amount: Math.max(0, (donor?.total_amount || 0) - amt),
          donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
          updated_at: new Date().toISOString(),
        }).eq('id', donorId);
      } catch (e) { console.error('donor totals revert (receipt-level) failed:', e.message); }
    }

    // 4. Void the receipt (or delete only if it is the latest number, so the
    // counter steps back with no gap).
    await deleteReceiptSafely(receipt.id, 'Receipt undone');

    return res.json({ message: 'Receipt undone — returned to Bank Audit', receipt_id: receipt.id });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteLead = async (req, res) => {
  try {
    const { logId } = req.params;

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select('id, action, disposition_detail, accounts_status, fro_worker_id, fro_assignments!inner(id, status, donor_id, fro_worker_id)')
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    if (log.action !== 'disposition' || log.disposition_detail !== 'lead_done') {
      return res.status(400).json({ message: 'Only lead verification entries can be deleted' });
    }

    if (log.accounts_status !== 'pending') {
      return res.status(400).json({ message: `Only pending leads can be deleted (this one is ${log.accounts_status || 'processed'})` });
    }

    // Release any suspense-claim receipt linked to this lead back to the pool
    // (also required to satisfy the receipts->fro_donor_logs FK before deleting).
    try {
      const receipt = await findReceiptByLogId(logId);
      if (receipt) {
        await db.from('receipts').update({ log_id: null, donor_id: null }).eq('id', receipt.id);
      }
    } catch (err) { console.warn('Failed to release linked receipt on delete:', err.message); }

    const { error: delError } = await db
      .from('fro_donor_logs')
      .delete()
      .eq('id', logId);
    if (delError) throw delError;

    // Delete the orphaned assignment
    const assignmentId = log.fro_assignments?.id;
    if (assignmentId) {
      const { error: asgnError } = await db
        .from('fro_assignments')
        .delete()
        .eq('id', assignmentId);
      if (asgnError) throw asgnError;
    }

    return res.json({ message: 'Lead deleted', log_id: logId });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteAllPendingLeads = async (req, res) => {
  try {
    const { data: logs, error: listError } = await db
      .from('fro_donor_logs')
      .select('id, assignment_id')
      .eq('action', 'disposition')
      .eq('disposition_detail', 'lead_done')
      .eq('accounts_status', 'pending');

    if (listError) throw listError;

    const ids = (logs || []).map(l => l.id);
    const assignmentIds = [...new Set((logs || []).map(l => l.assignment_id).filter(Boolean))];

    if (ids.length > 0) {
      // Release any linked receipts to satisfy FK before deleting logs
      try {
        await db.from('receipts').update({ log_id: null, donor_id: null }).in('log_id', ids);
      } catch (e) { console.warn('Failed to release receipts on bulk delete:', e.message); }

      const { error: delError } = await db
        .from('fro_donor_logs')
        .delete()
        .in('id', ids);
      if (delError) throw delError;
    }

    // Delete orphaned assignments
    if (assignmentIds.length > 0) {
      const { error: asgnError } = await db
        .from('fro_assignments')
        .delete()
        .in('id', assignmentIds);
      if (asgnError) throw asgnError;
    }

    return res.json({ message: 'Pending leads deleted', deleted: ids.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Inline Field Update ───────────────────────────────────

const ALLOWED_FIELDS = ['upi_transaction_id', 'transaction_datetime', 'payment_from', 'payment_mode', 'pan_number', 'notes', 'remark',
  'donor_name', 'donor_mobile', 'donor_city', 'donor_email', 'donor_pan', 'donor_address', 'donor_dob'];

const DONOR_FIELD_MAP = {
  donor_name: 'name',
  donor_mobile: 'mobile_number',
  donor_city: 'city',
  donor_email: 'email',
  donor_pan: 'pan_number',
  donor_address: 'address_1',
  donor_dob: 'birth_date',
};

export const patchLeadField = async (req, res) => {
  try {
    const { logId } = req.params;
    const { field, value } = req.body;

    if (!field || !ALLOWED_FIELDS.includes(field)) {
      return res.status(400).json({ message: `Invalid field. Allowed: ${ALLOWED_FIELDS.join(', ')}` });
    }

    const isDonorField = field in DONOR_FIELD_MAP;

    if (isDonorField) {
      const { data: logs, error: logError } = await db
        .from('fro_donor_logs')
        .select('id, fro_assignments!inner(donor_id)')
        .eq('id', logId)
        .limit(1);

      if (logError || !logs || logs.length === 0) {
        return res.status(404).json({ message: 'Log entry not found' });
      }
      const log = logs[0];

      const donorId = log.fro_assignments?.donor_id;
      if (!donorId) {
        return res.status(400).json({ message: 'Donor not associated with this lead' });
      }

      const donorColumn = DONOR_FIELD_MAP[field];
      const { error: updateError } = await db
        .from('donor_profiles')
        .update({ [donorColumn]: value === '' ? null : value, updated_at: new Date().toISOString() })
        .eq('id', donorId);

      if (updateError) throw updateError;

      return res.json({ message: 'Field updated', field, value: value === '' ? null : value });
    }

    const { data: log, error: logError } = await db
      .from('fro_donor_logs')
      .select('id, accounts_status')
      .eq('id', logId)
      .single();

    if (logError || !log) {
      return res.status(404).json({ message: 'Log entry not found' });
    }

    const updateData = {};
    updateData[field] = value === '' ? null : value;

    const { error: updateError } = await db
      .from('fro_donor_logs')
      .update(updateData)
      .eq('id', logId);

    if (updateError) throw updateError;

    return res.json({ message: 'Field updated', field, value: updateData[field] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Receipts ──────────────────────────────────────────────

export const generateReceipt = async (req, res) => {
  try {
    const { logId } = req.params;
    const { pan_number, address, mode, purpose } = req.body;

    const existing = await findReceiptByLogId(logId);
    if (existing) {
      return res.json({ receipt: existing, message: 'Receipt already exists' });
    }

    const { data: logs, error: logError } = await db
      .from('fro_donor_logs')
      .select(`
        id, fro_worker_id, operator_id, amount_collected, pan_number, notes, transaction_datetime, verified_at,
        fro_assignments!inner(
          donor_id,
          fro_worker_id,
          ngo_id,
          ngos(name),
          donor_profiles!inner(id, name, mobile_number, city, address_1, address_2, email, pan_number, project_supported, donors_bank_name),
          workers!inner(id, name, login_id)
        )
      `)
      .eq('id', logId)
      .limit(1);

    if (logError || !logs || logs.length === 0) {
      return res.status(404).json({ message: 'Log entry not found' });
    }
    const log = logs[0];

    // Stamp the receipt with whoever actually collected. The claim ACTOR is
    // the log's operator_id (recorded during a Work As / cover session);
    // fro_worker_id is the covered FRO and is only the answer when no operator
    // was recorded. Falls back to the assignment owner last.
    let agentName = null;
    const operatorName = await resolveOperatorName(log.operator_id);
    // Label, not human name — receipts.agent_name is the credit key (see
    // agentStamp in verifyLead) and is already stamped with the label at claim.
    if (operatorName?.label || operatorName?.name) {
      agentName = operatorName.label || operatorName.name;
    } else {
      const creditId = log.fro_worker_id;
      if (creditId) {
        if (String(creditId) === String(log.fro_assignments?.fro_worker_id)) {
          agentName = log.fro_assignments?.workers?.name || null;
        } else {
          const { data: cw } = await db.from('workers').select('name').eq('id', creditId).maybeSingle();
          agentName = cw?.name || null;
        }
      }
    }

    const donorProfile = log.fro_assignments?.donor_profiles;
    let project = donorProfile?.project_supported || 'bsct';
    try {
      project = await projectCodeFromNgoId(log.fro_assignments?.ngo_id) || project;
    } catch (err) { console.error('Failed to resolve project from assignment NGO:', err.message); }
    const donorName = donorProfile?.name || 'Unknown';

    const receiptNo = await getNextReceiptNo(project);

    const donorId = log.fro_assignments?.donor_id;
    const receipt = await createReceipt({
      log_id: logId,
      receipt_no: receiptNo,
      project_id: project,
      donor_name: donorName,
      donor_mobile: donorProfile?.mobile_number || null,
      amount: log.amount_collected || 0,
      pan_number: pan_number || log.pan_number || donorProfile?.pan_number || null,
      address: address || [donorProfile?.address_1, donorProfile?.address_2].filter(Boolean).join(', ') || null,
      email: donorProfile?.email || null,
      bank_name: donorProfile?.donors_bank_name || null,
      mode: mode || null,
      purpose: purpose || 'General Donation',
      agent_name: agentName,
      generated_by: req.user.id,
      donor_id: donorId,
      receipt_date: log.transaction_datetime || log.verified_at || new Date().toISOString(),
    });

    return res.status(201).json({ receipt, message: 'Receipt generated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getReceipt = async (req, res) => {
  try {
    const { logId } = req.params;
    const receipt = await findReceiptByLogId(logId);
    if (!receipt) {
      return res.status(404).json({ message: 'Receipt not found' });
    }
    return res.json(receipt);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getReceiptList = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const reqLimit = parseInt(req.query.limit, 10);
    const limitAll = Number.isFinite(reqLimit) && reqLimit <= 0;
    const limit = limitAll ? -1 : Math.min(100, Math.max(1, reqLimit || 50));
    const search = (req.query.search || '').trim();
    const project = (req.query.project || '').trim();
    const link = (req.query.link === 'suspense' || req.query.link === 'unlinked')
      ? 'suspense'
      : (req.query.link === 'donors' || req.query.link === 'linked' ? 'donors'
      : (req.query.link === 'others' ? 'others'
      : (req.query.link === 'pg' ? 'pg' : '')));
    const isSuspense = link === 'suspense' || req.query.suspense === '1';
    const isPg = link === 'pg' || req.query.pg === '1';
    const isLibrary = link === 'library' || req.query.library === '1';

    // Cheap per-NGO aggregates + project options. Kept in sync with the visible
    // list below (receipt_no IS NOT NULL) so the cards always equal the sum of
    // the rows actually shown — suspense/unnumbered receipts are counted on the
    // bank-audit side instead of silently inflating a project's total here.
    const statsRes = await db._pool.query(
      `SELECT project_id,
              count(*)::int AS count,
              COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount,
              count(DISTINCT COALESCE(NULLIF(donor_mobile, ''), donor_name))::int AS donors
       FROM receipts
       WHERE receipt_no IS NOT NULL
       GROUP BY project_id
       ORDER BY count(*) DESC`
    );
    const projectsRes = await db._pool.query(
      `SELECT project_id, count(*)::int AS n FROM receipts GROUP BY project_id ORDER BY n DESC`
    );

    // Month-scoped stats (honours from_date / to_date if provided).
    const monthFrom = (req.query.from_date || '').trim();
    const monthTo = (req.query.to_date || '').trim();
    let monthStatsByProject = statsRes.rows;
    if (monthFrom || monthTo) {
      const mw = []; const mp = [];
      if (monthFrom) { mp.push(monthFrom); mw.push(`receipt_date >= ($${mp.length}::date AT TIME ZONE 'Asia/Kolkata')`); }
      if (monthTo)   { mp.push(monthTo);   mw.push(`receipt_date < (($${mp.length}::date + 1) AT TIME ZONE 'Asia/Kolkata')`); }
      const mRes = await db._pool.query(
        `SELECT project_id,
                count(*)::int AS count,
                COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount,
                count(DISTINCT COALESCE(NULLIF(donor_mobile, ''), donor_name))::int AS donors
         FROM receipts WHERE receipt_no IS NOT NULL AND (${mw.join(' AND ')})
         GROUP BY project_id ORDER BY count(*) DESC`, mp
      );
      monthStatsByProject = mRes.rows;
    }

    // Today stats (IST) per project — use selected date if provided, else today.
    const todayDateParam = (monthFrom || monthTo) || null;
    const todayRes = todayDateParam
      ? await db._pool.query(
          `SELECT project_id,
                  count(*)::int AS count,
                  COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount
           FROM receipts
           WHERE receipt_no IS NOT NULL AND receipt_date = $1::date
           GROUP BY project_id`,
          [todayDateParam]
        )
      : await db._pool.query(
          `SELECT project_id,
                  count(*)::int AS count,
                  COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount
           FROM receipts
           WHERE receipt_no IS NOT NULL AND receipt_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
           GROUP BY project_id`
        );

    const where = [];
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(receipt_no ILIKE $${params.length} OR donor_name ILIKE $${params.length} OR donor_mobile ILIKE $${params.length}
        OR mobile_2 ILIKE $${params.length} OR pan_number ILIKE $${params.length} OR email ILIKE $${params.length}
        OR payment_id ILIKE $${params.length} OR agent_name ILIKE $${params.length})`);
    }
    if (project) {
      params.push(project);
      where.push(`project_id = $${params.length}`);
    }
    if (link === 'donors') where.push('donor_id IS NOT NULL');
    if (isSuspense) {
      where.push(`lower(trim(agent_name)) = 'suspense'`);
    }
    if (isPg) {
      where.push(`lower(trim(agent_name)) = 'pg'`);
    }
    if (isLibrary) {
      where.push(`lower(trim(agent_name)) = 'library'`);
    }
    if (link === 'others') {
      where.push(`lower(trim(agent_name)) IN ('priyank shah', 'priyank sir')`);
    }
    // Only show numbered receipts in every view, including suspense / PG tabs
    // (un-numbered suspense entries are hidden).
    where.push('receipt_no IS NOT NULL');

    const period = (req.query.period || '').trim();
    const fromDate = (req.query.from_date || '').trim();
    const toDate = (req.query.to_date || '').trim();
    if (period === 'today') {
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    } else if (period === 'yesterday') {
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date = ((now() - INTERVAL '1 day') AT TIME ZONE 'Asia/Kolkata')::date`);
    } else if (period === 'week') {
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date >= ((now() - INTERVAL '7 days') AT TIME ZONE 'Asia/Kolkata')::date`);
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    } else if (period === 'month') {
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date`);
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    } else if (period === 'year') {
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date >= date_trunc('year', now() AT TIME ZONE 'Asia/Kolkata')::date`);
      where.push(`(receipt_date AT TIME ZONE 'Asia/Kolkata')::date <= (now() AT TIME ZONE 'Asia/Kolkata')::date`);
    }
    if (fromDate) { params.push(fromDate); where.push(`receipt_date >= ($${params.length}::date AT TIME ZONE 'Asia/Kolkata')`); }
    if (toDate) { params.push(toDate); where.push(`receipt_date < (($${params.length}::date + 1) AT TIME ZONE 'Asia/Kolkata')`); }
    const minAmount = parseFloat(req.query.min_amount);
    if (Number.isFinite(minAmount)) { params.push(minAmount); where.push(`amount >= $${params.length}`); }
    const maxAmount = parseFloat(req.query.max_amount);
    if (Number.isFinite(maxAmount)) { params.push(maxAmount); where.push(`amount <= $${params.length}`); }

    const hasDateFilter = !!period || !!fromDate || !!toDate;
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totalRes = await db._pool.query(`SELECT count(*)::int AS n FROM receipts ${whereSql}`, params);

    // Ascending by receipt number when searching, otherwise highest receipt number first.
    const orderSql = search
      ? 'ORDER BY receipt_no ASC, receipt_date ASC'
      : 'ORDER BY CAST(receipt_no AS INTEGER) DESC, receipt_date DESC';

    if (hasDateFilter) {
      const rowsRes = await db._pool.query(
        `SELECT id, log_id, receipt_no, project_id, donor_name,
                COALESCE(receipts.donor_mobile,
                  (SELECT b.donor_mobile FROM bank_audit_entries b
                   WHERE b.receipt_id = receipts.id AND b.donor_mobile IS NOT NULL AND b.donor_mobile <> ''
                   ORDER BY b.id LIMIT 1)
                ) AS donor_mobile,
                amount,
                receipt_date, receipt_time, "mode", payment_id, bank_name, bank_payer_name, address, pan_number, email,
                donor_id, agent_name, caller_name, mobile_2, address_2, station, account_of,
                sent, sent_at, voided_at, void_reason, created_at,
                wa_message_id, wa_status, wa_failure_reason, wa_status_at,
                (SELECT b.payer_name FROM bank_audit_entries b
                 WHERE b.receipt_id = receipts.id AND b.payer_name IS NOT NULL AND b.payer_name <> ''
                 ORDER BY b.id LIMIT 1) AS audit_payer_name,
                (SELECT bs.name FROM bank_audit_entries b
                 JOIN bank_audit_sources bs ON b.source_id = bs.id
                 WHERE b.receipt_id = receipts.id
                 ORDER BY b.id LIMIT 1) AS received_bank,
                (SELECT b.verify_type FROM bank_audit_entries b
                 WHERE b.receipt_id = receipts.id AND b.verify_type = 'cross_fro'
                 ORDER BY b.id LIMIT 1) AS verify_type,
                (SELECT b.verify_fro_worker_id FROM bank_audit_entries b
                 WHERE b.receipt_id = receipts.id AND b.verify_type = 'cross_fro'
                 ORDER BY b.id LIMIT 1) AS verify_fro_worker_id
         FROM receipts ${whereSql}
         ${orderSql}`,
        params
      );
      return res.json({
        data: rowsRes.rows,
        total: totalRes.rows[0].n,
        statsByProject: statsRes.rows,
        monthStatsByProject,
        todayStats: todayRes.rows,
        projects: projectsRes.rows.map(p => p.project_id),
      });
    }

    const limitSql = limitAll ? '' : `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    const rowsParams = limitAll ? params : [...params, limit, (page - 1) * limit];
    const rowsRes = await db._pool.query(
      `SELECT id, log_id, receipt_no, project_id, donor_name,
              COALESCE(receipts.donor_mobile,
                (SELECT b.donor_mobile FROM bank_audit_entries b
                 WHERE b.receipt_id = receipts.id AND b.donor_mobile IS NOT NULL AND b.donor_mobile <> ''
                 ORDER BY b.id LIMIT 1)
              ) AS donor_mobile,
              amount,
              receipt_date, receipt_time, "mode", payment_id, bank_name, bank_payer_name, address, pan_number, email,
              donor_id, agent_name, caller_name, mobile_2, address_2, station, account_of,
              sent, sent_at, voided_at, void_reason, created_at,
              wa_message_id, wa_status, wa_failure_reason, wa_status_at,
              (SELECT b.payer_name FROM bank_audit_entries b
               WHERE b.receipt_id = receipts.id AND b.payer_name IS NOT NULL AND b.payer_name <> ''
               ORDER BY b.id LIMIT 1) AS audit_payer_name,
              (SELECT bs.name FROM bank_audit_entries b
               JOIN bank_audit_sources bs ON b.source_id = bs.id
               WHERE b.receipt_id = receipts.id
               ORDER BY b.id LIMIT 1) AS received_bank,
              (SELECT b.verify_type FROM bank_audit_entries b
               WHERE b.receipt_id = receipts.id AND b.verify_type = 'cross_fro'
               ORDER BY b.id LIMIT 1) AS verify_type,
              (SELECT b.verify_fro_worker_id FROM bank_audit_entries b
               WHERE b.receipt_id = receipts.id AND b.verify_type = 'cross_fro'
               ORDER BY b.id LIMIT 1) AS verify_fro_worker_id
       FROM receipts ${whereSql}
       ${orderSql}
       ${limitSql}`,
      rowsParams
    );

    return res.json({
      data: rowsRes.rows,
      total: totalRes.rows[0].n,
      statsByProject: statsRes.rows,
      monthStatsByProject,
      todayStats: todayRes.rows,
      projects: projectsRes.rows.map(p => p.project_id),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Suggest donor addresses from the DB to autofill a lead's missing address.
// Matches the same donor (mobile/name) across donor_profiles and receipts,
// plus a free-text ILIKE search over both address columns.
export const getAddressSuggestions = async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const mobile = (req.query.mobile || '').trim();
    const name = (req.query.name || '').trim();

    const seen = new Map();
    const add = (address, source) => {
      const a = (address || '').trim();
      if (!a || a.length < 3) return;
      if (seen.has(a)) { seen.get(a).count += 1; return; }
      seen.set(a, { address: a, count: 1, source });
    };

    // 1) The lead's own donor profile address (most relevant, always first)
    if (mobile) {
      const { rows } = await db._pool.query(
        `SELECT address_1 FROM donor_profiles WHERE mobile_number = $1 AND address_1 IS NOT NULL AND address_1 <> ''`,
        [mobile]
      );
      rows.forEach(r => add(r.address_1, 'This donor'));
    }

    // 2) Other profiles matching the same name/mobile
    if (name || mobile) {
      const conds = [];
      const params = [];
      if (name) { params.push(`%${name}%`); conds.push(`name ILIKE $${params.length}`); }
      if (mobile) { params.push(mobile); conds.push(`mobile_number = $${params.length}`); }
      const { rows } = await db._pool.query(
        `SELECT address_1 FROM donor_profiles WHERE (${conds.join(' OR ')}) AND address_1 IS NOT NULL AND address_1 <> ''`,
        params
      );
      rows.forEach(r => add(r.address_1, 'Donor profile'));
    }

    // 3) Receipts filed under the same donor
    if (name || mobile) {
      const conds = [];
      const params = [];
      if (name) { params.push(`%${name}%`); conds.push(`donor_name ILIKE $${params.length}`); }
      if (mobile) { params.push(mobile); conds.push(`donor_mobile = $${params.length}`); }
      const { rows } = await db._pool.query(
        `SELECT address, count(*)::int AS n FROM receipts
         WHERE (${conds.join(' OR ')}) AND address IS NOT NULL AND address <> ''
         GROUP BY address ORDER BY n DESC`,
        params
      );
      rows.forEach(r => add(r.address, 'Receipt'));
    }

    // 4) Free-text search over addresses
    if (q && q.length >= 2) {
      const like = `%${q}%`;
      const { rows: r1 } = await db._pool.query(
        `SELECT address, count(*)::int AS n FROM receipts
         WHERE address ILIKE $1 AND address IS NOT NULL AND address <> ''
         GROUP BY address ORDER BY n DESC LIMIT 20`,
        [like]
      );
      r1.forEach(r => add(r.address, 'Receipt'));
      const { rows: r2 } = await db._pool.query(
        `SELECT address_1, count(*)::int AS n FROM donor_profiles
         WHERE address_1 ILIKE $1 AND address_1 IS NOT NULL AND address_1 <> ''
         GROUP BY address_1 ORDER BY n DESC LIMIT 20`,
        [like]
      );
      r2.forEach(r => add(r.address_1, 'Donor profile'));
    }

    return res.json(Array.from(seen.values()).slice(0, 25));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getPendingReceipts = async (req, res) => {
  try {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: receipts, error: recError } = await db
      .from('receipts')
      .select('*')
      .not('donor_id', 'is', null)
      .not('receipt_no', 'is', null)
      .not('receipt_no', 'eq', '')
      .is('voided_at', null)
      .or(`sent.is.null,sent.eq.false,and(sent.eq.true,sent_at.gte.${tenMinAgo})`)
      .order('created_at', { ascending: false });

    if (recError) throw recError;
    if (!receipts || receipts.length === 0) return res.json([]);

    const logIds = receipts.map(r => r.log_id).filter(Boolean);

    const { data: logs, error: logErr } = await db
      .from('fro_donor_logs')
      .select(`
        id, amount_collected, accounts_status, verified_at, upi_transaction_id, transaction_datetime, payment_from, payment_mode,
        fro_assignments!inner(
          donor_id, ngo_id,
          ngos!left(id, name),
          donor_profiles!inner(id, name, mobile_number, city, email, pan_number, address_1, project_supported)
        )
      `)
      .in('id', logIds);

    if (logErr) throw logErr;

    const logMap = {};
    for (const l of logs || []) logMap[l.id] = l;

    const eligible = receipts.filter(r => {
      if (!r.log_id) return true;
      const log = logMap[r.log_id];
      return log && log.accounts_status === 'verified';
    });

    const result = eligible.map(r => {
      const log = logMap[r.log_id];
      const donor = log?.fro_assignments?.donor_profiles;
      const froNgo = log?.fro_assignments?.ngos?.name;
      const froProject =
        froNgo === 'BSCT' ? 'bsct' :
        froNgo === 'AFLF' ? 'aflf' :
        froNgo === 'MANN' ? 'mann' :
        (donor?.project_supported || '');
      const rawPid = String(r.project_id || '').trim().toLowerCase();
      const pidProject =
        rawPid === 'bsct' || rawPid === 'being sevak' || rawPid === 'beingsevak' ? 'bsct' :
        rawPid === 'aflf' || rawPid === 'ashray' ? 'aflf' :
        rawPid === 'mann' || rawPid === 'mann care' || rawPid === 'manncar' ? 'mann' :
        (rawPid || '');
      const project = pidProject || String(froProject || '').trim().toLowerCase() || '';
      return {
        'Donor Name': r.donor_name || donor?.name || '',
        'Address 1': r.address || donor?.address_1 || '',
        'PAN No.': r.pan_number || donor?.pan_number || '',
        'Email ID': r.email || donor?.email || '',
        'Mode of Payment (MOP)': log?.payment_mode || r.mode || 'Bank',
        'Payment ID No.': log?.upi_transaction_id || r.payment_id || '',
        'Donor Bank Name': r.bank_name || donor?.donors_bank_name || '',
        'Amount': String(r.amount || 0),
        'Receipt No.': r.receipt_no || '',
        'Receipt Date': r.receipt_date || log?.verified_at || '',
        'Account Of': 'Corpus',
        'Mobile No.': r.donor_mobile || donor?.mobile_number || '',
        'City': donor?.city || '',
        'Agent Name': r.agent_name || '',
        receipt_id: r.id,
        sent: r.sent || false,
        // Real delivery verdict, straight from the Meta status webhook. Absent
        // on receipts sent before this was tracked, so the UI must treat null as
        // "unknown" rather than "failed".
        wa_status: r.wa_status || null,
        wa_failure_reason: r.wa_failure_reason || null,
        wa_status_at: r.wa_status_at || null,
        log_id: r.log_id,
        'Project': project,
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const markReceiptAsSent = async (req, res) => {
  try {
    const { receiptId, receipt_ids: receiptIds } = req.body;
    const ids = Array.isArray(receiptIds) ? [...new Set(receiptIds.filter(Boolean))] : (receiptId ? [receiptId] : []);
    if (ids.length === 0) return res.status(400).json({ message: 'receiptId or receipt_ids is required' });
    if (ids.length > 50) return res.status(400).json({ message: 'A maximum of 50 receipt IDs can be updated at once' });

    const { data, error } = await db
      .from('receipts')
      .update({ sent: true, sent_at: new Date().toISOString() })
      .in('id', ids)
      .select();

    if (error) throw error;
    return res.json({ success: true, data: { receipt_ids: (data || []).map(receipt => receipt.id), updated_count: data?.length || 0 } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── WhatsApp send queue: hidden receipts ─────────────────
// Rows that silently fail the pending-queue checks (getPendingReceipts):
// no receipt number, no donor link, unverified lead, or stamped already-sent.
// Surfaced here so nothing disappears without explanation — plus Fix/Delete.

const normalizeMobileKey = (v) => {
  let n = String(v ?? '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length === 12 && n.startsWith('91')) n = n.slice(2);
  else if (n.length === 11 && n.startsWith('0')) n = n.slice(1);
  return n;
};

const MOBILE_CANON_SQL = `
  SELECT id FROM (
    SELECT id, CASE
                 WHEN length(digits) = 12 AND left(digits, 2) = '91' THEN substr(digits, 3)
                 WHEN length(digits) = 11 AND left(digits, 1) = '0' THEN substr(digits, 2)
                 ELSE digits
               END AS canon
    FROM (SELECT id, regexp_replace(mobile_number, '[^0-9]', '', 'g') AS digits
          FROM donor_profiles WHERE mobile_number IS NOT NULL) t
  ) u WHERE u.canon = $1 LIMIT 1`;

export const getExcludedReceipts = async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const { rows } = await db._pool.query(
      `SELECT r.id, r.receipt_no, r.donor_name, r.donor_mobile, r.amount, r.project_id,
              r.mode, r.agent_name, r.created_at, r.sent, r.sent_at, r.log_id,
              l.accounts_status AS log_status,
              array_remove(ARRAY[
                CASE WHEN COALESCE(r.receipt_no,'') = '' THEN 'no_number' END,
                CASE WHEN r.donor_id IS NULL THEN 'no_donor' END,
                CASE WHEN r.sent IS TRUE THEN 'already_sent' END,
                CASE WHEN r.log_id IS NOT NULL AND COALESCE(l.accounts_status,'') <> 'verified'
                     THEN 'lead_not_verified' END
              ], NULL) AS reasons,
              EXISTS (
                SELECT 1 FROM receipts d
                WHERE d.id <> r.id AND d.project_id = r.project_id
                  AND COALESCE(d.receipt_no,'') <> ''
                  AND regexp_replace(COALESCE(d.donor_mobile,''),'[^0-9]','','g') <> ''
                  AND regexp_replace(COALESCE(d.donor_mobile,''),'[^0-9]','','g')
                    = regexp_replace(COALESCE(r.donor_mobile,''),'[^0-9]','','g')
                  AND ABS(EXTRACT(EPOCH FROM (d.created_at - r.created_at))) < 172800
                  AND ABS(COALESCE(d.amount,0) - COALESCE(r.amount,0)) < 0.01
              ) AS likely_duplicate
       FROM receipts r
       LEFT JOIN fro_donor_logs l ON l.id = r.log_id
       WHERE r.created_at >= now() - make_interval(days => $1::int)
         AND r.voided_at IS NULL
         AND (
              COALESCE(r.receipt_no,'') = ''
           OR r.donor_id IS NULL
           OR (r.log_id IS NOT NULL AND COALESCE(l.accounts_status,'') <> 'verified')
           OR (r.sent IS TRUE AND r.log_id IS NOT NULL)
         )
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [days, limit]
    );
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const fixAndQueueReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const clearSent = req.body?.clear_sent === true;
    const { data: receipt, error: fetchErr } = await db
      .from('receipts').select('*').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    const patch = { updated_at: new Date().toISOString() };
    const actions = [];

    if (!receipt.receipt_no) {
      patch.receipt_no = await getNextReceiptNo(receipt.project_id);
      actions.push(`assigned number ${patch.receipt_no}`);
    }

    if (!receipt.donor_id && receipt.donor_mobile) {
      const key = normalizeMobileKey(receipt.donor_mobile);
      if (key.length >= 10) {
        const { rows: found } = await db._pool.query(MOBILE_CANON_SQL, [key]);
        let donorId = found[0]?.id || null;
        if (!donorId) {
          const ins = await db.from('donor_profiles').insert({
            name: receipt.donor_name || 'Unknown',
            mobile_number: key,
            project_supported: receipt.project_id || null,
            data_category: 'Send Queue Fix',
          }).select('id').single();
          if (ins.error) {
            if (ins.error.code === '23505' || /duplicate key/i.test(ins.error.message || '')) {
              const again = await db._pool.query('SELECT id FROM donor_profiles WHERE mobile_number = $1 LIMIT 1', [key]);
              donorId = again.rows[0]?.id || null;
              if (!donorId) throw ins.error;
            } else throw ins.error;
          } else {
            donorId = ins.data.id;
          }
          actions.push('created donor profile');
        } else {
          actions.push('linked existing donor');
        }
        patch.donor_id = donorId;
      }
    }

    if (clearSent && receipt.sent) {
      patch.sent = false;
      patch.sent_at = null;
      actions.push('cleared sent flag');
    }

    let updated = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await db.from('receipts').update(patch).eq('id', id).select().single();
      if (!error) { updated = data; break; }
      const msg = String(error.message || error);
      const isDup = error.code === '23505' || /duplicate key/i.test(msg);
      if (!isDup || !patch.receipt_no || attempt === 2) throw error;
      patch.receipt_no = await getNextReceiptNo(receipt.project_id);
      if (actions.length > 0) actions[actions.length - 1] = `assigned number ${patch.receipt_no}`;
    }
    if (!updated) throw new Error('Failed to update receipt');

    if (updated?.donor_id) {
      try {
        const worker = await resolveAgentToWorker(updated.agent_name);
        const ensured = await ensureAssignmentForDonorReceipt({ receipt: updated, workerId: worker?.id });
        if (ensured?.created && updated.agent_name) {
          actions.push(`created assignment for ${updated.agent_name}`);
        }
      } catch (err) {
        console.error('fixAndQueueReceipt: assignment ensure failed (non-fatal):', err.message);
      }
    }

    return res.json({ receipt: updated, actions });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteQueueReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const { data: receipt, error: fetchErr } = await db
      .from('receipts').select('id, log_id, receipt_no, project_id').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });
    if (receipt.log_id) {
      return res.status(400).json({ message: 'This receipt is linked to a lead. Use Go Back / Undo Verification instead.' });
    }
    const result = await deleteReceiptSafely(id, 'removed_from_send_queue');
    const action = result?.deleted ? 'deleted' : result?.gone ? 'already_gone' : 'voided';
    if (result?.deleted) {
      try { await cancelReceiptNo(receipt.project_id); } catch (_) {}
    }
    return res.json({ success: true, action });
  } catch (error) {
    if (error?.code === '23503' || /foreign key/i.test(String(error?.message))) {
      return res.status(409).json({ message: 'This receipt is referenced by a Bank Audit entry and cannot be removed here.' });
    }
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorHistory = async (req, res) => {
  try {
    const { donorId } = req.params;

    const { data: logs, error } = await db
      .from('fro_donor_logs')
      .select(`
        id, action, disposition_detail, amount_collected, accounts_status,
        payment_mode, upi_transaction_id, transaction_datetime, payment_from,
        created_at, verified_at, payment_screenshot_url, operator_id,
        fro_assignments!inner(donor_id, fro_worker_id, workers!inner(id, name, login_id))
      `)
      .eq('fro_assignments.donor_id', donorId)
      .or('action.eq.donation,and(disposition_detail.eq.lead_done,accounts_status.eq.verified)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Same rule as the Lead Verification list: a claim made during a Work As /
    // cover session names the operator (operator_id), not the covered FRO.
    const historyOperatorNames = await resolveOperatorNames((logs || []).map((l) => l.operator_id));

    const logIds = (logs || []).map(l => l.id);

    const { data: donor } = await db
      .from('donor_profiles')
      .select('id, mobile_number')
      .eq('id', donorId)
      .maybeSingle();

    // Receipts reach a donor via the log chain, a linked donor_id, or a
    // captured mobile only — union all three.
    const receiptPromises = [];
    if (logIds.length > 0) {
      receiptPromises.push(
        db.from('receipts').select('*').in('log_id', logIds)
      );
    }
    receiptPromises.push(
      Promise.resolve({ data: await receiptsForDonor(db, donor || { id: donorId }) })
    );

    const receiptResults = await Promise.allSettled(receiptPromises);
    const allReceipts = [];
    for (const r of receiptResults) {
      if (r.status === 'fulfilled' && r.value.data) {
        allReceipts.push(...r.value.data);
      }
    }
    // Deduplicate by id
    const seenReceiptIds = new Set();
    const uniqueReceipts = allReceipts.filter(r => {
      if (seenReceiptIds.has(r.id)) return false;
      seenReceiptIds.add(r.id);
      return true;
    });

    const receiptMap = {};
    for (const r of uniqueReceipts) receiptMap[r.log_id || `direct_${r.id}`] = r;

    const result = (logs || []).map(l => ({
      log_id: l.id,
      amount: l.amount_collected,
      payment_mode: l.payment_mode,
      upi_transaction_id: l.upi_transaction_id,
      transaction_datetime: l.transaction_datetime,
      payment_from: l.payment_from,
      accounts_status: l.accounts_status,
      created_at: l.created_at,
      verified_at: l.verified_at,
      screenshot_url: l.payment_screenshot_url,
      agent_name: historyOperatorNames.get(String(l.operator_id))?.name || l.fro_assignments?.workers?.name || 'Unknown',
      agent_login: historyOperatorNames.get(String(l.operator_id))?.login || l.fro_assignments?.workers?.login_id || '',
      type: l.action === 'donation' ? 'Donation' : 'Lead',
      receipt_no: receiptMap[l.id]?.receipt_no || null,
    }));

    // Include direct-linked receipts that are NOT tied to any log
    const logIdSet = new Set(logIds);
    const orphanReceipts = uniqueReceipts
      .filter(r => !r.log_id || !logIdSet.has(r.log_id))
      .map(r => ({
        log_id: null,
        receipt_id: r.id,
        amount: r.amount,
        payment_mode: r.mode,
        payment_from: r.bank_name,
        accounts_status: 'imported',
        created_at: r.receipt_date || r.created_at,
        verified_at: null,
        agent_name: 'System Import',
        agent_login: '',
        type: 'Imported Receipt',
        receipt_no: r.receipt_no,
        donor_name: r.donor_name,
        donor_mobile: r.donor_mobile,
      }));

    result.push(...orphanReceipts);
    result.sort((a, b) => {
      const da = a.created_at ? new Date(a.created_at).getTime() : 0;
      const db = b.created_at ? new Date(b.created_at).getTime() : 0;
      return db - da;
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDayEndReport = async (req, res) => {
  try {
    const { date, month } = req.query;
    let dateFrom, dateTo;
    if (month) {
      const [y, m] = month.split('-');
      dateFrom = `${y}-${m}-01`;
      const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
      dateTo = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    } else {
      const reportDate = date || new Date().toISOString().split('T')[0];
      dateFrom = reportDate + 'T00:00:00Z';
      dateTo = reportDate + 'T23:59:59Z';
    }

    const { data: froLogs, error: fErr } = await db
      .from('fro_donor_logs')
      .select(`
        amount_collected, accounts_status, verified_at, created_at, fro_worker_id,
        fro_assignments!inner(fro_worker_id),
        workers!fro_donor_logs_fro_worker_id_fkey(id, name, login_id)
      `)
      .gte('created_at', dateFrom)
      .lte('created_at', dateTo);
    if (fErr) throw fErr;

    const froMap = {};
    let totalCollected = 0;
    let totalSubmitted = 0;
    for (const log of froLogs || []) {
      const wid = log.fro_worker_id;
      const wName = log.workers?.name || 'Unknown';
      const wLogin = log.workers?.login_id || '';
      const amount = Number(log.amount_collected || 0);
      totalSubmitted += amount;
      if (log.accounts_status === 'verified') totalCollected += amount;
      if (!froMap[wid]) froMap[wid] = { id: wid, name: wName, login: wLogin, submitted: 0, collected: 0 };
      froMap[wid].submitted += amount;
      if (log.accounts_status === 'verified') froMap[wid].collected += amount;
    }

    const { data: suspenseEntries, error: sErr } = await db
      .from('bank_audit_entries')
      .select('id, amount, payment_id, bank_audit_sources(name)')
      .eq('status', 'unverified');
    if (sErr) throw sErr;

    const suspenseAmount = (suspenseEntries || []).reduce((s, e) => s + Number(e.amount || 0), 0);

    // Source-wise breakdown from bank audit entries
    const { data: allBankEntries, error: bErr } = await db
      .from('bank_audit_entries')
      .select('amount, bank_audit_sources(name)');
    if (bErr) throw bErr;

    const sourceMap = {};
    for (const e of allBankEntries || []) {
      const name = e.bank_audit_sources?.name || 'Unknown';
      sourceMap[name] = (sourceMap[name] || 0) + Number(e.amount || 0);
    }
    const sourceBreakdown = Object.entries(sourceMap).map(([name, amount]) => ({ name, amount }));

    return res.json({
      date: month || (date || new Date().toISOString().split('T')[0]),
      isMonth: !!month,
      froWorkers: Object.values(froMap),
      totalSubmitted,
      totalCollected,
      suspenseCount: (suspenseEntries || []).length,
      suspenseAmount,
      suspenseEntries: suspenseEntries || [],
      sourceBreakdown,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

function normalizeReceiptDate(val) {
  if (!val || val === 'NA' || val === 'na' || val === '-') return null;
  const s = String(val).trim();
  if (/^\d+$/.test(s) && s.length <= 5) {
    const d = new Date(1899, 11, 30 + parseInt(s, 10));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return null;
}

function normalizeReceiptTime(val) {
  if (!val && val !== 0) return null;
  if (typeof val === 'number') {
    const frac = val - Math.floor(val);
    if (frac > 0) {
      const totalMin = Math.round(frac * 24 * 60) % (24 * 60);
      return String(Math.floor(totalMin / 60)).padStart(2, '0') + ':' + String(totalMin % 60).padStart(2, '0');
    }
    return null;
  }
  const s = String(val).trim();
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

export const getImportNgoOptions = async (req, res) => {
  try {
    const { data, error } = await db
      .from('ngos')
      .select('id, name')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    return res.json((data || []).map(n => ({ id: n.id, name: n.name })));
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const importReceipts = async (req, res) => {
  try {
    const { receipts, ngo_id } = req.body;
    const cleanVal = (v) => {
      const s = String(v || '').trim();
      if (!s) return null;
      // Null out placeholder junk: NA, N/A, N.A., nil, null, none, -, NA, NA, ...
      const token = String.raw`(?:n\.?\s*a\.?|n/a|null|none|nil|not\s*available|-+)`;
      if (new RegExp(`^${token}(?:\\s*,\\s*${token})*$`, 'i').test(s)) return null;
      return s;
    };
    if (!receipts || !Array.isArray(receipts) || receipts.length === 0) {
      return res.status(400).json({ message: 'No receipts data provided' });
    }
    if (!ngo_id) {
      return res.status(400).json({ message: 'Please select the NGO this receipt batch belongs to' });
    }
    const { data: ngoRow, error: ngoErr } = await db
      .from('ngos')
      .select('id, name, is_active')
      .eq('id', ngo_id)
      .single();
    if (ngoErr || !ngoRow || !ngoRow.is_active) {
      return res.status(400).json({ message: 'Selected NGO is invalid or inactive' });
    }
    const batchProjectId = ngoRow.name.toLowerCase();

    const parsed = receipts.map(r => {
      const row = {};
      Object.keys(r).forEach(k => { row[k.trim()] = r[k]; });
      const donorName = row.donor_name || row['Receipt Name'] || row['Donor Name'] || '';
      const projectRaw = (row.project_id || row['Project'] || row['Project Supported'] || 'bsct').trim();
      const projectId = projectRaw.toLowerCase().includes('anna') ? 'bsct' : projectRaw.toLowerCase();
      const rawAmount = String(row.amount || row['Amount'] || row['Amt'] || '0')
        .replace(/,/g, '')
        .trim();
      return {
        original: r,
        parsed: {
          receipt_no: cleanVal(row.receipt_no || row['Receipt No'] || row['Receipt No.']),
          project_id: projectId,
          donor_name: donorName,
          donor_mobile: cleanVal(row.donor_mobile || row['Donor Mobile'] || row['Mobile No.']),
          amount: parseFloat(rawAmount) || 0,
          pan_number: cleanVal(row.pan_number || row['PAN No.'] || row['PAN No'] || row['Pan No']),
          address: cleanVal(row.address || row['Address 1'] || row['Address-1']),
          mode: cleanVal(row.mode || row['Mode of Payment (MOP)'] || row['MOP']),
          purpose: cleanVal(row.purpose || row['Purpose']) || 'General Donation',
          receipt_date: normalizeReceiptDate(row.receipt_date || row['Receipt Date'] || row['Transaction Date'] || row.transaction_date),
          receipt_time: normalizeReceiptTime(row.receipt_time || row['Receipt Time'] || row['Time'] || row.time),
          generated_by: row.generated_by || req.user.id,
          email: cleanVal(row.email || row['Mail Id'] || row['Email ID']),
          payment_id: cleanVal(row.payment_id || row['Payment Id No.']),
          bank_name: cleanVal(row.bank_name || row['Received Bank'] || row['Donors Bank Name']),
          agent_name: cleanVal(row.agent_name || row['FSE Name'] || row['Fse Name'] || row['Agent Name']) || 'Suspense',
          caller_name: cleanVal(row.caller_name || row['Caller Name']),
          mobile_2: cleanVal(row.mobile_2 || row['Mobil No. 2 / Tel'] || row['Mobil No. 2 / Tel ']),
          address_2: cleanVal(row.address_2 || row['Address-2'] || row['Address 2']),
          station: cleanVal(row.station || row['Station']),
          account_of: cleanVal(row.account_of || row['Account of']) || 'Corpus',
          sent: true,
          sent_at: new Date().toISOString(),
        },
      };
    }).filter(({ parsed }) => {
      const isBlank = parsed.donor_name.toLowerCase().includes('blank');
      const hasAmount = parsed.amount > 0;
      return !isBlank && hasAmount;
    });

    if (parsed.length === 0) {
      return res.status(400).json({ message: 'No valid receipts found after filtering' });
    }

    for (const p of parsed) p.parsed.project_id = batchProjectId;

    // Duplicate check against DB (batched at 100). Scoped by NGO so each NGO's
    // own receipt-number series (1..n) never collides with another NGO's. Each
    // existing copy's pool-relevant fields are kept so re-uploads can decide
    // whether to skip the number or restore its receipt to the suspense pool.
    const incomingNos = [...new Set(parsed.map(p => p.parsed.receipt_no).filter(Boolean))];
    const existingReceiptIds = new Map();
    if (incomingNos.length > 0) {
      for (let i = 0; i < incomingNos.length; i += 100) {
        const batch = incomingNos.slice(i, i + 100);
        const { data: existing } = await db
          .from('receipts')
          .select('id, receipt_no, donor_id, log_id, agent_name, donor_mobile, receipt_date, receipt_time, amount, pan_number, address, mode, payment_id, bank_name, email, caller_name, mobile_2, address_2, station, account_of')
          .eq('project_id', batchProjectId)
          .in('receipt_no', batch);
        for (const r of (existing || [])) existingReceiptIds.set(r.receipt_no, r);
      }
    }

    // Existing copies referenced by a bank-audit entry are out of the suspense
    // pool even when otherwise unlinked.
    const existingIds = [...existingReceiptIds.values()].map(r => r.id);
    const bankAudited = new Set();
    if (existingIds.length > 0) {
      for (let i = 0; i < existingIds.length; i += 100) {
        const { rows } = await db._pool.query(
          `SELECT DISTINCT receipt_id FROM bank_audit_entries WHERE receipt_id = ANY($1)`,
          [existingIds.slice(i, i + 100)]
        );
        for (const b of (rows || [])) bankAudited.add(b.receipt_id);
      }
    }

    // A receipt number already on file is never re-inserted (UNIQUE). What
    // happens to the existing copy depends on the new file row and the copy's
    // current state — re-uploading is always non-destructive:
    //   • copy cleared (claimed / linked / bank-audited) → kept as-is, never
    //     rolled back and never double-credited;
    //   • copy still pure suspense + the file row is now identified (agent or
    //     mobile present) → the existing receipt is updated in place and
    //     auto-credited to the FRO / donor history;
    //   • copy claimed (log_id → pending lead) + the file row has an agent →
    //     the pending lead is auto-verified and leaves Lead Verification;
    //   • otherwise → the existing copy wins, nothing changes.
    const upgradeRows = [];
    const verifyRows = [];
    const upgradeSeen = new Set();
    const verifySeen = new Set();
    const seen = new Set();
    const uniqueParsed = parsed.filter(({ parsed }) => {
      if (!parsed.receipt_no) return true;
      const existing = existingReceiptIds.get(parsed.receipt_no);
      if (existing) {
        const fileIsSuspense = isBlankSuspenseValue(parsed.agent_name) && isBlankSuspenseValue(parsed.donor_mobile);
        if (!fileIsSuspense) {
            const key = `${existing.id}|${parsed.receipt_no}`;
            if (existing.log_id) {
              if (!verifySeen.has(key)) {
                verifySeen.add(key);
                verifyRows.push({ existing, parsed });
              }
            } else if (!upgradeSeen.has(key)) {
              upgradeSeen.add(key);
              upgradeRows.push({ existing, parsed });
            }
          }
        return false; // number already on file — never re-insert (UNIQUE)
      }
      if (seen.has(parsed.receipt_no)) return false;
      seen.add(parsed.receipt_no);
      return true;
    });
    const dupCount = parsed.length - uniqueParsed.length - upgradeRows.length - verifyRows.length;

    const uniqueRows = uniqueParsed.map(p => p.parsed);
    const originalRows = uniqueParsed.map(p => p.original);

// Normalize agent_name to canonical worker names so collection queries
    // match reliably (handles extra spaces, middle names, etc.)
    //
    // This also folds a CRM agent label ("Agent 2") down to the FRO's real name,
    // because worker_aliases maps the label to that worker. Receipts are keyed by
    // FRO, so an import naming an agent must land on their FRO.
    const rawAgentNames = [...new Set(uniqueRows.map(r => r.agent_name).filter(Boolean))];
    const agentNameMap = new Map();
    for (const raw of rawAgentNames) {
      const canonical = await normalizeAgentName(raw);
      if (canonical !== raw) agentNameMap.set(raw, canonical);
    }
    if (agentNameMap.size > 0) {
      for (const row of uniqueRows) {
        if (row.agent_name && agentNameMap.has(row.agent_name)) {
          row.agent_name = agentNameMap.get(row.agent_name);
        }
      }
    }

    // Durability safety net: persist the exact rows we intend to insert BEFORE
    // any DB write, so a crash mid-import can never lose the source data.
    const FAILED_DIR = path.resolve(__dirname, '../../uploads/failed_imports');
    let manifestPath = null;
    try {
      fs.mkdirSync(FAILED_DIR, { recursive: true });
      manifestPath = path.join(FAILED_DIR, `receipt_import_${Date.now()}.json`);
      fs.writeFileSync(manifestPath, JSON.stringify({ imported_at: new Date().toISOString(), rows: uniqueRows }, null, 2));
    } catch (e) {
      console.warn('Could not persist import manifest:', e.message);
    }

    // ─── Pre-compute donor matches by phone (outside the transaction so read-
    //     heavy queries never bloat the tx and hit RDS statement timeouts) ───
    const cleanMobile = (m) => String(m || '').replace(/\D/g, '');
    const last10 = (m) => cleanMobile(m).slice(-10);
    const mobiles = [...new Set(uniqueRows.map(r => last10(r.donor_mobile)).filter(m => /^\d{10}$/.test(m)))];
    const donorByMobile = new Map();
    if (mobiles.length > 0) {
      const exactFound = new Set();
      for (let i = 0; i < mobiles.length; i += 100) {
        const batch = mobiles.slice(i, i + 100);
        const { rows: exact } = await db._pool.query(
          `SELECT id, name, mobile_number, total_amount, donation_count, last_donation_date
           FROM donor_profiles WHERE mobile_number = ANY($1)`, [batch]
        );
        for (const d of (exact || [])) {
          const k = last10(d.mobile_number);
          if (k) { donorByMobile.set(k, d); exactFound.add(k); }
        }
      }
      const missing = mobiles.filter(m => !exactFound.has(m));
      if (missing.length > 0) {
        for (let i = 0; i < missing.length; i += 100) {
          const batch = missing.slice(i, i + 100);
          const { rows } = await db._pool.query(
            `SELECT id, name, mobile_number, total_amount, donation_count, last_donation_date
             FROM donor_profiles
             WHERE right(regexp_replace(mobile_number, '[^0-9]', '', 'g'), 10) = ANY($1)`, [batch]
          );
          for (const d of (rows || [])) {
            const k = last10(d.mobile_number);
            if (k && !donorByMobile.has(k)) donorByMobile.set(k, d);
          }
        }
      }
    }

    // ─── Insert + match + link — one atomic transaction, with retry ───
    const MAX_RETRIES = 3;
    const MAX_QUERY_CONCURRENCY = 6;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const mapLimit = async (items, limit, fn) => {
      const results = [];
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const idx = next++;
          results.push(await fn(items[idx], idx));
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
      return results;
    };

    const isConnExhausted = (err) => {
      const m = (err && err.message ? err.message : '').toLowerCase();
      return (err && err.code === '53300') || m.includes('remaining connection slots') || m.includes('rds_reserved') || m.includes('too many connections');
    };

    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 1) {
        console.log(`Import retry attempt ${attempt}/${MAX_RETRIES}`);
        await sleep((isConnExhausted(lastError) ? attempt * 4000 : attempt * 1000));
      }

      try {
        console.time('import-tx');
        let resultVerifyNotifications = [];
        const result = await db.transaction(async ({ from }) => {
          // Numbered rows are unique on receipt_no: the first occurrence in the
          // batch wins, and any number already in the DB (same project_id) is
          // skipped so the UNIQUE index is never violated. Unnumbered rows are
          // always inserted — uniqueness applies only to receipt numbers.
          const toInsert = [];
          const seenNumbers = new Set();
          for (const { parsed: row } of parsed) {
            if (row.receipt_no) {
              if (existingReceiptIds.has(row.receipt_no) || seenNumbers.has(row.receipt_no)) continue;
              seenNumbers.add(row.receipt_no);
            }
            toInsert.push(row);
          }

          let inserted = [];
          if (toInsert.length > 0) {
            const INSERT_BATCH = 500;
            const chunks = [];
            for (let i = 0; i < toInsert.length; i += INSERT_BATCH) chunks.push(toInsert.slice(i, i + INSERT_BATCH));
            const insertedChunks = await mapLimit(chunks, 2, async (chunk) => {
              const { data, error } = await from('receipts').insert(chunk).select();
              if (error) throw error;
              return data || [];
            });
            inserted = insertedChunks.flat();
          }

          // Re-uploading never rolls back. Suspense rows that are now identified
          // in the file (agent/mobile) get their existing receipt updated in
          // place; rows with a pending claim get that pending lead auto-verified
          // so it leaves Lead Verification. All inside the same transaction.
          let upgraded = 0;
          let creditedPending = 0;
          if (upgradeRows.length > 0) {
            for (const { existing, parsed: row } of upgradeRows) {
              const { error: upErr } = await from('receipts').update({
                donor_name: row.donor_name,
                donor_mobile: row.donor_mobile,
                amount: row.amount,
                pan_number: row.pan_number,
                address: row.address,
                mode: row.mode,
                purpose: row.purpose,
                receipt_date: row.receipt_date,
                receipt_time: row.receipt_time,
                generated_by: row.generated_by,
                email: row.email,
                payment_id: row.payment_id,
                bank_name: row.bank_name,
                agent_name: row.agent_name,
                caller_name: row.caller_name,
                mobile_2: row.mobile_2,
                address_2: row.address_2,
                station: row.station,
                account_of: row.account_of,
                sent: true,
                sent_at: new Date().toISOString(),
              }).eq('id', existing.id);
              if (upErr) throw new Error(upErr.message);
              upgraded++;
            }
          }

          if (verifyRows.length > 0) {
            const nowIso = new Date().toISOString();
            const verifyNotifications = [];
            for (const { existing, parsed: row } of verifyRows) {
              const { data: lead, error: leadErr } = await from('fro_donor_logs')
                .select('id, assignment_id, fro_worker_id, donor_id, amount_collected, accounts_status')
                .eq('id', existing.log_id)
                .maybeSingle();
              if (leadErr) throw new Error(leadErr.message);
              if (!lead || lead.accounts_status !== 'pending') continue;
              const effAmount = parseFloat(row.amount) || parseFloat(existing.amount) || parseFloat(lead.amount_collected) || 0;
              const { error: rErr } = await from('receipts').update({
                donor_name: row.donor_name || existing.donor_name || null,
                donor_mobile: row.donor_mobile || existing.donor_mobile || null,
                amount: effAmount,
                pan_number: row.pan_number || existing.pan_number,
                address: row.address || existing.address,
                mode: row.mode || existing.mode,
                purpose: row.purpose || existing.purpose,
                receipt_date: row.receipt_date || existing.receipt_date,
                receipt_time: row.receipt_time || existing.receipt_time,
                payment_id: row.payment_id || existing.payment_id,
                bank_name: row.bank_name || existing.bank_name,
                agent_name: row.agent_name || existing.agent_name,
                email: row.email || existing.email,
                caller_name: row.caller_name || existing.caller_name,
                mobile_2: row.mobile_2 || existing.mobile_2,
                address_2: row.address_2 || existing.address_2,
                station: row.station || existing.station,
                account_of: row.account_of || existing.account_of,
                sent: true,
                sent_at: nowIso,
              }).eq('id', existing.id);
              if (rErr) throw new Error(rErr.message);
              const { error: lErr } = await from('fro_donor_logs').update({
                accounts_status: 'verified',
                verified_at: nowIso,
                verified_by: req.user.id,
              }).eq('id', lead.id);
              if (lErr) throw new Error(lErr.message);
              if (lead.assignment_id) {
                const { error: aErr } = await from('fro_assignments').update({ status: 'donation_collected', last_contacted_at: nowIso }).eq('id', lead.assignment_id);
                if (aErr) throw new Error(aErr.message);
              }
              if (lead.donor_id) {
                const { data: donor, error: dErr } = await from('donor_profiles')
                  .select('total_amount, donation_count')
                  .eq('id', lead.donor_id)
                  .maybeSingle();
                if (dErr) throw new Error(dErr.message);
                if (donor) {
                  const { error: upErr } = await from('donor_profiles').update({
                    total_amount: Math.round(((donor.total_amount || 0) + effAmount) * 100) / 100,
                    donation_count: (donor.donation_count || 0) + 1,
                    updated_at: nowIso,
                  }).eq('id', lead.donor_id);
                  if (upErr) throw new Error(upErr.message);
                }
              }
              const { error: bErr } = await from('bank_audit_entries').update({
                donor_id: lead.donor_id || null,
                status: 'verified',
                matched_at: nowIso,
                updated_at: nowIso,
              }).eq('receipt_id', existing.id);
              if (bErr) throw new Error(bErr.message);
              if (lead.fro_worker_id) {
                const donorName = row.donor_name || existing.donor_name || 'a donor';
                verifyNotifications.push({
                  worker_id: lead.fro_worker_id,
                  type: 'lead_verified',
                  title: 'Lead Verified',
                  body: `Your claim for ${donorName} (\u20B9${Number(effAmount).toLocaleString('en-IN')}) was verified from the re-uploaded receipts.`,
                  fro_donor_log_id: String(lead.id),
                  sent_at: nowIso,
                });
              }
              creditedPending++;
            }
            // Best-effort verified-lead notifications are sent AFTER the
            // transaction commits so a notification failure can never abort the
            // import (and never leave the tx in the aborted 25P02 state).
            resultVerifyNotifications = verifyNotifications;
          }

          let matched = 0;
          let withBank = 0;
          let receiptsByDonor = {};
          const matchedIds = new Set();
          const processRows = [
            ...inserted,
            ...upgradeRows.map(({ existing, parsed: row }) => ({ id: existing.id, ...row })),
          ];
          if (processRows.length > 0) {
            receiptsByDonor = {};
            const matchPool = processRows.filter(r => !r.donor_id);
            for (const receipt of matchPool) {
              const m = last10(receipt.donor_mobile);
              if (!/^\d{10}$/.test(m)) continue;
              const donor = donorByMobile.get(m);
              if (!donor) continue;
              matched++;
              matchedIds.add(receipt.id);
              if (!receiptsByDonor[donor.id]) {
                receiptsByDonor[donor.id] = { ids: [], total_amount: donor.total_amount || 0, donation_count: donor.donation_count || 0, last_donation_date: donor.last_donation_date };
              }
              receiptsByDonor[donor.id].ids.push(receipt.id);
              receiptsByDonor[donor.id].total_amount += parseFloat(receipt.amount || 0);
              receiptsByDonor[donor.id].donation_count += 1;
              if (receipt.receipt_date && (!receiptsByDonor[donor.id].last_donation_date || receipt.receipt_date > receiptsByDonor[donor.id].last_donation_date)) {
                receiptsByDonor[donor.id].last_donation_date = receipt.receipt_date;
              }
            }

            // Auto-create donor profiles for unmatched valid mobiles so receipts
            // clear out of the suspense pool instead of sitting orphaned.
            {
              const toCreateMap = new Map();
              for (const r of matchPool) {
                if (matchedIds.has(r.id)) continue;
                const m = last10(r.donor_mobile);
                if (!/^\d{10}$/.test(m)) continue;
                if (!toCreateMap.has(m)) toCreateMap.set(m, r.donor_name || 'Unknown Donor');
              }
              if (toCreateMap.size > 0) {
                const rows = [...toCreateMap].map(([mobile, name]) => ({
                  name, mobile_number: mobile,
                  total_amount: 0, donation_count: 0,
                  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                }));
                for (let i = 0; i < rows.length; i += 500) {
                  const chunk = rows.slice(i, i + 500);
                  const { data: created, error } = await from('donor_profiles')
                    .upsert(chunk, { onConflict: 'mobile_number', ignoreDuplicates: true })
                    .select('id, mobile_number, total_amount, donation_count, last_donation_date');
                  if (error) throw new Error(error.message);
                  for (const d of (created || [])) {
                    const k = last10(d.mobile_number);
                    if (k) donorByMobile.set(k, d);
                  }
                  const chunkMobiles = [...new Set(chunk.map(c => c.mobile_number))];
                  for (let j = 0; j < chunkMobiles.length; j += 100) {
                    const { rows: existing } = await db._pool.query(
                      `SELECT id, mobile_number, total_amount, donation_count, last_donation_date
                       FROM donor_profiles WHERE mobile_number = ANY($1)`, [chunkMobiles.slice(j, j + 100)]
                    );
                    for (const d of (existing || [])) {
                      const k = last10(d.mobile_number);
                      if (k) donorByMobile.set(k, d);
                    }
                  }
                }
                for (const receipt of matchPool) {
                  if (matchedIds.has(receipt.id)) continue;
                  const m = last10(receipt.donor_mobile);
                  if (!/^\d{10}$/.test(m)) continue;
                  const donor = donorByMobile.get(m);
                  if (!donor) continue;
                  matched++;
                  matchedIds.add(receipt.id);
                  if (!receiptsByDonor[donor.id]) {
                    receiptsByDonor[donor.id] = { ids: [], total_amount: donor.total_amount || 0, donation_count: donor.donation_count || 0, last_donation_date: donor.last_donation_date };
                  }
                  receiptsByDonor[donor.id].ids.push(receipt.id);
                  receiptsByDonor[donor.id].total_amount += parseFloat(receipt.amount || 0);
                  receiptsByDonor[donor.id].donation_count += 1;
                  if (receipt.receipt_date && (!receiptsByDonor[donor.id].last_donation_date || receipt.receipt_date > receiptsByDonor[donor.id].last_donation_date)) {
                    receiptsByDonor[donor.id].last_donation_date = receipt.receipt_date;
                  }
                }
              }
            }

            withBank = processRows.filter(r => r.bank_name && r.bank_name !== 'NA').length;
          }

          // Link receipts to donors and roll up donor totals. A failed
          // link/donor update aborts the whole import (rollback), so it never
          // silently leaves an unlinked receipt behind.
          if (Object.keys(receiptsByDonor).length > 0) {
            const updates = [];
            for (const [donorId, info] of Object.entries(receiptsByDonor)) {
              for (let i = 0; i < info.ids.length; i += 50) {
                updates.push(from('receipts').update({ donor_id: parseInt(donorId) }).in('id', info.ids.slice(i, i + 50)));
              }
              updates.push(from('donor_profiles').update({
                total_amount: Math.round(info.total_amount * 100) / 100,
                donation_count: info.donation_count,
                last_donation_date: info.last_donation_date,
                updated_at: new Date().toISOString(),
              }).eq('id', donorId));
            }
            await mapLimit(updates, MAX_QUERY_CONCURRENCY, async (q) => {
              const { error } = await q;
              if (error) throw new Error(error.message);
            });
          }

          // ── Credit each imported receipt to the FRO named on it (agent/FSE) ──
          // The FRO is resolved by fuzzy name match; the donor is matched by
          // mobile (or created in that FRO's donor list when the number is new);
          // the amount is credited to that FRO and the donation is written to
          // the donor's history (fro_donor_log). No month gate — backfilled
          // receipts still get their history entry (their date keeps them out of
          // the current month's collected). Truly-suspense receipts (agent AND
          // mobile both missing) are skipped here and stay in the suspense pool.
          // Newly inserted rows and re-uploaded suspense→identified upgrades both
          // flow through here, so the credit + donor history is written once.
          const nowIso = new Date().toISOString();
          const donorIdByReceiptId = new Map();
          for (const [donorId, info] of Object.entries(receiptsByDonor)) {
            for (const id of info.ids) donorIdByReceiptId.set(id, parseInt(donorId, 10));
          }

          const creditPool = processRows.filter(
            r => !isBlankSuspenseValue(r.agent_name) && parseFloat(r.amount || 0) > 0
          );

          let leadsCollected = 0;
          const credits = new Map();
          if (creditPool.length > 0) {
            // Workers for this NGO (via worker_ngo_allocations), falling back to
            // all active workers when no allocation rows exist, plus their
            // station mapping so created assignments land on the right station.
            const { data: allocatedRows, error: allocErr } = await from('worker_ngo_allocations')
              .select('worker_id')
              .eq('ngo_id', ngo_id);
            if (allocErr) throw new Error(allocErr.message);
            let workerRows = [];
            if ((allocatedRows || []).length > 0) {
              const workerIds = [...new Set(allocatedRows.map(a => a.worker_id))];
              for (let i = 0; i < workerIds.length; i += 500) {
                const { data: wr, error: werr } = await from('workers')
                  .select('id, name, is_active')
                  .in('id', workerIds.slice(i, i + 500));
                if (werr) throw new Error(werr.message);
                workerRows.push(...(wr || []));
              }
            } else {
              const { data: wr, error: werr } = await from('workers')
                .select('id, name, is_active');
              if (werr) throw new Error(werr.message);
              workerRows = wr || [];
            }
            const activeWorkers = workerRows.filter(w => w.is_active !== false);

            // Printed-name variants (extra/missing middle names, spacing) that
            // fuzzy matching cannot settle are curated in worker_aliases and
            // loaded once per import.
            const aliasByNorm = new Map();
            const aliasWorkerIds = [...new Set(activeWorkers.map(w => w.id))];
            for (let i = 0; i < aliasWorkerIds.length; i += 500) {
              const { data: al, error: alerr } = await from('worker_aliases')
                .select('alias_name, worker_id')
                .in('worker_id', aliasWorkerIds.slice(i, i + 500));
              if (alerr) throw new Error(alerr.message);
              for (const a of (al || [])) {
                const key = String(a.alias_name || '').trim().toLowerCase();
                if (key && !aliasByNorm.has(key)) aliasByNorm.set(key, a.worker_id);
              }
            }

            const { data: stationRows, error: stErr } = await from('fro_station_assignments')
              .select('fro_worker_id, station')
              .eq('ngo_id', ngo_id);
            if (stErr) throw new Error(stErr.message);
            const stationByWorker = {};
            for (const s of (stationRows || [])) {
              if (s.fro_worker_id && s.station && !stationByWorker[s.fro_worker_id]) {
                stationByWorker[s.fro_worker_id] = s.station;
              }
            }

            // FRO-name match, most-specific tier first. Every tier after the
            // alias lookup must resolve UNIQUELY — the old first-match-wins
            // fuzzy credited same-first-name colleagues (two Ravinas, five
            // Poojas), so anything ambiguous stays uncredited instead.
            // Tiers: raw exact → normalized exact → curated alias →
            // "(annotation)" stripped repeat → token-subset unique → fuzzy unique.
            const normName = (v) => String(v || '')
              .toLowerCase()
              .replace(/\s*\(.*?\)\s*/g, ' ')
              .replace(/[^a-z0-9\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            const normWorkerNames = activeWorkers.map(w => ({ id: w.id, nn: normName(w.name), toks: normName(w.name).split(' ').filter(Boolean) }));
            const resolveWorker = (rawAgentName) => {
              if (!rawAgentName) return null;
              const anRaw = String(rawAgentName).trim().toLowerCase();
              const byId = (id) => activeWorkers.find(w => w.id === id) || null;
              const attempt = (agentName) => {
                const anNorm = normName(agentName);
                if (!anNorm) return null;
                const rawExact = activeWorkers.find(w => String(w.name || '').trim().toLowerCase() === anRaw);
                if (rawExact) return rawExact.id;
                const normExact = normWorkerNames.find(w => w.nn === anNorm);
                if (normExact) return normExact.id;
                const aliasId = aliasByNorm.get(anNorm);
                if (aliasId && activeWorkers.some(w => w.id === aliasId)) return aliasId;
                const toks = anNorm.split(' ').filter(Boolean);
                let hit = null;
                if (toks.length >= 2) {
                  let subsetHits = 0;
                  for (const w of normWorkerNames) {
                    if (toks.every(t => w.toks.includes(t))) { subsetHits++; hit = w.id; }
                  }
                  if (subsetHits === 1) return hit;
                  if (subsetHits > 1) return null;
                }
                let fuzzyHits = 0;
                hit = null;
                for (const w of activeWorkers) {
                  if (!nameMatch(agentName, w.name)) continue;
                  fuzzyHits++;
                  if (fuzzyHits > 1) return null;
                  hit = w.id;
                }
                return fuzzyHits === 1 ? hit : null;
              };
              return byId(attempt(rawAgentName)) || byId(attempt(String(rawAgentName).replace(/\s*\(.*?\)\s*/g, ' ')));
            };

            // Pre-load the donors' existing assignments for this NGO so money can
            // close them (and credit their owner) instead of duplicating.
            // Reassigned rows are included too: fro_assignments is UNIQUE on
            // (donor_id, ngo_id), so reusing the existing row beats a duplicate.
            const poolDonorIds = [...new Set(creditPool.map(r => donorIdByReceiptId.get(r.id)).filter(Boolean))];
            const assignmentsByDonor = new Map();
            if (poolDonorIds.length > 0) {
              for (let i = 0; i < poolDonorIds.length; i += 1000) {
                const { data: aData, error: aErr } = await from('fro_assignments')
                  .select('id, donor_id, fro_worker_id, ngo_id, status, assigned_at')
                  .in('donor_id', poolDonorIds.slice(i, i + 1000))
                  .eq('ngo_id', ngo_id);
                if (aErr) throw new Error(aErr.message);
                for (const a of (aData || [])) {
                  const cur = assignmentsByDonor.get(a.donor_id);
                  const isReassigned = a.status === 'reassigned';
                  if (!cur) { assignmentsByDonor.set(a.donor_id, a); continue; }
                  const curReassigned = cur.status === 'reassigned';
                  if (!isReassigned && curReassigned) { assignmentsByDonor.set(a.donor_id, a); continue; }
                  if (isReassigned === curReassigned && new Date(a.assigned_at || 0) > new Date(cur.assigned_at || 0)) {
                    assignmentsByDonor.set(a.donor_id, a);
                  }
                }
              }
            }

            const logs = [];
            const closeAssignmentIds = new Set();
            const newDonorTotals = new Map();

            for (const r of creditPool) {
              const worker = resolveWorker(r.agent_name);
              if (!worker) continue; // unknown FRO → keep receipt, skip credit until resolved

              let donorId = donorIdByReceiptId.get(r.id) || null;
              if (!donorId) {
                // Agent present but no donor yet (mobile missing / number not in
                // the DB) → create the donor under this FRO's donor list. Only
                // when the row carries a usable mobile number: donor_profiles.
                // mobile_number is NOT NULL, so a blank number can't be stored
                // and there is nothing to credit against — skip instead of
                // aborting the whole import.
                const mobile = cleanMobile(r.donor_mobile);
                if (!mobile) continue;
                const { data: created, error: cErr } = await from('donor_profiles')
                  .upsert({
                    name: r.donor_name || 'Unknown Donor',
                    mobile_number: mobile,
                    project_supported: r.project_id,
                    total_amount: 0,
                    donation_count: 0,
                    created_at: nowIso,
                    updated_at: nowIso,
                  }, { onConflict: 'mobile_number', ignoreDuplicates: true })
                  .select('id, mobile_number, total_amount, donation_count, last_donation_date');
                if (cErr) throw new Error(cErr.message);
                let donorRow = (created || [])[0] || null;
                if (!donorRow) {
                  const { rows: existing } = await db._pool.query(
                    `SELECT id, mobile_number, total_amount, donation_count, last_donation_date
                     FROM donor_profiles WHERE mobile_number = $1`, [mobile]
                  );
                  donorRow = (existing || [])[0] || null;
                }
                if (!donorRow) continue; // still no donor → keep the receipt uncredited
                donorId = donorRow.id;
                matched++;
                const m10 = last10(donorRow.mobile_number);
                if (/^\d{10}$/.test(m10) && !donorByMobile.has(m10)) donorByMobile.set(m10, donorRow);
                donorIdByReceiptId.set(r.id, donorId);
                const { error: linkErr } = await from('receipts').update({ donor_id: donorId }).eq('id', r.id);
                if (linkErr) throw new Error(linkErr.message);
                newDonorTotals.set(donorId, { amount: 0, count: 0, last: null });
              }

              // Reuse the donor's existing assignment for this NGO (its owner
              // keeps the credit — never steal) or open one under this FRO.
              let assignment = assignmentsByDonor.get(donorId) || null;
              if (!assignment) {
                const { data: created, error: asErr } = await from('fro_assignments')
                  .insert({
                    donor_id: donorId,
                    fro_worker_id: worker.id,
                    ngo_id,
                    station: stationByWorker[worker.id] || null,
                    status: 'donation_collected',
                    assigned_at: nowIso,
                  })
                  .select('id, fro_worker_id, status')
                  .single();
                if (asErr) throw new Error(asErr.message);
                assignment = created;
                assignmentsByDonor.set(donorId, assignment);
              }

              // Credit the FRO actually named on the receipt. Reusing an existing
              // assignment only settles (and closes) the donor relationship — it
              // must not move the money to whoever owns the assignment today,
              // otherwise receipts collected by one FRO land in another FRO's
              // collection list after a batch/reassignment (e.g. Deepali's
              // receipts showing in Mahima's BSCT tab).
              const froWorkerId = worker.id !== assignment.fro_worker_id
                ? worker.id
                : assignment.fro_worker_id;
              if (!froWorkerId) continue;

              const amount = parseFloat(r.amount || 0);
              const t = newDonorTotals.get(donorId);
              if (t) {
                t.amount += amount;
                t.count += 1;
                if (r.receipt_date && (!t.last || r.receipt_date > t.last)) t.last = r.receipt_date;
              }

              logs.push({
                assignment_id: assignment.id,
                donor_id: donorId,
                fro_worker_id: froWorkerId,
                action: 'donation',
                amount_collected: amount,
                accounts_status: 'verified',
                verified_at: nowIso,
                verified_by: req.user.id,
                created_by: req.user.id,
                upi_transaction_id: r.payment_id || null,
                transaction_datetime: r.receipt_date || null,
                pan_number: r.pan_number || null,
                notes: `Auto-credited from imported receipt ${r.receipt_no || r.id}`,
              });
              closeAssignmentIds.add(assignment.id);
              const cred = credits.get(froWorkerId) || { count: 0, total: 0 };
              cred.count += 1;
              cred.total += amount;
              credits.set(froWorkerId, cred);
            }

            // Donors created in this phase get their first donation rolled up.
            if (newDonorTotals.size > 0) {
              for (const [donorId, t] of newDonorTotals) {
                const { error: dtErr } = await from('donor_profiles').update({
                  total_amount: Math.round(t.amount * 100) / 100,
                  donation_count: t.count,
                  first_donation_date: t.last,
                  last_donation_date: t.last,
                  updated_at: nowIso,
                }).eq('id', donorId);
                if (dtErr) throw new Error(dtErr.message);
              }
            }

            if (logs.length > 0) {
              const LOG_BATCH = 500;
              const logChunks = [];
              for (let i = 0; i < logs.length; i += LOG_BATCH) logChunks.push(logs.slice(i, i + LOG_BATCH));
              await mapLimit(logChunks, 2, async (chunk) => {
                const { error } = await from('fro_donor_logs').insert(chunk);
                if (error) throw new Error(error.message);
              });
              leadsCollected = logs.length;

              // Change the donor's status: close the assignments the money
              // settled (leave already-closed rows untouched).
              if (closeAssignmentIds.size > 0) {
                const { error: closeErr } = await from('fro_assignments')
                  .update({ status: 'donation_collected', last_contacted_at: nowIso })
                  .in('id', [...closeAssignmentIds])
                  .neq('status', 'donation_collected');
                if (closeErr) throw new Error(closeErr.message);
              }
            }
          }

          return { imported: inserted.length, upgraded, creditedPending, matched, withBank, leadsCollected, credits };
        });
        console.timeEnd('import-tx');
        console.log(`Import OK: ${result.imported} rows, ${result.upgraded} re-upload credits, ${result.creditedPending} pending claims auto-credited, ${result.leadsCollected} leads credited`);

        // Notify FROs whose pending claims were auto-verified from a re-upload —
        // best effort, after the commit (a notification failure must never abort
        // the import transaction).
        for (const notif of resultVerifyNotifications) {
          try {
            let fcmLogged = false;
            try {
              const pushResult = await sendPushNotification(notif.worker_id, notif.title, notif.body, 'lead_verified', null);
              fcmLogged = !!pushResult;
            } catch (err) { console.error('FCM send error:', err.message); }
            if (!fcmLogged) {
              await db.from('notification_log').insert({
                worker_id: notif.worker_id,
                type: notif.type,
                title: notif.title,
                body: notif.body,
                fro_donor_log_id: notif.fro_donor_log_id,
                sent_at: notif.sent_at,
              });
            }
          } catch (err) { console.error('Failed to create verified-lead notification:', err.message); }
        }

        // Notify FROs (aggregated per worker) — best effort, after the commit.
        for (const [workerId, cred] of result.credits) {
          try {
            const notifTitle = 'Lead Collected';
            const notifBody = `Your lead${cred.count > 1 ? 's' : ''} ${cred.count > 1 ? 'were' : 'was'} collected: \u20B9${cred.total.toLocaleString('en-IN')} across ${cred.count} receipt${cred.count > 1 ? 's' : ''}.`;
            let fcmLogged = false;
            try {
              const pushResult = await sendPushNotification(workerId, notifTitle, notifBody, 'lead_verified', null);
              fcmLogged = !!pushResult;
            } catch (err) { console.error('FCM send error:', err.message); }
            if (!fcmLogged) {
              await db.from('notification_log').insert({
                worker_id: workerId,
                type: 'lead_verified',
                title: notifTitle,
                body: notifBody,
                sent_at: new Date().toISOString(),
              });
            }
          } catch (err) { console.error('Failed to create collected notification:', err.message); }
        }

        // All-or-nothing committed — the safety manifest is no longer needed.
        try { if (manifestPath) fs.unlinkSync(manifestPath); } catch (_) { /* best effort */ }

        return res.status(201).json({
          message: `${result.imported} receipts imported${result.upgraded > 0 ? `, ${result.upgraded} suspense receipts credited from re-upload` : ''}${result.creditedPending > 0 ? `, ${result.creditedPending} pending claims auto-credited` : ''}${dupCount > 0 ? `, ${dupCount} duplicates skipped` : ''}${result.matched > 0 ? `, ${result.matched} linked to donors` : ''}${result.leadsCollected > 0 ? `, ${result.leadsCollected} leads credited to FROs` : ''}`,
          imported: result.imported,
          upgraded: result.upgraded,
          creditedPending: result.creditedPending,
          withBank: result.withBank,
          matchedDonors: result.matched,
          leads_collected: result.leadsCollected,
        });

      } catch (err) {
        lastError = err;
        console.warn(`Import attempt ${attempt} failed:`, err.message);
        if (attempt === MAX_RETRIES) {
          const hint = isConnExhausted(err) ? ' The database connection limit is reached; wait a moment and try again.' : '';
          return res.status(500).json({ message: `Import failed after ${MAX_RETRIES} attempts: ${err.message}${hint}${manifestPath ? ` Your data is safe and saved at: ${manifestPath}` : ''}` });
        }
      }
    }

    return res.status(500).json({ message: 'Import failed: unknown error' });

  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const reverseDonorTotals = async () => {
  try {
    const { data: linked } = await db
      .from('receipts')
      .select('donor_id, amount')
      .not('donor_id', 'is', null);
    const safeLinked = linked || [];
    if (safeLinked.length === 0) return 0;

    const deductions = {};
    const donorIds = [];
    for (const r of safeLinked) {
      if (!deductions[r.donor_id]) {
        deductions[r.donor_id] = { amount: 0, count: 0 };
        donorIds.push(r.donor_id);
      }
      deductions[r.donor_id].amount += parseFloat(r.amount || 0);
      deductions[r.donor_id].count += 1;
    }

    const donorMap = {};
    const BATCH = 100;
    for (let i = 0; i < donorIds.length; i += BATCH) {
      const batch = donorIds.slice(i, i + BATCH);
      const { data: donors } = await db
        .from('donor_profiles')
        .select('id, total_amount, donation_count')
        .in('id', batch);
      for (const d of (donors || [])) donorMap[d.id] = d;
    }

    await Promise.all(
      Object.entries(deductions).map(([donorId, dec]) => {
        const donor = donorMap[donorId];
        if (!donor) return Promise.resolve();
        return db.from('donor_profiles').update({
          total_amount: Math.max(0, (donor.total_amount || 0) - dec.amount),
          donation_count: Math.max(0, (donor.donation_count || 0) - dec.count),
          first_donation_date: null,
          last_donation_date: null,
          updated_at: new Date().toISOString(),
        }).eq('id', donorId);
      })
    );

    try {
      for (let i = 0; i < donorIds.length; i += 500) {
        const chunk = donorIds.slice(i, i + 500);
        await db
          .from('fro_assignments')
          .update({ status: 'pending' })
          .in('donor_id', chunk)
          .eq('status', 'donation_collected');
      }
    } catch (assignErr) {
      console.warn('Assignment reset skipped:', assignErr.message);
    }
    return donorIds.length;
  } catch (err) {
    console.warn('Donor reversal skipped (column may not exist):', err.message);
    return 0;
  }
};

const deleteLinkedLogs = async (logIds) => {
  if (!logIds || logIds.length === 0) return 0;
  const BATCH = 500;
  let deleted = 0;
  for (let i = 0; i < logIds.length; i += BATCH) {
    const chunk = logIds.slice(i, i + BATCH);
    try {
      await db.from('notification_log').delete().in('fro_donor_log_id', chunk);
    } catch (e) {
      console.warn('notification_log cleanup skipped:', e.message);
    }
    try {
      await db.from('rejected_lead_tickets').delete().in('fro_donor_log_id', chunk);
    } catch (e) {
      console.warn('rejected_lead_tickets cleanup skipped:', e.message);
    }
    try {
      const { data } = await db.from('fro_donor_logs').delete().in('id', chunk).select('id');
      deleted += data?.length || 0;
    } catch (e) {
      console.warn('fro_donor_logs deletion skipped:', e.message);
    }
  }
  return deleted;
};

const cleanupImportAutoCredits = async () => {
  // Import auto-credit logs are never linked via receipts.log_id — they only
  // carry the assignment_id plus this notes marker. Deleting the receipts
  // alone leaves them (and their closed assignments) behind, which would both
  // keep old wrong FRO credits and block a re-upload from crediting again.
  let cleaned = 0;
  while (true) {
    const { data: logs } = await db
      .from('fro_donor_logs')
      .select('id, assignment_id')
      .ilike('notes', 'Auto-credited from imported receipt%')
      .limit(1000);
    const rows = logs || [];
    if (rows.length === 0) break;
    const ids = rows.map(r => r.id);
    const assignmentIds = [...new Set(rows.map(r => r.assignment_id).filter(Boolean))];
    try { await db.from('notification_log').delete().in('fro_donor_log_id', ids); } catch (e) { console.warn('notification_log cleanup skipped:', e.message); }
    const { data: deleted } = await db.from('fro_donor_logs').delete().in('id', ids).select('id');
    cleaned += deleted?.length || 0;
    if (assignmentIds.length > 0) {
      const { error } = await db.from('fro_assignments')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .in('id', assignmentIds)
        .eq('status', 'donation_collected');
      if (error) console.warn('assignment reopen skipped:', error.message);
    }
  }
  return cleaned;
};

const recomputeDonorTotals = async (donorIds) => {
  if (!donorIds || donorIds.length === 0) return 0;
  const { rows } = await db._pool.query(`
    SELECT donor_id::text AS donor_id,
           COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount,
           count(*)::int AS donation_count,
           min(receipt_date)::date AS first_donation_date,
           max(receipt_date)::date AS last_donation_date
    FROM receipts
    WHERE donor_id::text = ANY($1::text[])
    GROUP BY donor_id
  `, [donorIds.map(String)]);
  const agg = new Map(rows.map(r => [r.donor_id, r]));
  let updated = 0;
  const BATCH = 100;
  for (let i = 0; i < donorIds.length; i += BATCH) {
    const chunk = donorIds.slice(i, i + BATCH);
    const { data: donors } = await db.from('donor_profiles').select('id').in('id', chunk);
    for (const d of (donors || [])) {
      const a = agg.get(String(d.id));
      const hasRemaining = a && a.donation_count > 0;
      await db.from('donor_profiles').update({
        total_amount: hasRemaining ? a.total_amount : 0,
        donation_count: hasRemaining ? a.donation_count : 0,
        first_donation_date: hasRemaining ? a.first_donation_date : null,
        last_donation_date: hasRemaining ? a.last_donation_date : null,
        updated_at: new Date().toISOString(),
      }).eq('id', d.id);
      if (!hasRemaining) {
        try {
          await db.from('fro_assignments')
            .update({ status: 'pending' })
            .in('donor_id', [d.id])
            .eq('status', 'donation_collected');
        } catch (e) { console.warn('assignment reopen skipped:', e.message); }
      }
      updated++;
    }
  }
  return updated;
};

const cleanupDayAutoCredits = async (from, to) => {
  // Auto-credit logs store transaction_datetime = receipt date at session-midnight,
  // so cast the column to date for a timezone-independent day match.
  const nextDay = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86400000).toISOString().slice(0, 10);
  let cleaned = 0;
  while (true) {
    const { rows: logs } = await db._pool.query(`
      SELECT id, assignment_id FROM fro_donor_logs
      WHERE notes ILIKE 'Auto-credited from imported receipt%'
        AND transaction_datetime::date >= $1 AND transaction_datetime::date < $2
      LIMIT 1000
    `, [from, nextDay]);
    const rows = logs || [];
    if (rows.length === 0) break;
    const ids = rows.map(r => r.id);
    const assignmentIds = [...new Set(rows.map(r => r.assignment_id).filter(Boolean))];
    try { await db.from('notification_log').delete().in('fro_donor_log_id', ids); } catch (e) { console.warn('notification_log cleanup skipped:', e.message); }
    const { data: deleted } = await db.from('fro_donor_logs').delete().in('id', ids).select('id');
    cleaned += deleted?.length || 0;
    if (assignmentIds.length > 0) {
      const { error } = await db.from('fro_assignments')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .in('id', assignmentIds)
        .eq('status', 'donation_collected');
      if (error) console.warn('assignment reopen skipped:', error.message);
    }
  }
  return cleaned;
};

const clearReceiptsByDate = async (from, to) => {
  let deleted = 0, deletedLogs = 0;
  const affected = new Set();
  const affectedProjects = new Set();
  while (true) {
    const { data: rows } = await db
      .from('receipts')
      .select('id, log_id, donor_id, project_id')
      .neq('id', 0)
      .gte('receipt_date', from)
      .lte('receipt_date', to)
      .limit(1000);
    const batchRows = rows || [];
    if (batchRows.length === 0) break;
    const ids = batchRows.map(r => r.id);
    // Reset linked bank_audit_entries BEFORE deleting (FK ON DELETE SET NULL
    // only clears receipt_id; receipt_no and status must be explicitly reset)
    if (ids.length > 0) {
      await db
        .from('bank_audit_entries')
        .update({
          receipt_id: null, receipt_no: null, status: 'unverified',
          match_status: null, match_source: null, match_score: null,
          matched_lead_log_id: null, matched_by: null, matched_at: null,
          donor_id: null, agent_name: null,
        })
        .in('receipt_id', ids);
    }
    const rowsOut = batchRows;
    deleted += await bulkDeleteReceipts(ids);
    for (const r of rowsOut) {
      if (r.donor_id) affected.add(r.donor_id);
      if (r.project_id) affectedProjects.add(r.project_id);
    }
    deletedLogs += await deleteLinkedLogs(rowsOut.map(r => r.log_id).filter(Boolean));
  }
  // Reset receipt number counters so next receipt continues from last live number
  for (const projectId of affectedProjects) {
    try { await cancelReceiptNo(projectId); } catch (e) { /* ignore */ }
  }
  const cleanedAutoCredits = await cleanupDayAutoCredits(from, to);
  const recomputed = await recomputeDonorTotals([...affected]);
  const { count } = await db
    .from('receipts')
    .select('*', { count: 'exact', head: true })
    .gte('receipt_date', from)
    .lte('receipt_date', to);
  return { deleted, remaining: count || 0, recomputedDonors: recomputed, deletedLogs, cleanedAutoCredits };
};

export const importReceiptNames = async (req, res) => {
  try {
    const { rows, ngo_id } = req.body;
    if (!rows || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No name rows provided' });
    }
    if (!ngo_id) {
      return res.status(400).json({ message: 'Please select the NGO this upload belongs to' });
    }
    const { data: ngoRow, error: ngoErr } = await db
      .from('ngos')
      .select('id, name, is_active')
      .eq('id', ngo_id)
      .single();
    if (ngoErr || !ngoRow || !ngoRow.is_active) {
      return res.status(400).json({ message: 'Selected NGO is invalid or inactive' });
    }
    const batchProjectId = ngoRow.name.toLowerCase();

    const byNo = new Map();
    for (const r of rows) {
      const no = String(r.receipt_no ?? '').trim();
      const name = String(r.donor_name ?? '').trim();
      if (!no || !name) continue;
      byNo.set(no, name);
    }
    const skipped = rows.length - byNo.size;
    const receiptNos = [...byNo.keys()];

    const receiptsByNo = new Map();
    if (receiptNos.length > 0) {
      for (let i = 0; i < receiptNos.length; i += 100) {
        const batch = receiptNos.slice(i, i + 100);
        const { data, error } = await db
          .from('receipts')
          .select('id, receipt_no, donor_id')
          .eq('project_id', batchProjectId)
          .in('receipt_no', batch);
        if (error) throw new Error(error.message);
        for (const r of (data || [])) receiptsByNo.set(String(r.receipt_no).trim(), r);
      }
    }

    const donorNameById = new Map();
    const updateQueries = [];
    for (const [no, name] of byNo) {
      const receipt = receiptsByNo.get(no);
      if (!receipt) continue;
      updateQueries.push(db.from('receipts').update({ donor_name: name }).eq('id', receipt.id));
      if (receipt.donor_id) donorNameById.set(parseInt(receipt.donor_id), name);
    }
    for (const q of updateQueries) {
      const { error } = await q;
      if (error) throw new Error(error.message);
    }

    for (const [donorId, name] of donorNameById) {
      const { error } = await db.from('donor_profiles')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', donorId);
      if (error) throw new Error(error.message);
    }

    return res.json({
      updated: updateQueries.length,
      notFound: receiptNos.length - updateQueries.length,
      skipped,
    });
  } catch (e) {
    console.error('importReceiptNames error:', e.message);
    return res.status(500).json({ message: 'Failed to update donor names: ' + e.message });
  }
};

export const getReceiptByMobile = async (req, res) => {
  try {
    const mobile = String(req.query.mobile || '').replace(/\D/g, '').slice(-10);
    if (!/^\d{10}$/.test(mobile)) {
      return res.status(400).json({ message: 'A valid mobile number is required' });
    }
    const { rows } = await db._pool.query(
      `SELECT r.donor_name, r.address, r.pan_number, r.donor_mobile, r.donor_id, r.receipt_no, r.receipt_date,
              r.email,
              COALESCE(dp.address_2, '') AS address_2,
              COALESCE(dp.city, '') AS city,
              COALESCE(dp.pin_code, '') AS pin_code
       FROM receipts r
       LEFT JOIN donor_profiles dp ON dp.id = r.donor_id
       WHERE right(regexp_replace(r.donor_mobile, '[^0-9]', '', 'g'), 10) = $1
       ORDER BY r.receipt_date DESC NULLS LAST, r.id DESC
       LIMIT 1`,
      [mobile]
    );
    return res.json(rows[0] || null);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const clearReceipts = async (req, res) => {
  try {
    const batch = req.query.batch ? parseInt(req.query.batch) : null;
    const shouldReverse = req.query.reverse === '1';
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    if (from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ message: 'from must be in YYYY-MM-DD format' });
      if (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ message: 'to must be in YYYY-MM-DD format' });
      const result = await clearReceiptsByDate(from, to || from);
      return res.json({ ...result, total: result.deleted + result.remaining });
    }

    const reversed = batch ? (shouldReverse ? await reverseDonorTotals() : 0) : await reverseDonorTotals();
    const cleanedAutoCredits = (batch ? shouldReverse : true) ? await cleanupImportAutoCredits() : 0;

    let deleted = 0, remaining = 0;
    let deletedLogs = 0;
    if (batch) {
      const { data: ids } = await db
        .from('receipts')
        .select('id, log_id')
        .neq('id', 0)
        .limit(batch);
      const rows = ids || [];
      const batchIds = rows.map(r => r.id);
      deleted = await bulkDeleteReceipts(batchIds);
      deletedLogs = await deleteLinkedLogs(rows.map(r => r.log_id).filter(Boolean));
    } else {
      const { data: rows } = await db
        .from('receipts')
        .select('id, log_id')
        .neq('id', 0);
      deleted = await bulkDeleteReceipts((rows || []).map(r => r.id));
      remaining = 0;
      deletedLogs = await deleteLinkedLogs((rows || []).map(r => r.log_id).filter(Boolean));
    }

    return res.json({ deleted, remaining, total: deleted + remaining, reversedDonorLinks: reversed, deletedLogs, cleanedAutoCredits });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getReceiptCount = async (req, res) => {
  try {
    const { count } = await db
      .from('receipts')
      .select('*', { count: 'exact', head: true })
      .is('voided_at', null);
    return res.json({ count: count || 0 });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Last issued + next upcoming receipt number per NGO. Read-only — never calls
// next_receipt_no() so viewing the numbers doesn't consume any receipt numbers.
export const getReceiptNumbers = async (req, res) => {
  try {
    const numbers = await modelGetReceiptNumbers();
    return res.json(numbers);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Bare suspense receipts per NGO: unlinked (no donor, no log), truly suspense
// (agent name AND donor mobile both missing), not priyank, not already in a
// bank-audit entry. The same pool the bank-audit page counts as suspense.
export const getSuspenseByNgo = async (req, res) => {
  try {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    const monthStart = `${y}-${m}-01`;
    const lastDay = new Date(Date.UTC(y, ist.getUTCMonth() + 1, 0)).getUTCDate();
    const monthEnd = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    const { rows } = await db._pool.query(`
      SELECT project_id,
             count(*)::int AS count,
             COALESCE(round(sum(amount)::numeric, 2), 0)::float8 AS total_amount
      FROM receipts
      WHERE donor_id IS NULL AND log_id IS NULL
        AND (agent_name IS NULL OR trim(agent_name) = '' OR lower(trim(agent_name)) IN ('na', 'suspense'))
        AND (donor_mobile IS NULL OR trim(donor_mobile) = '' OR lower(trim(donor_mobile)) IN ('na', 'suspense'))
        AND lower(trim(COALESCE(agent_name, ''))) <> 'priyank shah'
        AND receipt_date >= $1 AND receipt_date <= $2
      GROUP BY project_id
      ORDER BY count(*) DESC
    `, [monthStart, monthEnd]);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Today + current-month (IST) receipt totals per NGO — feeds the Lead & Audit
// page's right-hand "NGO Collections" cards (TODAY / MONTH).
export const getNgoCollections = async (_req, res) => {
  try {
    const { rows } = await db._pool.query(`
      SELECT project_id,
             count(*) FILTER (WHERE receipt_date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today_count,
             COALESCE(sum(amount) FILTER (WHERE receipt_date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::float8 AS today_total,
             count(*) FILTER (WHERE receipt_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS month_count,
             COALESCE(sum(amount) FILTER (WHERE receipt_date >= date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::float8 AS month_total
      FROM receipts
      WHERE receipt_no IS NOT NULL
      GROUP BY project_id
      ORDER BY count(*) DESC
    `);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const quickSearchDonors = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);
    const query = q.trim();
    const { data, error } = await db
      .from('donor_profiles')
      .select('id,name,mobile_number,address_1,address_2,city,pin_code,pan_number,email')
      .or(`name.ilike.%${query}%,mobile_number.ilike.%${query}%`)
      .order('last_donation_date', { ascending: false, nullsFirst: false })
      .limit(8);
    if (error) throw error;
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorsList = async (req, res) => {
  try {
    const { search, page = '1', limit = '50', ngo, missing_station, agent, station } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100000, Math.max(1, parseInt(limit) || 50));
    const from = (pageNum - 1) * limitNum;
    const to = from + limitNum - 1;

    let query = db
      .from('donor_profiles')
      .select('*', { count: 'exact' });

    if (search) {
      const q = search.trim();
      query = query.or(`name.ilike.%${q}%,mobile_number.ilike.%${q}%,city.ilike.%${q}%`);
    }

    // "Missing station" narrowing: donors with at least one live assignment
    // that HAS an agent but NO station — the rows this page can repair.
    if (missing_station === 'true' || missing_station === '1') {
      const { data: msRows, error: msErr } = await db
        .from('fro_assignments')
        .select('donor_id, fro_worker_id, station')
        .not('status', 'eq', 'reassigned');
      if (msErr) throw msErr;
      const missingIds = [...new Set((msRows || [])
        .filter(a => a.fro_worker_id && !(a.station && String(a.station).trim() !== ''))
        .map(a => a.donor_id)
        .filter(Boolean))];
      if (missingIds.length === 0) return res.json({ data: [], total: 0, page: pageNum, limit: limitNum });
      query = query.in('id', missingIds);
    }

    // "Agent" narrowing: donors with at least one live assignment belonging to
    // the selected FRO agent (by name or CRM agent label).
    if (agent && String(agent).trim()) {
      const agentName = String(agent).trim();
      // Resolve the label back to its worker: the picker sends "Agent 2", which
      // matches no workers.name, so an ILIKE on workers alone returns nothing.
      const resolvedWorkerId = await resolveAgentToWorker(agentName);
      const agentIds = new Set();
      if (resolvedWorkerId) agentIds.add(resolvedWorkerId);
      const { data: agentRows, error: agentErr } = await db
        .from('workers')
        .select('id')
        .ilike('name', agentName);
      if (agentErr) throw agentErr;
      for (const w of agentRows || []) if (w.id) agentIds.add(w.id);
      let agentDonorIds = [];
      if (agentIds.size > 0) {
        const { data: agentAssigns, error: aaErr } = await db
          .from('fro_assignments')
          .select('donor_id')
          .in('fro_worker_id', [...agentIds])
          .not('status', 'eq', 'reassigned');
        if (aaErr) throw aaErr;
        agentDonorIds = [...new Set((agentAssigns || []).map(a => a.donor_id).filter(Boolean))];
      }
      if (agentDonorIds.length === 0) return res.json({ data: [], total: 0, page: pageNum, limit: limitNum });
      query = query.in('id', agentDonorIds);
    }

    // "Station" narrowing: donors with at least one live assignment at the
    // selected station. Mirrors the agent filter so combos compose correctly.
    if (station && String(station).trim()) {
      const st = String(station).trim();
      const { data: stationRows, error: stationErr } = await db
        .from('fro_assignments')
        .select('donor_id')
        .eq('station', st)
        .not('status', 'eq', 'reassigned');
      if (stationErr) throw stationErr;
      const stationDonorIds = [...new Set((stationRows || []).map(a => a.donor_id).filter(Boolean))];
      if (stationDonorIds.length === 0) return res.json({ data: [], total: 0, page: pageNum, limit: limitNum });
      query = query.in('id', stationDonorIds);
    }

    let ngoRow = null;
    if (ngo && ngo.trim()) {
      const n = ngo.trim();
      const ids = new Set();
      const { data: matched } = await db
        .from('ngos')
        .select('id')
        .ilike('name', n)
        .maybeSingle();
      ngoRow = matched || null;
      if (ngoRow) {
        const { data: assigned } = await db
          .from('fro_assignments')
          .select('donor_id')
          .eq('ngo_id', ngoRow.id)
          .not('status', 'eq', 'reassigned');
        for (const a of assigned || []) if (a.donor_id) ids.add(a.donor_id);
      }
      const { data: byProfile } = await db
        .from('donor_profiles')
        .select('id')
        .ilike('ngo', `%${n}%`);
      for (const d of byProfile || []) ids.add(d.id);

      if (ids.size === 0) return res.json({ data: [], total: 0, page: pageNum, limit: limitNum });
      query = query.in('id', [...ids]);
    }

    const { data, count, error } = await query
      .order('last_donation_date', { ascending: false, nullsFirst: false })
      .order('first_imported_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    const donorIds = (data || []).map(d => d.id).filter(Boolean);
    if (donorIds.length > 0) {
      const { data: assignments } = await db
        .from('fro_assignments')
        .select('id, donor_id, fro_worker_id, station, ngo_id')
        .in('donor_id', donorIds)
        .not('status', 'eq', 'reassigned');

      const ngoIds = [...new Set((assignments || []).map(a => a.ngo_id).filter(Boolean))];
      const ngoMap = {};
      if (ngoIds.length > 0) {
        const { data: ngos } = await db
          .from('ngos')
          .select('id, name')
          .in('id', ngoIds);
        for (const n of ngos || []) ngoMap[n.id] = n.name;
      }

      const workerIds = [...new Set((assignments || []).map(a => a.fro_worker_id).filter(Boolean))];
      const workerMap = {};
      if (workerIds.length > 0) {
        const { data: workers } = await db
          .from('workers')
          .select('id, name')
          .in('id', workerIds);
        for (const w of workers || []) workerMap[w.id] = w.name;
      }

      const scopedAssignments = ngoRow
        ? (assignments || []).filter(a => a.ngo_id === ngoRow.id)
        : (assignments || []);

      const donorNgoMap = {};
      const donorAssignmentMap = {};
      const donorAssignmentList = {};
      for (const a of scopedAssignments) {
        if (!donorNgoMap[a.donor_id]) donorNgoMap[a.donor_id] = new Set();
        const ngoName = ngoMap[a.ngo_id];
        if (ngoName) donorNgoMap[a.donor_id].add(ngoName);

        if (!donorAssignmentMap[a.donor_id]) donorAssignmentMap[a.donor_id] = [];
        const name = workerMap[a.fro_worker_id];
        if (name) donorAssignmentMap[a.donor_id].push(`${name} (${a.station || '?'})`);

        if (!donorAssignmentList[a.donor_id]) donorAssignmentList[a.donor_id] = [];
        donorAssignmentList[a.donor_id].push({ id: a.id, ngo_id: a.ngo_id, ngo: ngoMap[a.ngo_id] || '', worker_id: a.fro_worker_id, name, station: a.station || '' });
      }

      for (const d of data || []) {
        const labels = donorAssignmentMap[d.id];
        d.assigned_to = labels && labels.length > 0 ? [...new Set(labels)].join(', ') : null;
        d.assignment_list = donorAssignmentList[d.id] || [];

        const ngoFromAssignments = donorNgoMap[d.id];
        if (ngoFromAssignments && ngoFromAssignments.size > 0) {
          if (d.ngo && ngoFromAssignments.has(d.ngo)) {
            d.ngo = d.ngo;
          } else {
            d.ngo = [...ngoFromAssignments].join(', ');
          }
        }
      }
    }

    return res.json({ data: data || [], total: count || 0, page: pageNum, limit: limitNum });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const exportDonors = async (req, res) => {
  try {
    const { search } = req.query;

    let query = db.from('donor_profiles').select('*');

    if (search && search.trim()) {
      const q = search.trim();
      query = query.or(`name.ilike.%${q}%,mobile_number.ilike.%${q}%,city.ilike.%${q}%`);
    }

    const { data: donors, error } = await query.order('last_donation_date', { ascending: false, nullsFirst: false });
    if (error) throw error;
    if (!donors || donors.length === 0) return res.json({ data: [], total: 0 });

    const donorIds = donors.map(d => d.id).filter(Boolean);

    // Chunked assignment fetch
    const latestByDonor = new Map();
    const ASSIGN_BATCH = 1000;
    for (let i = 0; i < donorIds.length; i += ASSIGN_BATCH) {
      const { data: assignments, error: asgnErr } = await db
        .from('fro_assignments')
        .select('donor_id, fro_worker_id, station, ngo_id, assigned_at')
        .in('donor_id', donorIds.slice(i, i + ASSIGN_BATCH))
        .not('status', 'eq', 'reassigned');
      if (asgnErr) throw asgnErr;
      for (const a of assignments || []) {
        const cur = latestByDonor.get(a.donor_id);
        const ts = (x) => new Date(x?.assigned_at || 0).getTime();
        if (!cur || ts(a) > ts(cur)) latestByDonor.set(a.donor_id, a);
      }
    }

    const assignments = [...latestByDonor.values()];

    const workerIds = [...new Set(assignments.map(a => a.fro_worker_id).filter(Boolean))];
    const workerMap = {};
    if (workerIds.length > 0) {
      for (let i = 0; i < workerIds.length; i += 500) {
        const { data: workers, error: wErr } = await db.from('workers').select('id, name').in('id', workerIds.slice(i, i + 500));
        if (wErr) throw wErr;
        for (const w of workers || []) workerMap[w.id] = w.name;
      }
    }

    const ngoIds = [...new Set(assignments.map(a => a.ngo_id).filter(Boolean))];
    const ngoMap = {};
    if (ngoIds.length > 0) {
      const { data: ngos, error: nErr } = await db.from('ngos').select('id, name').in('id', ngoIds);
      if (nErr) throw nErr;
      for (const n of ngos || []) ngoMap[n.id] = n.name;
    }

    // Fetch receipt details per donor by donor_id (chunked)
    const receiptsByDonor = new Map();
    const RECEIPT_BATCH = 500;
    for (let i = 0; i < donorIds.length; i += RECEIPT_BATCH) {
      const chunk = donorIds.slice(i, i + RECEIPT_BATCH);
      const { data: recs } = await db
        .from('receipts')
        .select('donor_id, receipt_no, amount, receipt_date, mode, payment_id, project_id, bank_name')
        .in('donor_id', chunk)
        .order('receipt_date', { ascending: false });
      for (const r of recs || []) {
        if (!receiptsByDonor.has(r.donor_id)) receiptsByDonor.set(r.donor_id, []);
        receiptsByDonor.get(r.donor_id).push(r);
      }
    }

    // Second pass: catch receipts with donor_id = NULL matched by mobile or name
    const mobileToDonorId = new Map();
    const nameToDonorId = new Map();
    for (const d of donors) {
      const mob = String(d.mobile_number || '').trim();
      if (mob) mobileToDonorId.set(mob, d.id);
      const nm = String(d.name || '').trim().toLowerCase();
      if (nm) nameToDonorId.set(nm, d.id);
    }

    // Build WHERE: donor_id IS NULL AND (mobile or name matches)
    const mobileList = [...mobileToDonorId.keys()].filter(Boolean);
    const orConditions = [];
    if (mobileList.length > 0) {
      orConditions.push(`donor_mobile IN (${mobileList.map((_, i) => `$${i + 1}`).join(',')})`);
    }
    if (mobileList.length === 0) {
      // No mobiles to match — skip second pass
    } else {
      const mobileParams = [...mobileList];
      const whereNull = `donor_id IS NULL AND (${orConditions.join(' OR ')})`;
      try {
        const sql = `SELECT donor_id, donor_name, donor_mobile, receipt_no, amount, receipt_date, "mode", payment_id, project_id
                     FROM receipts WHERE ${whereNull} ORDER BY receipt_date DESC`;
        const { rows: unmatched } = await db._pool.query(sql, mobileParams);
        for (const r of unmatched || []) {
          const matchedMob = String(r.donor_mobile || '').trim();
          const matchedId = mobileToDonorId.get(matchedMob);
          if (matchedId) {
            if (!receiptsByDonor.has(matchedId)) receiptsByDonor.set(matchedId, []);
            receiptsByDonor.get(matchedId).push(r);
          }
        }
      } catch (err) {
        console.error('Export donors: unmatched receipt pass failed:', err.message);
      }

      // Also catch receipts with donor_id set but pointing to a donor not in the list
      // These are receipts where donor_id exists but we didn't fetch them (shouldn't happen but safety)
    }

    const rows = donors.map(d => {
      const a = latestByDonor.get(d.id);
      const recs = receiptsByDonor.get(d.id) || [];
      const receiptNos = recs.map(r => r.receipt_no).filter(Boolean).join(', ');
      const totalReceiptAmount = recs.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
      const receivedBanks = [...new Set(recs.map(r => r.bank_name).filter(Boolean))].join(', ');
      return {
        'Donor Name': d.name || d.bank_donor_name || d.agent_donor_name || '',
        'Mobile': d.mobile_number || '',
        'Email': d.email || '',
        'PAN': d.pan_number || '',
        'Address': d.address_1 || '',
        'Address 2': d.address_2 || '',
        'City': d.city || '',
        'Pin Code': d.pin_code || '',
        'NGO': a?.ngo_id ? (ngoMap[a.ngo_id] || d.ngo || '') : (d.ngo || ''),
        'Assigned To': a?.fro_worker_id ? (workerMap[a.fro_worker_id] || '') : '',
        'Station': a?.station || d.station || '',
        'Project': d.project_supported || '',
        'Total Amount': d.total_amount != null ? Number(d.total_amount) : 0,
        'Donations': d.donation_count != null ? Number(d.donation_count) : 0,
        'Last Donation': d.last_donation_date || '',
        'Receipt Numbers': receiptNos,
        'Receipt Count': recs.length,
        'Total Receipt Amount': totalReceiptAmount,
        'Received Bank': receivedBanks,
      };
    });

    return res.json({ data: rows, total: rows.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const exportDuplicateDonorAssignments = async (req, res) => {
  try {
    // Overlap pairs: one donor assigned to 2+ DIFFERENT FROs within the SAME
    // NGO among active assignments. Active matches the guards' semantics:
    // status IS NULL OR status <> 'reassigned'.
    const { rows: pairs } = await db._pool.query(`
      SELECT a.donor_id, a.ngo_id,
             COUNT(DISTINCT a.fro_worker_id)::int AS fro_count,
             COUNT(*)::int AS assignment_rows
      FROM fro_assignments a
      WHERE (a.status IS NULL OR a.status <> 'reassigned')
        AND a.donor_id IS NOT NULL
        AND a.ngo_id IS NOT NULL
        AND a.fro_worker_id IS NOT NULL
      GROUP BY a.donor_id, a.ngo_id
      HAVING COUNT(DISTINCT a.fro_worker_id) > 1
      ORDER BY fro_count DESC, a.donor_id
    `);

    if (!pairs || pairs.length === 0) return res.json({ data: [], details: [], total: 0 });

    const pairKey = (donorId, ngoId) => `${String(donorId)}|${String(ngoId)}`;
    const pairSet = new Set(pairs.map(p => pairKey(p.donor_id, p.ngo_id)));
    const donorIds = [...new Set(pairs.map(p => p.donor_id).filter(Boolean))];

    // Donor profiles (chunked)
    const donorMap = {};
    for (let i = 0; i < donorIds.length; i += 500) {
      const { data: donors, error: dErr } = await db
        .from('donor_profiles')
        .select('id, name, bank_donor_name, agent_donor_name, mobile_number')
        .in('id', donorIds.slice(i, i + 500));
      if (dErr) throw dErr;
      for (const d of donors || []) donorMap[d.id] = d;
    }

    // All active assignment rows for the overlapping donors (chunked)
    const assignmentRows = [];
    for (let i = 0; i < donorIds.length; i += 500) {
      const { data: rows, error: aErr } = await db
        .from('fro_assignments')
        .select('donor_id, ngo_id, fro_worker_id, station, status, assigned_at')
        .in('donor_id', donorIds.slice(i, i + 500))
        .not('status', 'eq', 'reassigned');
      if (aErr) throw aErr;
      for (const a of rows || []) {
        if (pairSet.has(pairKey(a.donor_id, a.ngo_id))) assignmentRows.push(a);
      }
    }

    // Resolve NGO names (chunked)
    const ngoIds = [...new Set(pairs.map(p => p.ngo_id).filter(Boolean))];
    const ngoMap = {};
    for (let i = 0; i < ngoIds.length; i += 500) {
      const { data: ngos, error: nErr } = await db.from('ngos').select('id, name').in('id', ngoIds.slice(i, i + 500));
      if (nErr) throw nErr;
      for (const n of ngos || []) ngoMap[n.id] = n.name;
    }

    // Resolve worker names (chunked)
    const workerIds = [...new Set(assignmentRows.map(a => a.fro_worker_id).filter(Boolean))];
    const workerMap = {};
    for (let i = 0; i < workerIds.length; i += 500) {
      const { data: workers, error: wErr } = await db.from('workers').select('id, name').in('id', workerIds.slice(i, i + 500));
      if (wErr) throw wErr;
      for (const w of workers || []) workerMap[w.id] = w.name;
    }

    const byPair = new Map();
    for (const a of assignmentRows) {
      const k = pairKey(a.donor_id, a.ngo_id);
      if (!byPair.has(k)) byPair.set(k, []);
      byPair.get(k).push(a);
    }

    const donorNameOf = (d) => (d && (d.name || d.bank_donor_name || d.agent_donor_name)) || '';

    // One overview row per donor: FRO / NGO / Station column trios, one trio per
    // assigned FRO (padded to the widest donor so all rows share the same columns).
    const byDonor = new Map();
    for (const p of pairs) {
      const asns = (byPair.get(pairKey(p.donor_id, p.ngo_id)) || [])
        .sort((x, y) => new Date(x.assigned_at || 0) - new Date(y.assigned_at || 0));
      if (!byDonor.has(p.donor_id)) byDonor.set(p.donor_id, []);
      for (const a of asns) byDonor.get(p.donor_id).push(a);
    }

    const maxFro = Math.max(0, ...[...byDonor.values()].map(list => list.length));
    const headerKeys = ['Donor Name', 'Mobile'];
    for (let i = 1; i <= maxFro; i++) {
      headerKeys.push(`FRO ${i}`, `NGO ${i}`, `Station ${i}`);
    }

    const data = [];
    const details = [];
    for (const [donorId, asns] of [...byDonor.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      const d = donorMap[donorId] || {};
      const row = { 'Donor Name': donorNameOf(d), 'Mobile': d.mobile_number || '' };
      const trios = [];
      for (const a of asns) {
        trios.push([
          workerMap[a.fro_worker_id] || 'Unknown',
          ngoMap[a.ngo_id] || '',
          a.station || '',
        ]);
        details.push({
          'Donor Name': donorNameOf(d),
          'Mobile': d.mobile_number || '',
          'NGO': ngoMap[a.ngo_id] || '',
          'FRO Name': workerMap[a.fro_worker_id] || 'Unknown',
          'Station': a.station || '',
          'Status': a.status || '',
          'Assigned At': a.assigned_at || '',
        });
      }
      for (let i = 0; i < maxFro; i++) {
        row[`FRO ${i + 1}`] = trios[i]?.[0] ?? '';
        row[`NGO ${i + 1}`] = trios[i]?.[1] ?? '';
        row[`Station ${i + 1}`] = trios[i]?.[2] ?? '';
      }
      data.push(row);
    }

    return res.json({ columns: headerKeys, data, details, total: data.length });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getDonorDetail = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: donor, error: donorErr } = await db
      .from('donor_profiles')
      .select('*')
      .eq('id', id)
      .single();
    if (donorErr) throw donorErr;

    // Receipts reach a donor by linked donor_id OR by captured mobile only.
    const receipts = await receiptsForDonor(db, donor);

    let assigned_agent = null;
    let assignment_station = null;
    let assignment_ngo = null;
    let assignments = [];
    try {
      const { data: assignmentRows } = await db
        .from('fro_assignments')
        .select('id, fro_worker_id, station, ngo_id, status')
        .eq('donor_id', id)
        .not('status', 'eq', 'reassigned')
        .order('assigned_at', { ascending: false });

      const workerIds = [...new Set((assignmentRows || []).map(a => a.fro_worker_id).filter(Boolean))];
      const ngoIds = [...new Set((assignmentRows || []).map(a => a.ngo_id).filter(Boolean))];
      const workerMap = {};
      const ngoMap = {};
      if (workerIds.length > 0) {
        const { data: workers } = await db.from('workers').select('id, name').in('id', workerIds);
        for (const worker of workers || []) workerMap[worker.id] = worker.name;
      }
      if (ngoIds.length > 0) {
        const { data: ngos } = await db.from('ngos').select('id, name').in('id', ngoIds);
        for (const ngo of ngos || []) ngoMap[ngo.id] = ngo.name;
      }
      assignments = (assignmentRows || []).map(a => ({
        id: a.id,
        worker_id: a.fro_worker_id,
        worker_name: workerMap[a.fro_worker_id] || null,
        station: a.station || '',
        ngo_id: a.ngo_id,
        ngo_name: ngoMap[a.ngo_id] || null,
        status: a.status,
      }));
      if (assignments.length > 0) {
        const a = assignments[0];
        assigned_agent = a.worker_name;
        assignment_station = a.station || null;
        assignment_ngo = a.ngo_name;
      }
    } catch (assignErr) {
      console.error('getDonorDetail: failed to load assignment:', assignErr.message);
    }

    return res.json({
      donor,
      receipts: receipts || [],
      receiptCount: receipts?.length || 0,
      totalAmount: (receipts || []).reduce((s, r) => s + parseFloat(r.amount || 0), 0),
      assigned_agent,
      assignment_station,
      assignment_ngo,
      assignments,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Permanently remove a donor and operational FRO data as one transaction.
// Financial receipts remain in place but are detached from the deleted profile.
export const deleteDonor = async (req, res) => {
  try {
    const { id: donorId } = req.params;
    const result = await db.transaction(async (tx) => {
      const { data: donor, error: donorErr } = await tx.from('donor_profiles').select('id, name, mobile_number').eq('id', donorId).maybeSingle();
      if (donorErr) throw donorErr;
      if (!donor) return null;

      const { data: assignments, error: assignmentErr } = await tx
        .from('fro_assignments').select('id').eq('donor_id', donorId);
      if (assignmentErr) throw assignmentErr;
      const assignmentIds = (assignments || []).map(a => a.id).filter(Boolean);

      // Clear both direct and log-linked receipt references before deleting logs/profile.
      const { error: receiptErr } = await tx.from('receipts').update({ donor_id: null }).eq('donor_id', donorId);
      if (receiptErr) throw receiptErr;

      let logsDeleted = 0;
      if (assignmentIds.length > 0) {
        const { data: logs, error: logFetchErr } = await tx.from('fro_donor_logs').select('id').in('assignment_id', assignmentIds);
        if (logFetchErr) throw logFetchErr;
        const logIds = (logs || []).map(l => l.id).filter(Boolean);
        if (logIds.length > 0) {
          const { error: linkedReceiptErr } = await tx.from('receipts').update({ donor_id: null, log_id: null }).in('log_id', logIds);
          if (linkedReceiptErr) throw linkedReceiptErr;
          const { error: logDeleteErr } = await tx.from('fro_donor_logs').delete().in('id', logIds);
          if (logDeleteErr) throw logDeleteErr;
          logsDeleted = logIds.length;
        }
        const { error: scheduleErr } = await tx.from('fro_scheduled_contacts').delete().in('assignment_id', assignmentIds);
        if (scheduleErr) throw scheduleErr;
        const { error: assignmentDeleteErr } = await tx.from('fro_assignments').delete().in('id', assignmentIds);
        if (assignmentDeleteErr) throw assignmentDeleteErr;
      }

      const { error: profileErr } = await tx.from('donor_profiles').delete().eq('id', donorId);
      if (profileErr) throw profileErr;
      return { donor, assignments_deleted: assignmentIds.length, logs_deleted: logsDeleted };
    });

    if (!result) return res.status(404).json({ message: 'Donor not found' });
    return res.json({ deleted: true, ...result });
  } catch (error) {
    return res.status(500).json({ message: `Donor deletion failed: ${error.message}` });
  }
};

// One-off repair for "donation-only" donors: receipts exist (with a resolvable
// FRO agent) but their donor has no active fro_assignment for the receipt's
// NGO, so the donor is invisible to every FRO. Creates one assignment per
// (donor, NGO) with status 'donation_collected'. Never touches existing
// assignments, money, logs, or un-attributable donors.
export const backfillReceiptAssignments = async (req, res) => {
  try {
    const { rows } = await db._pool.query(`
      SELECT r.id AS receipt_id, r.donor_id, r.project_id, r.agent_name, r.station, r.receipt_no,
             n.id AS ngo_id
      FROM receipts r
      JOIN donor_profiles d ON d.id = r.donor_id
      JOIN ngos n ON lower(n.name) = lower(r.project_id)
      LEFT JOIN LATERAL (
        SELECT fa.id
        FROM fro_assignments fa
        WHERE fa.donor_id = r.donor_id
          AND fa.ngo_id = n.id
          AND (fa.status IS NULL OR fa.status <> 'reassigned')
        LIMIT 1
      ) a ON true
      WHERE r.voided_at IS NULL
        AND r.donor_id IS NOT NULL
        AND COALESCE(r.agent_name, '') <> ''
        AND lower(r.agent_name) NOT IN ('suspense', 'pg', 'library', 'na')
        AND a.id IS NULL
      ORDER BY r.id ASC
    `);

    const byDonorNgo = new Map();
    for (const row of rows || []) {
      const key = `${row.donor_id}::${row.ngo_id}`;
      if (!byDonorNgo.has(key)) byDonorNgo.set(key, row);
    }

    const created = [];
    const skippedAlreadyAssigned = [];
    const skippedUnresolved = [];
    const now = new Date().toISOString();

    for (const row of byDonorNgo.values()) {
      const worker = await resolveAgentToWorker(row.agent_name);
      if (!worker?.id) {
        skippedUnresolved.push({ donor_id: row.donor_id, ngo_id: row.ngo_id, agent_name: row.agent_name });
        continue;
      }
      const workerId = worker.id;

      const { data: existing } = await db.from('fro_assignments')
        .select('id, status')
        .eq('donor_id', row.donor_id)
        .eq('ngo_id', row.ngo_id)
        .limit(20);
      if ((existing || []).some(a => a.status === null || a.status !== 'reassigned')) {
        skippedAlreadyAssigned.push({ donor_id: row.donor_id, ngo_id: row.ngo_id });
        continue;
      }

      const station = await resolveWorkerStation(db, workerId, row.ngo_id, row.station || null);
      const { data: assignment, error } = await db.from('fro_assignments').insert({
        donor_id: row.donor_id,
        fro_worker_id: workerId,
        ngo_id: row.ngo_id,
        station,
        status: 'donation_collected',
        assigned_at: now,
      }).select().single();
      if (error) throw error;

      try {
        const { data: ngoRow } = await db.from('ngos').select('name').eq('id', row.ngo_id).maybeSingle();
        await db.from('donor_profiles')
          .update({ ngo: ngoRow?.name ?? null, station: station ?? null })
          .eq('id', row.donor_id);
      } catch (syncErr) {
        console.error('backfill: donor-profile sync failed (non-fatal):', syncErr.message);
      }

      created.push({ donor_id: row.donor_id, ngo_id: row.ngo_id, assignment_id: assignment.id, agent_name: row.agent_name });
    }

    return res.json({
      created_count: created.length,
      skipped_already_assigned: skippedAlreadyAssigned.length,
      skipped_unresolved: skippedUnresolved.length,
      created,
      skipped_unresolved_samples: skippedUnresolved.slice(0, 50),
    });
  } catch (error) {
    console.error('backfillReceiptAssignments error:', error.message);
    return res.status(500).json({ message: error.message });
  }
};

export const createDonorAssignment = async (req, res) => {
  try {
    const { id: donorId } = req.params;
    const { fro_worker_id: workerId, ngo_id: ngoId, station } = req.body || {};
    const cleanStation = String(station || '').trim();
    if (!workerId || !ngoId || !cleanStation) return res.status(400).json({ message: 'Agent, NGO, and station are required' });

    const { data: donor, error: donorErr } = await db.from('donor_profiles').select('id').eq('id', donorId).maybeSingle();
    if (donorErr) throw donorErr;
    if (!donor) return res.status(404).json({ message: 'Donor not found' });

    const { data: worker, error: workerErr } = await db.from('workers')
      .select('id, name').eq('id', workerId).eq('department', 'FRO').eq('employment_status', 'active').maybeSingle();
    if (workerErr) throw workerErr;
    if (!worker) return res.status(400).json({ message: 'Agent not found or not an active FRO' });

    const { data: existing, error: existingErr } = await db.from('fro_assignments')
      .select('id').eq('donor_id', donorId).eq('ngo_id', ngoId).or('status.neq.reassigned,status.is.null').limit(1).maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) return res.status(409).json({ message: 'This donor already has an active assignment for this NGO; replace that assignment instead' });

    const now = new Date().toISOString();
    const assignedBy = await resolveAssignedBy(req.user);
    const { data: assignment, error: insertErr } = await db.from('fro_assignments').insert({
      donor_id: donorId,
      fro_worker_id: worker.id,
      ngo_id: ngoId,
      station: cleanStation,
      assigned_by: assignedBy,
      status: 'pending',
      assigned_at: now,
    }).select().single();
    if (insertErr) throw insertErr;

    // Keep donor_profiles in sync with the new assignment (ngo + station).
    try {
      const { data: ngoRow } = await db.from('ngos').select('name').eq('id', ngoId).maybeSingle();
      await db.from('donor_profiles')
        .update({ ngo: ngoRow?.name ?? null, station: cleanStation })
        .eq('id', donorId);
    } catch (syncErr) {
      console.error(`createDonorAssignment: donor-profile sync failed (non-fatal):`, syncErr.message);
    }

    return res.status(201).json({ assignment, agent_name: worker.name, message: `Assigned to ${worker.name} · ${cleanStation}` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Donor Profile Update ───────────────────────────────────

const EDITABLE_DONOR_FIELDS = {
  name: 'name',
  mobile_number: 'mobile_number',
  mobile_2: 'mobile_2',
  email: 'email',
  pan_number: 'pan_number',
  address_1: 'address_1',
  address_2: 'address_2',
  city: 'city',
  pin_code: 'pin_code',
  bank_donor_name: 'bank_donor_name',
  agent_donor_name: 'agent_donor_name',
  donors_bank_name: 'donors_bank_name',
  project_supported: 'project_supported',
  ngo: 'ngo',
  station: 'station',
  category: 'category',
  data_category: 'data_category',
  team: 'team',
  agent_name: 'agent_name',
  mop: 'mop',
  birth_date: 'birth_date',
  state: 'state',
  aadhaar_number: 'aadhaar_number',
  anniversary: 'anniversary',
  preferred_language: 'preferred_language',
  donor_type: 'donor_type',
  donation_frequency: 'donation_frequency',
  account_of: 'account_of',
};

export const updateDonor = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No fields provided to update' });
    }

    const { data: existing, error: fetchErr } = await db
      .from('donor_profiles')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) {
      return res.status(404).json({ message: 'Donor not found' });
    }

    const updateData = { updated_at: new Date().toISOString() };
    let changed = false;
    for (const [field, column] of Object.entries(EDITABLE_DONOR_FIELDS)) {
      if (field in updates) {
        const value = updates[field];
        updateData[column] = (value === '' || value === null) ? null : value;
        changed = true;
      }
    }

    if (!changed) {
      return res.status(400).json({ message: 'No editable donor fields provided' });
    }

    const { data: donor, error: updateErr } = await db
      .from('donor_profiles')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();
    if (updateErr) throw updateErr;

    return res.json({ donor, message: 'Donor updated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Station options for repair dropdowns: real stations from the registry
// (fro_station_assignments) as (station, ngo_id) pairs, optionally narrowed to
// one NGO. Exact strings matter — queue visibility matches on them.
export const getStationOptions = async (req, res) => {
  try {
    const { ngo_id } = req.query;
    let q = db.from('fro_station_assignments').select('station, ngo_id').order('station', { ascending: true });
    if (ngo_id) q = q.eq('ngo_id', ngo_id);
    const { data, error } = await q;
    if (error) throw error;
    const seen = new Set();
    const options = [];
    for (const s of data || []) {
      if (!s.station) continue;
      const key = `${s.ngo_id ?? ''}|${s.station}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ station: s.station, ngo_id: s.ngo_id });
    }
    return res.json({ options });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Repair endpoint: set station ONLY on assignments that have an agent but no
// station. Server-side mirrors of the UI rules so crafted requests can't
// overwrite healthy assignments or invent agents.
export const updateAssignmentStations = async (req, res) => {
  try {
    const { id: donorId } = req.params;
    const updates = Array.isArray(req.body?.assignments) ? req.body.assignments : null;
    if (!updates || updates.length === 0) {
      return res.status(400).json({ message: 'No assignments provided' });
    }

    const ids = updates.map(u => u.id).filter(v => v != null);
    if (ids.length !== updates.length) {
      return res.status(400).json({ message: 'Each assignment needs an id' });
    }

    const { data: rows, error: fErr } = await db
      .from('fro_assignments')
      .select('id, donor_id, station, fro_worker_id, ngo_id')
      .eq('donor_id', donorId)
      .in('id', ids);
    if (fErr) throw fErr;

    const planned = [];
    for (const u of updates) {
      const row = (rows || []).find(r => String(r.id) === String(u.id));
      if (!row) return res.status(404).json({ message: `Assignment ${u.id} does not belong to this donor` });
      if (!row.fro_worker_id) return res.status(400).json({ message: `Assignment ${u.id} has no agent` });
      if (row.station && String(row.station).trim() !== '') {
        return res.status(400).json({ message: `Assignment ${u.id} already has a station (${row.station})` });
      }
      const st = String(u.station ?? '').trim();
      if (!st) return res.status(400).json({ message: 'Station is required' });
      planned.push({ id: row.id, station: st, ngo_id: row.ngo_id });
    }

    for (const p of planned) {
      const { error } = await db
        .from('fro_assignments')
        .update({ station: p.station })
        .eq('id', p.id);
      if (error) throw error;
    }

    // Keep donor_profiles in sync (station + ngo from the assignment's NGO).
    try {
      const latest = planned[planned.length - 1];
      if (latest) {
        const { data: ngoRow } = await db.from('ngos').select('name').eq('id', latest.ngo_id).maybeSingle();
        await db.from('donor_profiles')
          .update({ station: latest.station, ngo: ngoRow?.name ?? null })
          .eq('id', donorId);
      }
    } catch (syncErr) {
      console.error(`updateAssignmentStations: donor-profile sync failed (non-fatal):`, syncErr.message);
    }

    return res.json({ updated: planned.length, assignments: planned, message: 'Station assigned' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Remove an agent assignment entirely: hard-deletes the fro_assignments row
// and its fro_donor_logs (same cascade as restoreWrongAssignments). The donor
// becomes fully unassigned for that NGO and re-enters the unclaimed pool.
export const deleteAssignment = async (req, res) => {
  try {
    const { id: donorId, assignmentId } = req.params;

    const { data: row, error: fErr } = await db
      .from('fro_assignments')
      .select('id, donor_id, fro_worker_id, ngo_id, station')
      .eq('id', assignmentId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!row) return res.status(404).json({ message: 'Assignment not found' });
    if (String(row.donor_id) !== String(donorId)) {
      return res.status(400).json({ message: 'Assignment does not belong to this donor' });
    }

    const result = await db.transaction(async (tx) => {
      const { data: logs } = await tx.from('fro_donor_logs').select('id').eq('assignment_id', row.id);
      const logIds = (logs || []).map(l => l.id).filter(Boolean);

      if (logIds.length > 0) {
        // Detach financial receipts that point at these logs; the receipt itself
        // is kept (matches deleteDonor), just unlinked from the removed logs.
        const { error: receiptErr } = await tx.from('receipts').update({ log_id: null }).in('log_id', logIds);
        if (receiptErr) throw receiptErr;

        // Clear child rows that reference the logs so the logs can be removed.
        try { await tx.from('notification_log').delete().in('fro_donor_log_id', logIds); } catch (_) {}
        try { await tx.from('rejected_lead_tickets').delete().in('fro_donor_log_id', logIds); } catch (_) {}

        const { error: logErr } = await tx.from('fro_donor_logs').delete().in('id', logIds);
        if (logErr) throw logErr;
      }

      const { error: scheduleErr } = await tx.from('fro_scheduled_contacts').delete().eq('assignment_id', row.id);
      if (scheduleErr) throw scheduleErr;

      // Remove stale queue positions so the donor can't linger in the worker's
      // active queue (work_queue has no FK cascade on fro_assignments).
      try {
        await tx.from('work_queue').delete().eq('worker_id', row.fro_worker_id).eq('donor_id', row.donor_id);
      } catch (_) {}

      const { error: deleteErr } = await tx.from('fro_assignments').delete().eq('id', row.id);
      if (deleteErr) throw deleteErr;

      // Re-sync donor_profiles from the donor's remaining active assignment
      // (latest by assigned_at), or clear ngo/station if none remain.
      const { data: next } = await tx
        .from('fro_assignments')
        .select('ngo_id, station')
        .eq('donor_id', row.donor_id)
        .not('status', 'eq', 'reassigned')
        .order('assigned_at', { ascending: false })
        .maybeSingle();
      let ngoVal = null;
      if (next) {
        const { data: ngoRow } = await tx.from('ngos').select('name').eq('id', next.ngo_id).maybeSingle();
        ngoVal = ngoRow?.name ?? null;
      }
      const { error: profileErr } = await tx.from('donor_profiles')
        .update({ ngo: ngoVal ?? null, station: next?.station ?? null })
        .eq('id', row.donor_id);
      if (profileErr) throw profileErr;

      return {
        deleted: true,
        assignment_id: row.id,
        donor_id: row.donor_id,
        logs_deleted: logIds.length,
        message: 'Agent removed',
      };
    });

    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Replace an assignment in one step: pick a new agent AND/OR station. The old
// row is soft-deleted (status='reassigned') for audit trail and a fresh
// pending assignment is inserted — mirrors reassignStationDonors semantics.
// The donor goes straight to the new agent; never touches the pool.
export const replaceAssignment = async (req, res) => {
  try {
    const { id: donorId, assignmentId } = req.params;
    const workerId = req.body?.fro_worker_id;
    const station = String(req.body?.station ?? '').trim();
    if (!workerId) return res.status(400).json({ message: 'Agent is required' });
    if (!station) return res.status(400).json({ message: 'Station is required' });

    const { data: row, error: fErr } = await db
      .from('fro_assignments')
      .select('*')
      .eq('id', assignmentId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!row) return res.status(404).json({ message: 'Assignment not found' });
    if (String(row.donor_id) !== String(donorId)) {
      return res.status(400).json({ message: 'Assignment does not belong to this donor' });
    }

    const { data: worker, error: wErr } = await db
      .from('workers')
      .select('id, name')
      .eq('id', workerId)
      .eq('department', 'FRO')
      .eq('employment_status', 'active')
      .maybeSingle();
    if (wErr) throw wErr;
    if (!worker) return res.status(400).json({ message: 'Agent not found or not an active FRO' });

    const now = new Date().toISOString();

    // Soft-delete the old row so history stays queryable.
    const { error: upErr } = await db
      .from('fro_assignments')
      .update({ status: 'reassigned', updated_at: now })
      .eq('id', row.id);
    if (upErr) throw upErr;

    const assignedBy = await resolveAssignedBy(req.user);
    const { data: created, error: insErr } = await db
      .from('fro_assignments')
      .insert({
        donor_id: row.donor_id,
        fro_worker_id: worker.id,
        ngo_id: row.ngo_id,
        station,
        batch_id: row.batch_id || null,
        batch_type: row.batch_type || null,
        assigned_by: assignedBy,
        status: 'pending',
        assigned_at: now,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // Keep donor_profiles in sync with the replacement assignment (ngo + station).
    try {
      const { data: ngoRow } = await db.from('ngos').select('name').eq('id', row.ngo_id).maybeSingle();
      await db.from('donor_profiles')
        .update({ ngo: ngoRow?.name ?? null, station })
        .eq('id', row.donor_id);
    } catch (syncErr) {
      console.error(`replaceAssignment: donor-profile sync failed (non-fatal):`, syncErr.message);
    }

    return res.json({
      replaced: true,
      old_assignment_id: row.id,
      assignment: created,
      agent_name: worker.name,
      message: `Reassigned to ${worker.name} · ${station}`,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Donor Sync Repair ─────────────────────────────────────
// Backfill donor_profiles.ngo / station from the donor's latest ACTIVE
// fro_assignment (status <> 'reassigned', ordered by assigned_at DESC). This
// repairs profiles that were never kept in sync (e.g. created with NULL
// ngo/station while a valid assignment exists). Scopeable via ?ngo=name.
export const repairDonorSync = async (req, res) => {
  try {
    const { ngo } = req.query;
    const BATCH = 1000;

    // Collect active assignments for scoped NGO (if provided).
    let scopeNgoId = null;
    if (ngo && String(ngo).trim()) {
      const { data: ngoRow } = await db.from('ngos').select('id').ilike('name', String(ngo).trim()).maybeSingle();
      if (!ngoRow) return res.status(404).json({ message: `NGO '${ngo}' not found` });
      scopeNgoId = ngoRow.id;
    }

    const latestByDonor = new Map();
    // Query assignments in chunks by donor offset is complex; instead stream all
    // distinct donors that have any active assignment via a paginated donor fetch.
    let offset = 0;
    let more = true;
    while (more) {
      let q = db
        .from('fro_assignments')
        .select('donor_id, ngo_id, station, assigned_at')
        .not('status', 'eq', 'reassigned')
        .range(offset, offset + BATCH - 1);
      if (scopeNgoId) q = q.eq('ngo_id', scopeNgoId);
      const { data, error } = await q;
      if (error) throw error;
      const chunk = data || [];
      if (chunk.length < BATCH) more = false;
      offset += chunk.length;
      for (const a of chunk) {
        if (!a.donor_id) continue;
        const cur = latestByDonor.get(a.donor_id);
        const ts = (x) => new Date(x?.assigned_at || 0).getTime();
        if (!cur || ts(a) > ts(cur)) latestByDonor.set(a.donor_id, a);
      }
      if (chunk.length === 0) break;
    }

    // Resolve NGO names for involved NGO ids.
    const ngoIds = [...new Set([...latestByDonor.values()].map(a => a.ngo_id).filter(Boolean))];
    const ngoNameMap = {};
    for (let i = 0; i < ngoIds.length; i += 500) {
      const { data: ngos, error: nErr } = await db.from('ngos').select('id, name').in('id', ngoIds.slice(i, i + 500));
      if (nErr) throw nErr;
      for (const n of ngos || []) ngoNameMap[n.id] = n.name;
    }

    // Apply updates only where the profile differs.
    let repaired = 0;
    const updatedIds = [...latestByDonor.keys()];
    for (let i = 0; i < updatedIds.length; i += BATCH) {
      const chunkIds = updatedIds.slice(i, i + BATCH);
      const { data: profiles, error: pErr } = await db
        .from('donor_profiles')
        .select('id, ngo, station')
        .in('id', chunkIds);
      if (pErr) throw pErr;
      for (const d of profiles || []) {
        const latest = latestByDonor.get(d.id);
        if (!latest) continue;
        const targetNgo = latest.ngo_id ? (ngoNameMap[latest.ngo_id] ?? null) : null;
        const targetStation = latest.station ?? null;
        if (d.ngo === targetNgo && (d.station ?? null) === targetStation) continue;
        await db.from('donor_profiles')
          .update({ ngo: targetNgo, station: targetStation })
          .eq('id', d.id);
        repaired++;
      }
    }

    return res.json({ repaired, donors_scanned: updatedIds.length, message: `${repaired} donor profile(s) synced` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Address Import ───────────────────────────────────────
// Excel-driven donor address update: match by normalized mobile number,
// fill ONLY blank fields (never overwrite existing data), skip unknown numbers.

const normalizeMobile = (v) => {
  let n = String(v ?? '').replace(/\D/g, '');
  if (!n) return '';
  if (n.length === 12 && n.startsWith('91')) n = n.slice(2);
  else if (n.length === 11 && n.startsWith('0')) n = n.slice(1);
  return n;
};

export const importDonorAddresses = async (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'No rows provided' });
    }

    const { data: donors, error: fetchErr } = await db
      .from('donor_profiles')
      .select('id, mobile_number, name, address_1, address_2, pan_number, email');
    if (fetchErr) throw fetchErr;

    const byMobile = new Map();
    for (const d of (donors || [])) {
      const key = normalizeMobile(d.mobile_number);
      if (key && !byMobile.has(key)) byMobile.set(key, d);
    }

    const results = [];
    const updates = [];
    const inserts = [];
    const seen = new Set();
    const summary = { total: rows.length, updated: 0, created: 0, matchedNoChange: 0, notFound: 0, skippedNoMobile: 0, duplicatesInFile: 0 };

    rows.forEach((r, i) => {
      const rowNo = i + 2; // +1 header, +1 for 1-based
      const mobile = normalizeMobile(r.mobile_number);
      if (!mobile || mobile.length < 10) {
        summary.skippedNoMobile++;
        results.push({ row: rowNo, mobile: r.mobile_number || '', status: 'no_mobile' });
        return;
      }
      if (seen.has(mobile)) {
        summary.duplicatesInFile++;
        results.push({ row: rowNo, mobile, status: 'duplicate' });
        return;
      }
      seen.add(mobile);

      const existing = byMobile.get(mobile);
      if (!existing) {
        // Unknown number — create a new donor profile so FRO claim / audit
        // manual verification can find this address later.
        const payload = { mobile_number: mobile };
        let hasData = false;
        for (const field of ['name', 'address_1', 'address_2', 'pan_number', 'email']) {
          const val = String(r[field] ?? '').trim();
          if (!val) continue;
          payload[field] = val;
          hasData = true;
        }
        inserts.push(payload);
        summary.created++;
        results.push({ row: rowNo, mobile, status: hasData ? 'created' : 'created_no_data' });
        return;
      }

      const payload = {};
      let hasFill = false;
      const naJunk = (s) => {
        const token = String.raw`(?:n\.?\s*a\.?|n/a|null|none|nil|not\s*available|-+)`;
        return new RegExp(`^${token}(?:\\s*,\\s*${token})*$`, 'i').test(s);
      };
      for (const field of ['name', 'address_1', 'address_2', 'pan_number', 'email']) {
        const val = String(r[field] ?? '').trim();
        if (!val || naJunk(val)) continue;
        const cur = String(existing[field] ?? '').trim();
        if (!cur) { payload[field] = val; hasFill = true; }
      }

      if (!hasFill) {
        summary.matchedNoChange++;
        results.push({ row: rowNo, mobile, status: 'complete' });
        return;
      }

      summary.updated++;
      updates.push({ id: existing.id, payload });
      results.push({ row: rowNo, mobile, status: 'updated' });
    });

    if (updates.length > 0) {
      const jsonPayload = JSON.stringify(updates.map(u => ({ id: u.id, payload: u.payload })));
      const { rowCount } = await db._pool.query(
        `UPDATE donor_profiles AS d SET
           name       = COALESCE(NULLIF(d.name, ''),       NULLIF(v.payload->>'name', ''),       d.name),
           address_1  = COALESCE(NULLIF(d.address_1, ''),  NULLIF(v.payload->>'address_1', ''),  d.address_1),
           address_2  = COALESCE(NULLIF(d.address_2, ''),  NULLIF(v.payload->>'address_2', ''),  d.address_2),
           pan_number = COALESCE(NULLIF(d.pan_number, ''), NULLIF(v.payload->>'pan_number', ''), d.pan_number),
           email      = COALESCE(NULLIF(d.email, ''),      NULLIF(v.payload->>'email', ''),      d.email),
           updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(id int, payload jsonb)
         WHERE d.id = v.id`,
        [jsonPayload]
      );
      summary.updated = rowCount ?? updates.length;
    }

    // New numbers: insert as fresh donor profiles. ignoreDuplicates keeps the
    // import safe if a profile with the same mobile was created concurrently.
    for (let i = 0; i < inserts.length; i += 500) {
      const chunk = inserts.slice(i, i + 500);
      const { data: createdRows, error: insErr } = await db
        .from('donor_profiles')
        .upsert(chunk, { onConflict: 'mobile_number', ignoreDuplicates: true })
        .select('id');
      if (insErr) throw insErr;
      summary.created = (summary.created ?? 0) - chunk.length + (createdRows?.length ?? 0);
    }

    return res.json({ summary, results });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── Receipt Edit ─────────────────────────────────────────

export const getFroWorkersList = async (req, res) => {
  try {
    const { data, error } = await db
      .from('workers')
      .select('id, name')
      .eq('department', 'FRO')
      .eq('employment_status', 'active')
      .order('name', { ascending: true });
    if (error) throw error;
    const workerIds = (data || []).map((w) => w.id);
    let agentLabelMap = {};
    if (workerIds.length > 0) {
      const { data: agentRows, error: agentErr } = await db
        .from('crm_agents')
        .select('worker_id, label')
        .in('worker_id', workerIds)
        .eq('is_active', true);
      if (agentErr) throw agentErr;
      for (const a of agentRows || []) {
        if (a.worker_id && !agentLabelMap[a.worker_id]) agentLabelMap[a.worker_id] = a.label;
      }
    }
    // Every active FRO stays in the list. Receipts record the FRO, not the CRM login
    // agent working their data, so `name` is always the FRO's real name and every
    // row already on file stays selectable. `agent_label` is carried alongside
    // purely so callers can annotate which FROs are covered.
    const result = (data || []).map((w) => ({
      id: w.id,
      name: w.name,
      fro_name: w.name,
      agent_label: agentLabelMap[w.id] || null,
      display_name: w.name,
    }));
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateReceipt = async (req, res) => {
  try {
    const { receiptId } = req.params;
    const updates = req.body;

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No fields provided to update' });
    }

    const { data: receipt, error: rErr } = await db
      .from('receipts').select('*').eq('id', receiptId).maybeSingle();
    if (rErr) throw rErr;
    if (!receipt) return res.status(404).json({ message: 'Receipt not found' });

    // Fields that can be edited on the receipt row
    const RECEIPT_EDITABLE = [
      'donor_name', 'donor_mobile', 'amount', 'address', 'address_2', 'pan_number',
      'email', 'mobile_2', 'station', 'account_of', 'mode', 'agent_name',
      'project_id', 'caller_name', 'bank_name', 'payment_id', 'receipt_date', 'receipt_time',
    ];
    const receiptPatch = {};
    for (const field of RECEIPT_EDITABLE) {
      if (field in updates) {
        receiptPatch[field] = (updates[field] === '' || updates[field] === null) ? null : updates[field];
      }
    }

    if ('amount' in receiptPatch) {
      const parsed = parseFloat(receiptPatch.amount);
      if (Number.isNaN(parsed) || parsed < 0) {
        return res.status(400).json({ message: 'Invalid amount' });
      }
      receiptPatch.amount = Math.round(parsed * 100) / 100;
    }

    const oldAmount = Number(receipt.amount || 0);
    const newAmount = 'amount' in receiptPatch ? Number(receiptPatch.amount || 0) : oldAmount;
    const amountDelta = newAmount - oldAmount;

    // PG/Library/Suspense are category labels, not FRO names -- keep them
    // verbatim so the report rows stay intact. Everything else is stored as
    // typed: normalizing here would rewrite an agent label ("Agent 2") to the
    // FRO's real name, because worker_aliases resolves the label back to that
    // worker. That silently erased the agent from the receipt, and since the
    // label and the name then compared unequal, it also tripped the FRO-change
    // branch below and moved the donor's credit with no prompt.
    if (receiptPatch.agent_name) {
      receiptPatch.agent_name = String(receiptPatch.agent_name).trim();
    }

    // Detect FRO change by the resolved worker, not by the stored string: an
    // agent label and the FRO's real name are two spellings of the same person,
    // so switching between them must not be treated as a reassignment.
    const oldAgentName = (receipt.agent_name || '').trim();
    const newAgentName = (receiptPatch.agent_name ?? receipt.agent_name ?? '').trim();
    const isCategoryLabel = (v) => ['suspense', 'pg', 'library', 'na'].includes(String(v || '').trim().toLowerCase());
    let oldWorkerId = null;
    let newWorkerId = null;
    if (!isCategoryLabel(oldAgentName)) {
      oldWorkerId = await resolveAgentToWorker(oldAgentName);
    }
    if (!isCategoryLabel(newAgentName)) {
      newWorkerId = await resolveAgentToWorker(newAgentName);
    }
    const froChanged = oldWorkerId !== newWorkerId && newWorkerId !== null;

    if (froChanged) {
      const newWorker = { id: newWorkerId };

      const amount = Number(receipt.amount || 0);

      // If there's a fro_donor_log linked, handle the assignment transfer
      if (receipt.log_id) {
        const { data: log } = await db
          .from('fro_donor_logs')
          .select('id, fro_worker_id, fro_assignments!inner(id, fro_worker_id, donor_id, ngo_id)')
          .eq('id', receipt.log_id)
          .maybeSingle();

        if (log) {
          const assignment = log.fro_assignments;

          // Detect cross-FRO receipt: verify_type = 'cross_fro' on the linked bank_audit_entry
          let isCrossFro = false;
          try {
            const { data: linkedEntry } = await db
              .from('bank_audit_entries')
              .select('verify_type')
              .eq('receipt_id', receiptId)
              .maybeSingle();
            isCrossFro = linkedEntry?.verify_type === 'cross_fro';
          } catch (_) {}

          // Reverse credit from old FRO's donor profile
          if (assignment?.donor_id && amount > 0) {
            try {
              const { data: donor } = await db
                .from('donor_profiles')
                .select('total_amount, donation_count')
                .eq('id', assignment.donor_id)
                .single();
              await db.from('donor_profiles').update({
                total_amount: Math.max(0, (donor?.total_amount || 0) - amount),
                donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
                updated_at: new Date().toISOString(),
              }).eq('id', assignment.donor_id);
            } catch (err) {
              console.error('Failed to reverse donor totals on receipt edit:', err.message);
            }
          }

          // Update fro_donor_log FRO (credit always moves)
          await db.from('fro_donor_logs').update({
            fro_worker_id: newWorker.id,
          }).eq('id', log.id);

          // For cross-FRO receipts: do NOT transfer the assignment — the donor stays
          // under their original FRO. Only credit moves via the log update above.
          if (!isCrossFro && assignment?.id) {
            await db.from('fro_assignments').update({
              fro_worker_id: newWorker.id,
            }).eq('id', assignment.id);
          }

          // Credit to new FRO's donor profile
          if (assignment?.donor_id && amount > 0) {
            try {
              const { data: donor } = await db
                .from('donor_profiles')
                .select('total_amount, donation_count')
                .eq('id', assignment.donor_id)
                .single();
              await db.from('donor_profiles').update({
                total_amount: Math.round(((donor?.total_amount || 0) + amount) * 100) / 100,
                donation_count: (donor?.donation_count || 0) + 1,
                updated_at: new Date().toISOString(),
              }).eq('id', assignment.donor_id);
            } catch (err) {
              console.error('Failed to credit new FRO donor totals on receipt edit:', err.message);
            }
          }
        }
      } else if (receipt.donor_id && amount > 0) {
        // No log_id but has donor_id — reverse and re-credit directly
        try {
          const { data: donor } = await db
            .from('donor_profiles')
            .select('total_amount, donation_count')
            .eq('id', receipt.donor_id)
            .single();
          // Reverse old
          await db.from('donor_profiles').update({
            total_amount: Math.max(0, (donor?.total_amount || 0) - amount),
            donation_count: Math.max(0, (donor?.donation_count || 0) - 1),
            updated_at: new Date().toISOString(),
          }).eq('id', receipt.donor_id);
          // Credit new (same donor_id since no assignment转移)
          await db.from('donor_profiles').update({
            total_amount: Math.round(((donor?.total_amount || 0) - amount + amount) * 100) / 100,
            donation_count: (donor?.donation_count || 0), // net zero since same profile
            updated_at: new Date().toISOString(),
          }).eq('id', receipt.donor_id);
        } catch (err) {
          console.error('Failed to handle no-log FRO change on receipt edit:', err.message);
        }
      }
    }

    // ── Amount change ripple: keep FRO log credit + donor totals in sync ──
    if (Math.abs(amountDelta) > 0.0001) {
      if (receipt.log_id) {
        try {
          await db.from('fro_donor_logs').update({ amount_collected: newAmount }).eq('id', receipt.log_id);
        } catch (err) {
          console.error('Failed to sync fro_donor_log amount on receipt edit:', err.message);
        }
      }
      let amountTargetDonorId = receipt.donor_id || null;
      if (receipt.log_id) {
        try {
          const { data: log } = await db
            .from('fro_donor_logs')
            .select('fro_assignments!inner(donor_id)')
            .eq('id', receipt.log_id)
            .maybeSingle();
          const assignment = Array.isArray(log?.fro_assignments) ? log.fro_assignments[0] : log?.fro_assignments;
          if (assignment?.donor_id) amountTargetDonorId = assignment.donor_id;
        } catch (err) {
          console.error('Failed to resolve donor for amount edit:', err.message);
        }
      }
      if (amountTargetDonorId) {
        try {
          const { data: donor } = await db
            .from('donor_profiles')
            .select('total_amount')
            .eq('id', amountTargetDonorId)
            .single();
          await db.from('donor_profiles').update({
            total_amount: Math.round(((donor?.total_amount || 0) + amountDelta) * 100) / 100,
            updated_at: new Date().toISOString(),
          }).eq('id', amountTargetDonorId);
        } catch (err) {
          console.error('Failed to adjust donor totals on amount edit:', err.message);
        }
      }
    }

    // Update the receipt
    const { data: updated, error: updErr } = await db
      .from('receipts')
      .update(receiptPatch)
      .eq('id', receiptId)
      .select()
      .single();
    if (updErr) throw updErr;

    // Update linked bank_audit_entry
    try {
      const { data: entry } = await db
        .from('bank_audit_entries')
        .select('id')
        .eq('receipt_id', receiptId)
        .maybeSingle();
      if (entry) {
        const entryPatch = { updated_at: new Date().toISOString() };
        // payer_name (bank statement name) is immutable here — same rule as
        // Manual Verify. Receipt/profile name edits never rewrite it.
        if ('donor_mobile' in receiptPatch) entryPatch.donor_mobile = receiptPatch.donor_mobile;
        if ('pan_number' in receiptPatch) entryPatch.donor_pan = receiptPatch.pan_number;
        if ('address' in receiptPatch) entryPatch.donor_address_1 = receiptPatch.address;
        if ('address_2' in receiptPatch) entryPatch.donor_address_2 = receiptPatch.address_2;
        if ('email' in receiptPatch) entryPatch.donor_email = receiptPatch.email;
        if ('agent_name' in receiptPatch) entryPatch.agent_name = receiptPatch.agent_name;
        if ('bank_name' in receiptPatch) entryPatch.bank_name = receiptPatch.bank_name;
        if ('mode' in receiptPatch) entryPatch.mode = receiptPatch.mode;
        if ('payment_id' in receiptPatch) entryPatch.payment_id = receiptPatch.payment_id;
        if ('amount' in receiptPatch) entryPatch.amount = receiptPatch.amount;
        if ('receipt_date' in receiptPatch) entryPatch.transaction_date = receiptPatch.receipt_date;
        if ('receipt_time' in receiptPatch) entryPatch.payment_time = receiptPatch.receipt_time;
        if (updates.received_bank) {
          const { data: src } = await db.from('bank_audit_sources').select('id').ilike('name', updates.received_bank).maybeSingle();
          if (src) entryPatch.source_id = src.id;
        }
        await db.from('bank_audit_entries').update(entryPatch).eq('id', entry.id);
      }
    } catch (err) {
      console.error('Failed to update linked bank audit entry:', err.message);
    }

    // Update donor_profiles
    // Unlinked receipt being edited: attach the profile that owns this mobile
    // number (exact 10-digit match) so the rename lands on the master record.
    let linkDonorId = receipt.donor_id || null;
    if (!linkDonorId) {
      const rawMob = String(receiptPatch.donor_mobile ?? receipt.donor_mobile ?? '').replace(/\D/g, '');
      if (rawMob.length >= 10) {
        const { data: profByMobile } = await db
          .from('donor_profiles').select('id').eq('mobile_number', rawMob.slice(-10)).maybeSingle();
        if (profByMobile) {
          linkDonorId = profByMobile.id;
          await db.from('receipts').update({ donor_id: linkDonorId }).eq('id', receiptId);
        }
      }
    }
    if (linkDonorId) {
      try {
        const dpPatch = { updated_at: new Date().toISOString() };
        // Never blank the master name: an emptied field on the modal must not
        // null out donor_profiles.name.
        if ('donor_name' in receiptPatch && String(receiptPatch.donor_name || '').trim() === '') {
          delete receiptPatch.donor_name;
        }
        const dpMap = {
          donor_name: 'name', donor_mobile: 'mobile_number', pan_number: 'pan_number',
          address: 'address_1', address_2: 'address_2', email: 'email',
          mobile_2: 'mobile_2', station: 'station',
        };
        for (const [rField, dpField] of Object.entries(dpMap)) {
          if (rField in receiptPatch) dpPatch[dpField] = receiptPatch[rField];
        }
        if (Object.keys(dpPatch).length > 1) {
          await db.from('donor_profiles').update(dpPatch).eq('id', linkDonorId);
        }
      } catch (err) {
        console.error('Failed to update donor profile on receipt edit:', err.message);
      }
    }

    const finalDonorId = linkDonorId || updated?.donor_id || null;
    if (finalDonorId && newAgentName && !['suspense', 'pg', 'library'].includes(newAgentName.toLowerCase())) {
      try {
        const worker = await resolveAgentToWorker(newAgentName);
        if (worker?.id) {
          await ensureAssignmentForDonorReceipt({
            receipt: { ...updated, donor_id: finalDonorId, agent_name: newAgentName, station: receiptPatch.station ?? updated.station ?? null },
            workerId: worker.id,
          });
        }
      } catch (err) {
        console.error('updateReceipt: assignment ensure failed (non-fatal):', err.message);
      }
    }

    return res.json({ receipt: updated, message: 'Receipt updated' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

const TARGETS_SETTING_KEY = 'accounts_report_targets';

// Compute working days from month start -> today for a given NGO.
// Working days = Mon-Sat days minus that NGO's holidays, PLUS one extra Sunday
// (the last Sunday of the month) once it has arrived (<= today).
export function computeReportWorkingDays({ month, today, ngoId, holidayDates, fullMonth }) {
  const [y, m] = month.split('-').map(Number);
  const todayT = today || new Date();
  const todayISO = `${todayT.getFullYear()}-${String(todayT.getMonth() + 1).padStart(2, '0')}-${String(todayT.getDate()).padStart(2, '0')}`;
  const lastDay = new Date(y, m, 0).getDate();
  const holiday = new Set((holidayDates || []).map((d) => String(d).slice(0, 10)));

  // last Sunday of the month
  let lastSunday = null;
  for (let d = lastDay; d >= 1; d--) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0) { lastSunday = d; break; }
  }
  const lastSundayISO = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(lastSunday).padStart(2, '0')}`;

  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const iso = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!fullMonth && iso > todayISO) break; // only count days up to today
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0) continue; // every Sunday off by default
    if (holiday.has(iso)) continue;
    count++;
  }
  // add the last Sunday of the month once it is <= today (always when fullMonth)
  if ((fullMonth || lastSundayISO <= todayISO) && !holiday.has(lastSundayISO)) count++;

  return { count, lastSundayISO };
}

// Working days left from tomorrow until the end of the selected month. Past
// months -> 0; future months -> the full month's working days. The current
// month keeps the working-Sunday rule: every Sunday except the last (working)
// counts as non-working, and configured holidays are excluded. `todayISO` is
// the IST date string YYYY-MM-DD.
function computeWorkingDaysLeft({ month, todayISO, holidayDates }) {
  const [y, m] = month.split('-').map(Number);
  const [ty, tm, td] = String(todayISO || '').split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const holiday = new Set((holidayDates || []).map((d) => String(d).slice(0, 10)));

  if (y > ty || (y === ty && m > tm)) {
    return computeReportWorkingDays({ month, holidayDates: [...holiday], fullMonth: true }).count;
  }
  if (y < ty || (y === ty && m < tm) || !td) return 0;
  if (td >= lastDay) return 0;

  let lastSunday = null;
  for (let d = lastDay; d >= 1; d--) {
    if (new Date(y, m - 1, d).getDay() === 0) { lastSunday = d; break; }
  }

  let left = 0;
  for (let d = td + 1; d <= lastDay; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 && d !== lastSunday) continue; // all Sundays except the last (working)
    if (holiday.has(iso)) continue;
    left++;
  }
  return left;
}

// GET /accounts/report-targets
export const getReportTargets = async (req, res) => {
  try {
    const raw = await getSetting(TARGETS_SETTING_KEY);
    const parsed = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
    return res.json({
      month: parsed?.month || new Date().toISOString().slice(0, 7),
      overall: Number(parsed?.overall) || 0,
      byNgo: parsed?.byNgo || {},
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// PUT /accounts/report-targets
export const putReportTargets = async (req, res) => {
  try {
    const { month, overall, byNgo } = req.body;
    const payload = {
      month: month || new Date().toISOString().slice(0, 7),
      overall: Number(overall) || 0,
      byNgo: byNgo || {},
    };
    await upsertSetting(TARGETS_SETTING_KEY, JSON.stringify(payload));
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// GET /accounts/report-data?month=YYYY-MM
export const getReportData = async (req, res) => {
  try {
    const requestedDate = (req.query.date || '').trim(); // YYYY-MM-DD (Day mode)
    let dayMode = false;
    let rangeMode = false;
    let day = '';
    const requestedFrom = (req.query.from || '').trim(); // YYYY-MM-DD
    const requestedTo = (req.query.to || '').trim();
    let requestedMonth = (req.query.month || '').trim();
    if (requestedDate) {
      dayMode = true;
      day = requestedDate.slice(0, 10);
      requestedMonth = day.slice(0, 7);
    }
    if (!dayMode && requestedFrom && requestedTo) {
      rangeMode = true;
      requestedMonth = String(requestedFrom).slice(0, 7);
    }
    if (!requestedMonth || !/^\d{4}-\d{2}$/.test(requestedMonth)) requestedMonth = new Date().toISOString().slice(0, 7);
    let [y, m] = requestedMonth.split('-').map(Number);
    if (!y || !m) {
      y = new Date().getFullYear();
      m = new Date().getMonth() + 1;
    }
    const month = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    const today = new Date();

    let dateFrom;
    let dateTo;
    if (rangeMode) {
      dateFrom = String(requestedFrom).slice(0, 10);
      dateTo = String(requestedTo).slice(0, 10);
      if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
    } else if (dayMode) {
      dateFrom = day;
      dateTo = day;
    } else {
      const lastDay = new Date(y, m, 0).getDate();
      dateFrom = `${month}-01`;
      dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;
    }

    const targetsRaw = await getSetting(TARGETS_SETTING_KEY);
    let savedTargets = null;
    if (targetsRaw) { try { savedTargets = JSON.parse(targetsRaw); } catch { savedTargets = null; } }
    const savedOverall = savedTargets && savedTargets.month === month ? (Number(savedTargets.overall) || 0) : 0;
    const savedByNgo = (savedTargets && savedTargets.month === month && savedTargets.byNgo) ? savedTargets.byNgo : {};

    // NGOs: ngos.id is a UUID; the canonical report key is the lowercase code
    // (bsct/aflf/mann) which is what bank_audit_entries.project_id uses.
    const { data: allNgos, error: naErr } = await db.from('ngos').select('id, name, code').eq('is_active', true);
    if (naErr) throw naErr;
    const slugOf = (n) => {
      if (!n) return null;
      const code = String(n.code || '').trim().toLowerCase();
      if (code) return code;
      const name = String(n.name || '').trim().toLowerCase();
      return name;
    };
    const uuidToSlug = {};
    const ngoList = [];
    const seen = {};
    for (const n of allNgos || []) {
      const slug = slugOf(n);
      uuidToSlug[n.id] = slug;
      if (slug && !seen[slug] && ['bsct', 'aflf', 'mann'].includes(slug)) {
        seen[slug] = true;
        ngoList.push({ id: slug, name: n.name });
      }
    }
    const ngoIds = ngoList.map((x) => x.id);
    if (ngoIds.length === 0) {
      for (const [slug, name] of [['bsct', 'BSCT'], ['aflf', 'AFLF'], ['mann', 'MANN']]) {
        ngoList.push({ id: slug, name });
        ngoIds.push(slug);
      }
    }

    // Report buckets drive the "NGO-wise Target vs Collection" ROWS. The first
    // three are the real NGOs (project_id keyed); library/pg are project buckets
    // (project_id = 'library' / 'pg') and suspense is an agent bucket
    // (agent_name = 'Suspense'). Each receipt lands in exactly one bucket:
    // suspense wins over any project.
    const reportBuckets = ['bsct', 'mann', 'aflf', 'pg', 'library', 'suspense'];
    const bucketLabel = {
      bsct: 'BSCT', mann: 'MANN', aflf: 'AFLF',
      pg: 'PG', library: 'Library', suspense: 'Suspense',
    };

    // "Collection by Payment Source" tabs: the three NGOs plus the library/pg/
    // suspense buckets (suspense is agent-based, not a project). Returned as a
    // SEPARATE `sourceTabs` list so `ngos`/`ngoIds` (driving the NGO target-form
    // and working-day logic) stay at just the three real NGOs.
    const realNgoName = {};
    for (const g of ngoList) realNgoName[g.id] = g.name;
    const sourceTabs = reportBuckets.map((t) => ({
      id: t,
      name: realNgoName[t] || bucketLabel[t] || t,
    }));
    const isSuspenseAgent = (agent) => {
      const a = String(agent || '').trim().toLowerCase();
      return a === 'suspense' || a === 'na' || a === '';
    };

    // Holiday per NGO (holidays.ngo_id is a UUID -> map via ngos)
    const { data: holidays, error: hErr } = await db.from('holidays').select('ngo_id, date').eq('type', 'holiday');
    if (hErr) throw hErr;
    const holidayByNgo = {};
    for (const n of ngoIds) holidayByNgo[n] = [];
    for (const h of holidays || []) {
      const slug = uuidToSlug[h.ngo_id];
      if (slug && holidayByNgo[slug]) holidayByNgo[slug].push(String(h.date).slice(0, 10));
    }

    const lastDay = new Date(y, m, 0).getDate();

    // NGO collection totals AND the per-payment-source split both come from the
    // RECEIPTS table (matching the Receipts page exactly). The payment source is
    // the receipt's `mode`; its subtotals sum to the full receipts collection.
    const receiptTotalByNgo = {};
    for (const n of reportBuckets) receiptTotalByNgo[n] = { count: 0, total: 0 };
    const { data: monthReceipts, error: rErr } = await db
      .from('receipts')
      .select('project_id, amount, mode, agent_name')
      .not('receipt_no', 'is', null)
      .gte('receipt_date', dateFrom)
      .lte('receipt_date', dateTo);
    if (rErr) throw rErr;

    const makeModeLabel = (m) => {
      const raw = String(m || '').trim();
      if (!raw) return 'Unknown';
      return formatModeLabel(raw);
    };

    const sourceOrder = [];
    const sourceSet = {};
    const byNgo = {};
    for (const n of reportBuckets) byNgo[n] = { sources: {} };
    // Bucket a receipt into exactly one row. Suspense is agent-based
    // (agent_name = 'Suspense'/'NA'/''); library/pg receipts are tagged only
    // by agent_name (their project_id is still 'bsct'), so check those before
    // falling back to the project_id bucket.
    const bucketReceipt = (r) => {
      const agent = String(r.agent_name || '').trim().toLowerCase();
      if (isSuspenseAgent(agent)) return 'suspense';
      if (agent === 'library') return 'library';
      if (agent === 'pg') return 'pg';
      const pid = String(r.project_id || '').trim().toLowerCase();
      return reportBuckets.includes(pid) ? pid : null;
    };
    for (const r of monthReceipts || []) {
      const ngo = bucketReceipt(r);
      if (!ngo) continue;
      receiptTotalByNgo[ngo].total += Number(r.amount || 0);
      receiptTotalByNgo[ngo].count += 1;
      const label = makeModeLabel(r.mode);
      const key = label.toLowerCase();
      if (!sourceSet[key]) { sourceSet[key] = true; sourceOrder.push(label); }
      byNgo[ngo].sources[label] = (byNgo[ngo].sources[label] || 0) + Number(r.amount || 0);
    }

    // Live "Today" collection per bucket (independent of the selected period).
    const todayByNgo = {};
    for (const n of reportBuckets) todayByNgo[n] = 0;
    const istNow = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const todayStr = istNow.toISOString().slice(0, 10);
    const { data: todayReceipts, error: tErr } = await db
      .from('receipts')
      .select('project_id, amount, agent_name')
      .not('receipt_no', 'is', null)
      .gte('receipt_date', `${todayStr}T00:00:00+05:30`)
      .lte('receipt_date', `${todayStr}T23:59:59.999+05:30`);
    if (tErr) throw tErr;
    for (const r of todayReceipts || []) {
      const ngo = bucketReceipt(r);
      if (!ngo) continue;
      todayByNgo[ngo] += Number(r.amount || 0);
    }

    // Build per-bucket output rows (bsct/mann/aflf/library/pg/suspense)
    const ngoRows = [];
    for (const n of reportBuckets) {
      const sourceTotal = Object.values(byNgo[n].sources).reduce((s, v) => s + v, 0);
      const total = receiptTotalByNgo[n].total;
      const receiptCount = receiptTotalByNgo[n].count;
      const ngoTarget = Number(savedByNgo[n]) || 0;
      const isNgo = ngoIds.includes(n);
      let workingDaysSoFar;
      let daysElapsed;
      if (!isNgo) {
        // library/pg/suspense have no NGO working-day / holiday model. Show the
        // collection buckets with no daily target; keep the elapsed-day count so
        // the "Avg/Day" column still reflects the reporting period.
        if (dayMode) {
          workingDaysSoFar = 0;
          daysElapsed = 1;
        } else if (rangeMode) {
          const start = new Date(dateFrom + 'T00:00:00Z');
          const end = new Date(dateTo + 'T00:00:00Z');
          daysElapsed = Math.round((end - start) / 86400000) + 1;
          workingDaysSoFar = 0;
        } else {
          workingDaysSoFar = 0;
          const [cy, cm] = [today.getFullYear(), today.getMonth() + 1];
          if (cy === y && cm === m) daysElapsed = today.getDate();
          else if (cy > y || (cy === y && cm > m)) daysElapsed = lastDay;
          else daysElapsed = 0;
        }
      } else if (dayMode) {
        // Single-day view: 1 working day if the chosen day is a working day
        const hset = new Set((holidayByNgo[n] || []).map((d) => String(d).slice(0, 10)));
        const dt = new Date(`${day}T00:00:00Z`);
        const dow = dt.getUTCDay();
        const isLastSunday = (() => {
          const lastD = new Date(y, m, 0).getDate();
          for (let d = lastD; d >= 1; d--) if (new Date(y, m - 1, d).getDay() === 0) return d;
          return null;
        })();
        const isSunday = dow === 0;
        const countedSunday = isSunday && Number(day.slice(8, 10)) === isLastSunday;
        const isWorkDay = (!isSunday || countedSunday) && !hset.has(day);
        workingDaysSoFar = isWorkDay ? 1 : 0;
        daysElapsed = 1;
      } else if (rangeMode) {
        // Custom From–To period: working days and elapsed days are counted across
        // the whole range (capped at today for partial/future ranges).
        const hset = new Set((holidayByNgo[n] || []).map((d) => String(d).slice(0, 10)));
        const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const end = new Date(dateTo + 'T00:00:00Z');
        const cap = todayISO < dateTo ? new Date(todayISO + 'T00:00:00Z') : end;
        let elapsed = 0;
        let wd = 0;
        for (let x = new Date(dateFrom + 'T00:00:00Z'); x <= cap; x.setUTCDate(x.getUTCDate() + 1)) {
          elapsed++;
          const iso = x.toISOString().slice(0, 10);
          const dow = x.getUTCDay();
          if (dow === 0) continue;
          if (hset.has(iso)) continue;
          wd++;
        }
        daysElapsed = elapsed;
        workingDaysSoFar = wd;
      } else {
        const { count } = computeReportWorkingDays({ month, today, ngoId: n, holidayDates: holidayByNgo[n], fullMonth: true });
        workingDaysSoFar = count;
        const [cy, cm] = [today.getFullYear(), today.getMonth() + 1];
        if (cy === y && cm === m) daysElapsed = today.getDate();
        else if (cy > y || (cy === y && cm > m)) daysElapsed = lastDay; // past months = full month
        else daysElapsed = 0; // future months
      }
      const targetDaily = workingDaysSoFar > 0 ? ngoTarget / workingDaysSoFar : 0;
      const actualAvg = daysElapsed > 0 ? total / daysElapsed : 0;
      const workingDaysFull = isNgo ? (computeReportWorkingDays({ month, holidayDates: holidayByNgo[n], fullMonth: true }).count || 0) : 0;
      const workingDaysLeft = isNgo ? computeWorkingDaysLeft({ month, todayISO: todayStr, holidayDates: holidayByNgo[n] }) : 0;
      const avgPerDay = workingDaysLeft > 0 ? Math.max(0, ngoTarget - total) / workingDaysLeft : 0;
      ngoRows.push({
        id: n,
        name: (ngoList.find((g) => g.id === n) || {}).name || bucketLabel[n] || n,
        total,
        receiptCount,
        sourceTotal,
        daysElapsed,
        workingDaysSoFar,
        workingDaysFull,
        workingDaysLeft,
        avgPerDay,
        targetDaily,
        actualAvg,
        diff: actualAvg - targetDaily,
        monthlyTarget: ngoTarget,
      });
    }

    // Full-month working-days breakdown (monthly view only), using the union of
    // all NGO holiday lists for a single headline figure. Working Days =
    // calendar days - all Sundays except the last (working) - holidays, with
    // the last Sunday counted unless it is itself a holiday.
    let workDays = null;
    if (!dayMode && !rangeMode) {
      const unionHolidays = new Set();
      for (const n of ngoIds) for (const h of holidayByNgo[n] || []) unionHolidays.add(String(h).slice(0, 10));
      let sundays = 0;
      for (let d = 1; d <= lastDay; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays++;
      const { count: workingDays, lastSundayISO } = computeReportWorkingDays({ month, holidayDates: [...unionHolidays], fullMonth: true });
      workDays = {
        calendarDays: lastDay,
        sundays,
        workingSundays: 1,
        workingDays,
        workingDaysLeft: computeWorkingDaysLeft({ month, todayISO: todayStr, holidayDates: [...unionHolidays] }),
        holidays: lastDay - sundays + 1 - workingDays,
        lastSundayISO,
      };
    }

    return res.json({
      month,
      mode: dayMode ? 'day' : (rangeMode ? 'range' : 'month'),
      day: dayMode ? day : null,
      from: rangeMode ? dateFrom : null,
      to: rangeMode ? dateTo : null,
      ngos: ngoList,
      sourceTabs,
      sourceOrder,
      byNgo,
      rows: ngoRows,
      overallTarget: savedOverall,
      byNgoTargets: savedByNgo,
      holidayByNgo,
      today: todayStr,
      todayByNgo,
      workDays,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// GET /accounts/report-agent-team  ->  { agents, teams, ngos, grandTotal, grandCount }
// Agent-wise = per-FRO collection (mirrors the NGO-admin /collections/fro-wise report);
// Team-wise  = same receipts grouped by workers.team (UFS1-UFS4). Both use the same
// month / day / from-to range and NGO (bsct/aflf/mann) scope as /report-data, and count
// each receipt once across the whole run so agent totals always sum to team totals.
const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export const getAgentTeamCollections = async (req, res) => {
  try {
    const requestedDate = (req.query.date || '').trim();
    const requestedFrom = (req.query.from || '').trim();
    const requestedTo = (req.query.to || '').trim();
    let requestedMonth = (req.query.month || '').trim();
    let dayMode = false;
    let rangeMode = false;
    let day = '';
    if (requestedDate) {
      dayMode = true;
      day = requestedDate.slice(0, 10);
      requestedMonth = day.slice(0, 7);
    }
    if (!dayMode && requestedFrom && requestedTo) {
      rangeMode = true;
      requestedMonth = String(requestedFrom).slice(0, 7);
    }
    if (!requestedMonth || !/^\d{4}-\d{2}$/.test(requestedMonth)) requestedMonth = new Date().toISOString().slice(0, 7);
    const [y, m] = requestedMonth.split('-').map(Number);
    const month = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;

    let dateFrom;
    let dateTo;
    if (rangeMode) {
      dateFrom = String(requestedFrom).slice(0, 10);
      dateTo = String(requestedTo).slice(0, 10);
      if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
    } else if (dayMode) {
      dateFrom = day;
      dateTo = day;
    } else {
      const lastDay = new Date(y, m, 0).getDate();
      dateFrom = `${month}-01`;
      dateTo = `${month}-${String(lastDay).padStart(2, '0')}`;
    }

    const { data: allNgos, error: naErr } = await db.from('ngos').select('id, name, code').eq('is_active', true);
    if (naErr) throw naErr;
    const slugOf = (n) => {
      if (!n) return null;
      const code = String(n.code || '').trim().toLowerCase();
      if (code) return code;
      const name = String(n.name || '').trim().toLowerCase();
      return name;
    };
    const ngoList = [];
    const seen = {};
    const uuidToSlug = {};
    for (const n of allNgos || []) {
      const slug = slugOf(n);
      uuidToSlug[String(n.id).toLowerCase()] = slug;
      if (slug && !seen[slug] && ['bsct', 'aflf', 'mann'].includes(slug)) {
        seen[slug] = true;
        ngoList.push({ id: slug, name: n.name });
      }
    }
    const ngoIds = ngoList.map((x) => x.id);
    if (ngoIds.length === 0) {
      for (const [slug, name] of [['bsct', 'BSCT'], ['aflf', 'AFLF'], ['mann', 'MANN']]) {
        ngoList.push({ id: slug, name });
        ngoIds.push(slug);
      }
    }
    const slugSet = new Set(ngoIds);
    const nameNormToSlug = {};
    for (const n of allNgos || []) {
      const slug = slugOf(n);
      if (!slug || !slugSet.has(slug)) continue;
      const nn = normKey(n.name);
      if (nn) nameNormToSlug[nn] = slug;
      if (nn.includes('sevak') || nn.includes('beingsevak')) nameNormToSlug['bsct'] = slug;
      if (nn.includes('ashray')) nameNormToSlug['aflf'] = slug;
      if (nn.includes('mann')) nameNormToSlug['mann'] = slug;
    }
    // Resolve a receipt's project_id (slug / ngo uuid / name) to a report NGO slug.
    const resolveNgo = (pid) => {
      if (!pid) return null;
      const low = String(pid).toLowerCase().trim();
      if (slugSet.has(low)) return low;
      if (uuidToSlug[low] && slugSet.has(uuidToSlug[low])) return uuidToSlug[low];
      const nn = normKey(pid);
      if (nameNormToSlug[nn]) return nameNormToSlug[nn];
      return null;
    };

    const { data: receipts, error: rErr } = await db
      .from('receipts')
      .select('id, project_id, amount, agent_name, receipt_no, donor_id, payment_id, receipt_date')
      .not('receipt_no', 'is', null)
      .gte('receipt_date', dateFrom)
      .lte('receipt_date', dateTo);
    if (rErr) throw rErr;

    const { data: froWorkers, error: fwErr } = await db
      .from('workers')
      .select('id, name, team')
      .eq('department', 'FRO')
      .eq('employment_status', 'active')
      .eq('is_test', false);
    if (fwErr) throw fwErr;
    const workerList = (froWorkers || []).filter((w) => w.id);
    const workerByKey = {};
    for (const w of workerList) {
      const k = normKey(w.name);
      if (k && !workerByKey[k]) workerByKey[k] = w;
    }

    const byNgo = (ngoIds) => {
      const o = {};
      for (const n of ngoIds) o[n] = 0;
      return o;
    };
    const agents = {};
    for (const w of workerList) {
      agents[w.id] = { id: w.id, name: w.name || w.login_id || 'Unknown', team: w.team || null, byNgo: byNgo(ngoIds), total: 0, count: 0, todayTotal: 0, todayCount: 0 };
    }
    agents.__unassigned = { id: null, name: 'No Agent', team: null, byNgo: byNgo(ngoIds), total: 0, count: 0, todayTotal: 0, todayCount: 0 };
    // Synthetic collector rows for receipts whose agent_name is a category label
    // (PG / Library / Suspense) rather than a real FRO worker. Each gets its own
    // row in the agent-wise list instead of being collapsed into "No Agent".
    const catAgents = ['pg', 'library', 'suspense'];
    for (const c of catAgents) {
      agents['__' + c] = { id: null, category: c, name: c[0].toUpperCase() + c.slice(1), team: null, byNgo: byNgo(ngoIds), total: 0, count: 0, todayTotal: 0, todayCount: 0 };
    }

    const seenReceipts = new Set();
    for (const r of receipts || []) {
      const amount = parseFloat(r.amount || 0);
      if (!(amount > 0)) continue;
      const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${String(r.receipt_date || '').slice(0, 10)}|${r.payment_id || ''}`;
      if (seenReceipts.has(dedupKey)) continue;
      seenReceipts.add(dedupKey);

      const ngo = resolveNgo(r.project_id);
      if (!ngo) continue;

      let agent = agents.__unassigned;
      const rawAgent = String(r.agent_name || '').trim();
      const rawAgentLower = rawAgent.toLowerCase();
      if (catAgents.includes(rawAgentLower)) {
        agent = agents['__' + rawAgentLower];
      } else if (rawAgent) {
        const canonical = await normalizeAgentName(rawAgent);
        const found = workerByKey[normKey(canonical)];
        if (found) agent = agents[found.id];
      }

      agent.byNgo[ngo] = (agent.byNgo[ngo] || 0) + amount;
      agent.total += amount;
      agent.count += 1;
    }

    // Today's collections (live, IST) for the "Today" column in the report.
    const istNow = new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
    const todayStr = istNow.toISOString().slice(0, 10);
    const { data: todayReceipts, error: trErr } = await db
      .from('receipts')
      .select('id, project_id, amount, agent_name, receipt_no, donor_id, payment_id, receipt_date')
      .not('receipt_no', 'is', null)
      .eq('receipt_date', todayStr);
    if (trErr) throw trErr;

    const seenToday = new Set();
    for (const r of todayReceipts || []) {
      const amount = parseFloat(r.amount || 0);
      if (!(amount > 0)) continue;
      const dedupKey = `${r.receipt_no || ''}|${r.donor_id || ''}|${amount}|${String(r.receipt_date || '').slice(0, 10)}|${r.payment_id || ''}`;
      if (seenToday.has(dedupKey)) continue;
      seenToday.add(dedupKey);

      const ngo = resolveNgo(r.project_id);
      if (!ngo) continue;

      let agent = agents.__unassigned;
      const rawAgent = String(r.agent_name || '').trim();
      const rawAgentLower = rawAgent.toLowerCase();
      if (catAgents.includes(rawAgentLower)) {
        agent = agents['__' + rawAgentLower];
      } else if (rawAgent) {
        const canonical = await normalizeAgentName(rawAgent);
        const found = workerByKey[normKey(canonical)];
        if (found) agent = agents[found.id];
      }

      agent.todayTotal = (agent.todayTotal || 0) + amount;
      agent.todayCount = (agent.todayCount || 0) + 1;
    }

    const agentRows = workerList
      .map((w) => agents[w.id])
      .concat(catAgents.map((c) => agents['__' + c]))
      .concat(agents.__unassigned)
      .filter((a) => a)
      .sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));

    // Team-wise rollup from the same agent data.
    const teamMap = {};
    for (const a of agentRows) {
      const team = a.team && String(a.team).trim() !== '' ? String(a.team).trim().toUpperCase() : null;
      if (!team) continue;
      if (!teamMap[team]) teamMap[team] = { team, members: 0, byNgo: byNgo(ngoIds), total: 0, count: 0, todayTotal: 0, todayCount: 0, memberNames: [] };
      teamMap[team].members += 1;
      teamMap[team].memberNames.push(a.name);
      for (const n of ngoIds) teamMap[team].byNgo[n] += a.byNgo[n] || 0;
      teamMap[team].total += a.total;
      teamMap[team].count += a.count;
      teamMap[team].todayTotal += a.todayTotal || 0;
      teamMap[team].todayCount += a.todayCount || 0;
    }
    const unassignedAgents = agentRows.filter((a) => !(a.team && String(a.team).trim() !== '') && a.id != null);
    let teams = Object.values(teamMap)
      .map((t) => ({ ...t, memberNames: undefined }))
      .sort((a, b) => b.total - a.total || String(a.team).localeCompare(String(b.team)));
    if (unassignedAgents.length > 0) {
      const u = { team: 'No Team', members: unassignedAgents.length, byNgo: byNgo(ngoIds), total: 0, count: 0, todayTotal: 0, todayCount: 0 };
      for (const a of unassignedAgents) {
        for (const n of ngoIds) u.byNgo[n] += a.byNgo[n] || 0;
        u.total += a.total;
        u.count += a.count;
        u.todayTotal += a.todayTotal || 0;
        u.todayCount += a.todayCount || 0;
      }
      teams = teams.concat(u);
    }

    const grandTotal = agentRows.reduce((s, a) => s + a.total, 0);
    const grandCount = agentRows.reduce((s, a) => s + a.count, 0);
    const grandTodayTotal = agentRows.reduce((s, a) => s + (a.todayTotal || 0), 0);
    const grandTodayCount = agentRows.reduce((s, a) => s + (a.todayCount || 0), 0);

    return res.json({
      month,
      mode: dayMode ? 'day' : (rangeMode ? 'range' : 'month'),
      day: dayMode ? day : null,
      from: rangeMode ? dateFrom : null,
      to: rangeMode ? dateTo : null,
      ngos: ngoList,
      agents: agentRows,
      teams,
      grandTotal,
      grandCount,
      today: todayStr,
      grandTodayTotal,
      grandTodayCount,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Per-user 4-digit access code gating downloads & the locked Reports/status pages.
// Each accounts user has their own code, stored in the settings table under a key
// derived from their id. Only accounts / super_admin can reach these routes
// (enforced at the router), and super_admin has no code.
const accessCodeKey = (userId) => `accounts_access_code_${userId}`;

const codeToStr = (v) => String(v ?? '').trim();

// GET /accounts/access-code/status -> { set: boolean }
export const getAccessCodeStatus = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.json({ set: false });
    const raw = await getSetting(accessCodeKey(req.user.id));
    return res.json({ set: Boolean(raw) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /accounts/access-code  { code } -> create if none exists
export const createAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.status(400).json({ message: 'Not authenticated.' });
    const existing = await getSetting(accessCodeKey(req.user.id));
    if (existing) return res.status(409).json({ message: 'Access code already set.' });
    const code = codeToStr(req.body?.code);
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ message: 'Code must be exactly 4 digits.' });
    await upsertSetting(accessCodeKey(req.user.id), code);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /accounts/access-code/verify  { code } -> { ok }
export const verifyAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.json({ ok: false, message: 'Not authenticated.' });
    const code = codeToStr(req.body?.code);
    const stored = await getSetting(accessCodeKey(req.user.id));
    if (!stored) return res.json({ ok: false, message: 'No access code set yet.' });
    return res.json({ ok: stored === code });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// POST /accounts/access-code/change  { currentCode, newCode } -> change own code
// Requires the current code so only the owner can rotate it, mirroring the
// password-change flow.
export const changeAccessCode = async (req, res) => {
  try {
    if (!req.user || req.user.id == null) return res.status(400).json({ message: 'Not authenticated.' });
    const currentCode = codeToStr(req.body?.currentCode);
    const newCode = codeToStr(req.body?.newCode);
    if (!/^\d{4}$/.test(newCode)) return res.status(400).json({ message: 'New code must be exactly 4 digits.' });
    const key = accessCodeKey(req.user.id);
    const stored = await getSetting(key);
    if (!stored) return res.status(404).json({ message: 'No access code set yet. Create one first.' });
    if (stored !== currentCode) return res.status(401).json({ message: 'Current access code is incorrect.' });
    await upsertSetting(key, newCode);
    return res.json({ ok: true, message: 'Access code changed successfully' });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
