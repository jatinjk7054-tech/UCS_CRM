import db from '../config/db.js';
import { getNextReceiptNo, projectCodeFromNgoId } from '../models/bankAuditModel.js';
import { findReceiptByLogId } from '../models/receiptModel.js';
import { sendPushNotification } from './fcmService.js';
import { resolveOperatorName } from './operatorNameService.js';

// Credit a bank audit entry whose suggested match (matched_lead_log_id) was
// confirmed by Accounts. Links the entry's generated receipt (or creates one)
// to the donor + lead, credits donor totals and the FRO's collected, and closes
// the open assignment. Idempotent: refuses to double-credit.
//
// If the matched lead was ALREADY processed (e.g. Accounts verified it through
// the Lead Verification flow, setting the assignment to donation_collected),
// the lead's money is already credited — so we just settle the bank entry so it
// leaves suspense: mark it verified and link it to the existing receipt, only
// creating a new receipt (and crediting donor totals) when no receipt exists
// for that money yet.
export const confirmMatchCredit = async (entryId, actorId) => {
  const { data: entry, error: eErr } = await db
    .from('bank_audit_entries')
    .select('*')
    .eq('id', entryId)
    .maybeSingle();
  if (eErr) throw eErr;
  if (!entry) return { error: 404, message: 'Entry not found' };
  if (entry.status === 'verified') return { error: 409, message: 'This entry is already verified' };
  if (!entry.matched_lead_log_id || entry.match_status !== 'matched') {
    return { error: 409, message: 'No pending match to confirm for this entry' };
  }

  const logId = entry.matched_lead_log_id;
  const { data: logs, error: lErr } = await db
    .from('fro_donor_logs')
    .select(`
      id, amount_collected, action, disposition_detail, accounts_status, fro_worker_id, operator_id, payment_mode,
      fro_assignments!inner(
        id, fro_worker_id, donor_id, ngo_id,
        ngos(name),
        donor_profiles!inner(id, name, mobile_number, email, pan_number, address_1, address_2, city, pin_code, project_supported, mop, donors_bank_name),
        workers!left(id, name)
      )
    `)
    .eq('id', logId)
    .limit(1);
  if (lErr) throw lErr;
  if (!logs || logs.length === 0) return { error: 404, message: 'Matched lead not found' };
  const log = logs[0];

  const assignment = log.fro_assignments;
  const donor = assignment?.donor_profiles;
  const donorId = assignment?.donor_id;
  if (!donorId || !donor) return { error: 400, message: 'Matched lead is missing donor info' };

  const logProcessed = log.accounts_status !== 'pending';
  const existingLogReceipt = logProcessed ? await findReceiptByLogId(log.id) : null;

  // The NGO the matched lead is assigned under decides the receipt project and
  // therefore the receipt-number sequence. donor_profiles.project_supported is
  // often unset, and the 'bsct' default is what made Ashray money take the next
  // number from the BSCT sequence.
  let project = donor?.project_supported || entry.project_id || 'bsct';
  try { project = await projectCodeFromNgoId(assignment?.ngo_id) || project; }
  catch (err) { console.error('Failed to resolve project from assignment NGO:', err.message); }

  const amount = Number(entry.amount || 0);
  const now = new Date().toISOString();
  const date = entry.transaction_date || new Date().toISOString().slice(0, 10);

  // Credit names come from whoever ACTUALLY collected. That is the log's
  // operator_id during a Work As / cover session (the person at the keyboard);
  // fro_worker_id is the covered FRO and is only the answer when no operator
  // was recorded. The assignment owner is the last fallback.
  let collectorName = null;
  // Label, not human name: receipts.agent_name is the collection grouping key
  // and the claim-time stamp already writes the agent's label.
  const operatorName = await resolveOperatorName(log.operator_id);
  if (operatorName?.label || operatorName?.name) {
    collectorName = operatorName.label || operatorName.name;
  } else if (log.fro_worker_id) {
    if (String(log.fro_worker_id) === String(assignment?.fro_worker_id)) {
      collectorName = assignment?.workers?.name || null;
    } else {
      const { data: cwRow } = await db.from('workers').select('name').eq('id', log.fro_worker_id).maybeSingle();
      collectorName = cwRow?.name || null;
    }
  }
  if (!collectorName) collectorName = assignment?.workers?.name || null;

  const result = await db.transaction(async ({ from }) => {
    const workerName = collectorName;
    const entryPayer = String(entry.payer_name || '').trim() || null;
    const entryAgent = String(entry.agent_name || '').trim() || null;
    const donorAddress = [donor.address_1, donor.address_2].filter(Boolean).join(', ') || null;
    const bankName = entry.bank_name || donor.donors_bank_name || null;

    await from('bank_audit_entries').update({
      status: 'verified',
      donor_id: donorId,
      match_status: 'confirmed',
      matched_by: actorId,
      matched_at: now,
      updated_at: now,
      payer_name: entryPayer || donor.name || null,
      donor_mobile: entry.donor_mobile || donor.mobile_number || null,
      donor_email: entry.donor_email || donor.email || null,
      donor_pan: entry.donor_pan || donor.pan_number || null,
      donor_address_1: entry.donor_address_1 || donor.address_1 || null,
      donor_address_2: entry.donor_address_2 || donor.address_2 || null,
      donor_city: entry.donor_city || donor.city || null,
      donor_pin_code: entry.donor_pin_code || donor.pin_code || null,
      agent_name: entryAgent || workerName || null,
      bank_name: bankName,
    }).eq('id', entry.id);

    if (!logProcessed) {
      await from('fro_donor_logs').update({
        accounts_status: 'verified',
        verified_at: now,
        verified_by: actorId,
      }).eq('id', log.id);

      await from('fro_assignments').update({
        status: 'donation_collected',
        last_contacted_at: now,
      }).eq('id', assignment.id);
    }

    // Credit donor totals when this money is genuinely new: normal flow, or the
    // lead was already processed but no receipt exists for the entry yet.
    const needNewReceipt = !entry.receipt_id && !existingLogReceipt;
    if (!logProcessed || needNewReceipt) {
      const { data: donorRow } = await from('donor_profiles')
        .select('total_amount, donation_count, last_donation_date')
        .eq('id', donorId)
        .single();
      await from('donor_profiles').update({
        total_amount: Math.round(((donorRow?.total_amount || 0) + amount) * 100) / 100,
        donation_count: (donorRow?.donation_count || 0) + 1,
        last_donation_date: !donorRow?.last_donation_date || date > donorRow.last_donation_date ? date : donorRow.last_donation_date,
        updated_at: now,
      }).eq('id', donorId);
    }

    let receipt = null;
    const mode = log.payment_mode || donor.mop || (entry.payment_id ? 'UPI' : 'Bank');

    // Fresh receipt for this money when no linked/existing receipt can be used.
    const buildFreshReceipt = async () => {
      const receiptNo = await getNextReceiptNo(project);
      const { data: created, error: insErr } = await from('receipts').insert({
        log_id: logProcessed ? null : log.id,
        receipt_no: receiptNo,
        project_id: project,
        donor_name: donor.name || entry.payer_name || 'Unknown',
        donor_mobile: donor.mobile_number || null,
        pan_number: donor.pan_number || entry.donor_pan || null,
        address: donorAddress || entry.donor_address_1 || null,
        email: donor.email || entry.donor_email || null,
        agent_name: workerName || entry.agent_name || null,
        mode: mode || null,
        amount,
        payment_id: entry.payment_id || null,
        bank_name: bankName,
        receipt_date: date,
        receipt_time: entry.payment_time || null,
        purpose: 'Bank Audit Match',
        generated_by: actorId,
        donor_id: donorId,
      }).select().single();
      if (insErr) throw new Error(`Failed to create receipt for credited entry: ${insErr.message}`);
      return created;
    };

    if (entry.receipt_id) {
      // Reuse the entry's linked receipt (e.g. the suspense receipt the FRO
      // claimed). The update can return data=null on no-match/error, which used
      // to crash on `updated.receipt_no` — handle it defensively.
      const { data: existingRcpt } = await from('receipts').select('donor_name, bank_payer_name, project_id, receipt_no').eq('id', entry.receipt_id).maybeSingle();
      const profileName = donor.name || null;
      const oldPayerName = existingRcpt?.donor_name && existingRcpt.donor_name !== profileName ? existingRcpt.donor_name : entry.payer_name || null;
      const receiptPatch = {
        donor_id: donorId,
        log_id: log.id,
        project_id: existingRcpt?.project_id || project,
        donor_name: donor.name || entry.payer_name || 'Unknown',
        bank_payer_name: existingRcpt?.bank_payer_name || oldPayerName || null,
        donor_mobile: donor.mobile_number || null,
        pan_number: donor.pan_number || entry.donor_pan || null,
        address: donorAddress || entry.donor_address_1 || null,
        email: donor.email || entry.donor_email || null,
        agent_name: workerName || entry.agent_name || null,
        mode: mode || null,
        payment_id: entry.payment_id || null,
        receipt_time: entry.payment_time || null,
        bank_name: bankName,
      };
      const { data: updated, error: updErr } = await from('receipts').update(receiptPatch).eq('id', entry.receipt_id).select().single();
      if (updErr || !updated) {
        // Update failed (receipt deleted, constraint violation, ...). If the
        // receipt is still there just reuse what we can; if it is truly gone,
        // fall through and create a fresh receipt for this money.
        const { data: reRead } = await from('receipts').select('*').eq('id', entry.receipt_id).maybeSingle();
        if (reRead) {
          const { data: reUpd, error: reErr } = await from('receipts').update(receiptPatch).eq('id', entry.receipt_id).select().single();
          receipt = (!reErr && reUpd) ? reUpd : reRead;
          console.error('Receipt update on credit failed, reused existing:', updErr?.message || 'no rows');
        } else {
          console.error('Linked receipt missing on credit, creating a fresh one:', updErr?.message || 'no rows');
        }
      } else {
        receipt = updated;
      }
      if (receipt && !receipt.receipt_no) {
        const receiptNo = await getNextReceiptNo(existingRcpt?.project_id || project);
        const { data: numbered, error: numErr } = await from('receipts').update({ receipt_no: receiptNo }).eq('id', entry.receipt_id).select().single();
        if (numErr) console.error('Failed to allocate receipt no on credit:', numErr.message);
        receipt = numbered || receipt;
      }
      if (!receipt) receipt = await buildFreshReceipt();
    } else if (existingLogReceipt) {
      // Money already receipted + credited via the earlier lead verification.
      await from('bank_audit_entries').update({ receipt_id: existingLogReceipt.id }).eq('id', entry.id);
      const { data: updated, error: updErr } = await from('receipts').update({
        donor_id: donorId,
        bank_name: bankName,
        address: donorAddress || null,
      }).eq('id', existingLogReceipt.id).select().single();
      if (updErr) console.error('Failed to patch existing log receipt on credit:', updErr.message);
      receipt = updated || existingLogReceipt;
    } else {
      receipt = await buildFreshReceipt();
    }

    if (receipt?.id) {
      await from('bank_audit_entries').update({
        receipt_id: receipt.id,
        receipt_no: receipt.receipt_no || null,
      }).eq('id', entry.id);
    }

    return { donor_id: donorId, log_id: log.id, amount, receipt_no: receipt?.receipt_no || null, receipt_id: receipt?.id || null };
  });

  const froWorkerId = log.fro_worker_id || assignment?.fro_worker_id;
  if (!logProcessed && froWorkerId) {
    try {
      const notifTitle = 'Lead Verified';
      const notifBody = `Your lead for ${donor.name || 'donor'} (\u20B9${amount.toLocaleString('en-IN')}) was verified. Receipt: ${result.receipt_no || ''}`;
      let fcmLogged = false;
      try {
        const pushResult = await sendPushNotification(froWorkerId, notifTitle, notifBody, 'lead_verified', log.id);
        fcmLogged = !!pushResult;
      } catch (err) { console.error('FCM send error:', err.message); }
      if (!fcmLogged) {
        await db.from('notification_log').insert({
          worker_id: froWorkerId,
          type: 'lead_verified',
          title: notifTitle,
          body: notifBody,
          fro_donor_log_id: String(log.id),
          sent_at: now,
        });
      }
    } catch (err) { console.error('Failed to create verified notification:', err.message); }
  }

  return { ...result, message: logProcessed ? 'Match confirmed and entry settled' : 'Match confirmed and credited' };
};
