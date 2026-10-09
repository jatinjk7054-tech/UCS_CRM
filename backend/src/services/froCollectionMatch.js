// One definition of "which receipts are this FRO's collection this month".
//
// Why this module exists. The FRO dashboard's "Collected" card and the "View
// collections" list it opens used to answer the same question with two different
// queries:
//
//   card  - models/froDonorLogModel.js getTotalCollectedByWorker
//           `.ilike('agent_name', name)`, plus a union of receipts whose
//           fro_donor_logs row was VERIFIED in the window, deduplicated by
//           receipt id and then by a composite payment key.
//   list  - controllers/froController.js getMyCollections
//           the receipts query only, no verified union.
//
// So the number on the card was not the sum of the rows beneath it. The card's
// own per-NGO chips made this visible: getCollectedByNgo matched with
// `lower(btrim(agent_name)) = $3` while the headline number matched with
// `ilike`, so a name needing a trim or a case fold landed in one and not the
// other, and the chips did not add up to the headline.
//
// This module owns the two decisions that were duplicated and disagreed:
//
//   1. matchReceiptsByAgentName() - case- and whitespace-insensitive equality,
//      escaped so `_` and `%` in a printed name are literal. `ilike` treats both
//      as wildcards, so an FRO named e.g. "Sneha_Patil" also matched
//      "SnehaXPatil" receipts and another FRO's money landed on their total.
//
//   2. paymentIdentity() - the dedup key. The old composite
//      (`receipt_no|donor_id|amount|receipt_date|payment_id`) treats a payment
//      with a null payment_id and no receipt_no as distinct from the identical
//      payment that has them, because the null collapses to the empty string on
//      one side only... and more importantly it treated the SAME payment recorded
//      twice with different receipt_no values as two payments. The bank-audit
//      import path and manual receipt creation both write receipts for one
//      payment, so the same donor's money was added to the total twice.
//
// Both helpers are pure and exported for tests; nothing here touches the DB.

// Postgres `lower(btrim(x))`, matched in JS so the two call sites cannot drift.
// Trimming first matters: receipts carry agent_name as free text typed by a
// human, so leading/trailing spaces are common and were silently dropping rows.
export const normalizeAgentName = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The set of agent_name values that count as this worker, given their canonical
 * name plus any curated spelling variants.
 *
 * Variants matter because migration 080 exists precisely because imported
 * receipts carry printed-name spellings ("Sushma Narendra Ambokar" vs "Sushma
 * Ambokar") that never matched the canonical name, so those donations were
 * never credited to the FRO who collected them. Alias rows are the curated
 * answer; this function just folds them into one comparable set.
 */
export function buildAgentNameMatches(canonicalName, aliasNames = []) {
  const out = new Set();
  const canonical = normalizeAgentName(canonicalName);
  if (canonical) out.add(canonical);
  for (const alias of aliasNames || []) {
    const n = normalizeAgentName(alias);
    if (n) out.add(n);
  }
  return out;
}

/**
 * True when a receipt's agent_name belongs to this worker.
 *
 * Equality on the normalized form, not a LIKE pattern. Escaping matters even
 * though this compares in JS: the caller passes the result straight into a SQL
 * LIKE when it queries, so the escaping has to happen before it leaves here.
 */
export function receiptMatchesAgentName(agentName, matches) {
  const n = normalizeAgentName(agentName);
  if (!n) return false;
  // A category label is never a person's collection, whatever else matches it.
  if (isCategoryLabel(n)) return false;
  if (matches instanceof Set) return matches.has(n);
  return normalizeAgentName(matches) === n;
}

/**
 * True when a receipt's agent_name names some OTHER real worker.
 *
 * The log fallback must never claim a receipt that agent_name already gave to a
 * different person. receipts.log_id is a link, not an owner: linking a bank
 * entry to a donor's pending hands the receipt that lead's log, whose
 * fro_worker_id is the assignment's FRO rather than the collector. Crediting
 * such a receipt here is how receipt 83746 (agent_name 'Mamta Shah', collected
 * under a station log) landed in a second FRO's total alongside money that was
 * genuinely hers.
 *
 * An agent label ('Agent 13') or a category label is NOT another person -- those
 * are precisely the rows the fallback exists to recover, since alias resolution
 * is not guaranteed. Only a name that resolves to a real worker blocks it.
 *
 * resolvers maps a normalized agent_name to the worker id it resolves to, so the
 * caller decides what "resolves to a real worker" means (exact name or curated
 * alias) and this stays a pure comparison.
 */
export function namesAnotherWorker(agentName, resolvers) {
  const n = normalizeAgentName(agentName);
  if (!n) return false;
  // Blank or a category label: no competing claim.
  if (isCategoryLabel(n)) return false;
  // An agent label ('Agent 13') resolves to a worker TOO, so it is in the
  // resolver set -- but it must not block the fallback, because when a label
  // fails to resolve the log is the only remaining evidence of who collected.
  // Blocking here would drop real collections, which is the one failure this
  // whole function exists to prevent. Only a name that is unambiguously some
  // other person's counts as a competing claim.
  if (isAgentLabel(n)) return false;
  if (resolvers instanceof Map) return resolvers.has(n);
  if (resolvers instanceof Set) return resolvers.has(n);
  return false;
}

/**
 * Merges the two row sets into one deduplicated collection.
 *
 * PRECEDENCE IS NAME FIRST, AND THE LOG IS A TRUE FALLBACK. This was log-first
 * and it was wrong; then it was name-first but still additive, which was also
 * wrong.
 *
 * receipts.log_id is a reliable LINK but not a reliable OWNER. When an operator
 * matches a bank entry to a donor's pending lead (bankAuditController.js:181),
 * the receipt inherits that lead's log, and log.fro_worker_id is whoever the
 * ASSIGNMENT belongs to -- not who collected the cash. A donor sitting on a
 * station gets a receipt stamped with the collector's name in agent_name while
 * the log points at the station's FRO. Trusting the log then credited one FRO
 * with another's collection, which is the exact bug this work set out to remove.
 *
 * So: agent_name wins whenever it resolves to a real person, because on the
 * bank-audit and suspense paths it is what the operator saw and confirmed in the
 * Edit Receipt form. The log is the fallback ONLY where agent_name gives no
 * person at all -- blank, or a category label ('Suspense'/'PG'/'Library'/'NA').
 *
 * `resolvers` maps a normalized agent_name to the worker id it resolves to for
 * ANY worker, not just this one. Without it the fallback stayed additive and
 * pulled another FRO's collection in: Varsha Tambe's card showed ~10,284 against
 * an actual 7,433, the difference being four BSCT receipts stamped 'Mamta Shah'
 * that her station's logs also touched. Passing that set is what makes the log a
 * genuine fallback rather than a second opinion that overrides the name.
 *
 * A receipt is then claimed exactly once, tagged with which signal claimed it.
 */
export function mergeAttributedReceipts(byName, byLogId, resolvers) {
  const out = [];
  const ids = new Set();
  const take = (rows, tag) => {
    for (const r of rows || []) {
      if (!r) continue;
      // A receipt always has an id (it is the table's primary key), so a row
      // without one means the caller handed us a malformed shape. Skipping it
      // would silently drop real money if that ever changed, so it is passed
      // through and left to payment-level dedup below.
      if (r.id != null) {
        const id = String(r.id);
        if (ids.has(id)) continue;
        ids.add(id);
      }
      out.push({ ...r, attributed_by: tag });
    }
  };
  take(byName, 'name');
  // The fallback yields to any receipt agent_name already gave to a real person.
  // This is the difference between "name wins" and "name wins and the log may
  // still add": without it, a receipt stamped with a colleague's name but linked
  // to this worker's station log is counted on both cards.
  take((byLogId || []).filter((r) => !namesAnotherWorker(r && r.agent_name, resolvers)), 'log');
  return dedupeCollectionReceipts(out);
}

/**
 * Escapes the wildcards in a LIKE/ILIKE pattern so a printed name containing
 * `_` or `%` is matched literally.
 */
export const escapeLikePattern = (value) =>
  String(value ?? '').replace(/([\\%_])/g, '\\$1');

// `pg`, `library` and `na` sit alongside 'suspense' in the category-label set the
// accounts report layer already treats as non-people (accountsController.js:6093).
// They are deliberately NEVER matched to a worker: the suspense flow depends on
// them staying unresolved so an unreconciled bank entry is not credited to an FRO
// who never collected it.
export const CATEGORY_LABELS = ['suspense', 'pg', 'library', 'na'];

/**
 * True when a value is a category label rather than a person's name.
 */
export const isCategoryLabel = (value) => CATEGORY_LABELS.includes(normalizeAgentName(value));

// CRM agent labels ("Agent 13"), written into receipts.agent_name by an agent's
// work-as switch (authController.js:960) and resolved back to the covered FRO
// through worker_aliases. Recognised by SHAPE, because the label text is
// admin-configurable (crmAgentModel.js:131 lets a label be overridden to anything)
// and must not be matched as a person name.
const AGENT_LABEL_RE = /^(agent|ag)\s*[:#-]?\s*\d+$/i;

/**
 * True when a value looks like a CRM agent label rather than a person's name.
 */
export const isAgentLabel = (value) => AGENT_LABEL_RE.test(normalizeAgentName(value));

/**
 * The identity of a payment, for deduplicating the same donation arriving by
 * two routes.
 *
 * This is the ORIGINAL composite key, restored deliberately. An earlier version
 * of this function treated payment_id as the authoritative identity, on the
 * assumption that it is a unique payment reference. On real data it is not: the
 * bank-audit import writes a free-text description into that column, so it holds
 * values like 'NA' (320 rows), '*Transfer' (264), 'UPI' (129) and
 * '#####################'. Treating those as identities collapsed every receipt
 * sharing one description into a single payment, which would have hidden ~500
 * real donations from one collector's total (Padmini alone would have lost 326).
 *
 * Nothing may be silently dropped from a collection total, so the key stays
 * composite: it is loose enough that a genuine payment keeps its own identity.
 * It can still merge two rows that agree on receipt number, donor, amount, date
 * and payment id -- that is the duplicate-payment case worth catching, and it is
 * visible rather than silent.
 */
export function paymentIdentity(receipt) {
  const r = receipt || {};
  const receiptNo = String(r.receipt_no ?? '').trim();
  const donorId = String(r.donor_id ?? '').trim();
  const paymentId = String(r.payment_id ?? '').trim();
  const amount = Number(r.amount ?? 0);
  const date = String(r.receipt_date ?? '').slice(0, 10);
  return `${receiptNo}|${donorId}|${amount}|${date}|${paymentId}`;
}

/**
 * Collapses rows that are the same payment, keeping the first.
 *
 * Deduplicates by receipt id first, so the same row reached by both attribution
 * windows is counted once. That is a hard invariant, not a judgement call: it
 * prevents double counting rather than hiding anything.
 *
 * The payment-identity pass afterwards is deliberately loose (see paymentIdentity)
 * and only collapses rows that agree on EVERY field of the composite key. A
 * non-positive amount is dropped because a zero or negative receipt is not
 * collection.
 */
export function dedupeCollectionReceipts(rows) {
  const seenIds = new Set();
  const seenPayments = new Set();
  const out = [];
  for (const r of rows || []) {
    if (!r) continue;
    const amount = Number(r.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const id = String(r.id ?? '').trim();
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    const identity = paymentIdentity(r);
    if (seenPayments.has(identity)) continue;
    seenPayments.add(identity);

    out.push({ ...r, amount });
  }
  return out;
}

/**
 * The single total both the card and the list must use: dedupe, then sum.
 */
export function totalCollectionAmount(rows) {
  return dedupeCollectionReceipts(rows).reduce((sum, r) => sum + Number(r.amount || 0), 0);
}