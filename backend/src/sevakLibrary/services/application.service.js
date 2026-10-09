import crypto from 'crypto'
import db from '../config/supabase.js'
import { sql } from '../../config/db.js'
import { AppError } from '../middleware/errorHandler.js'

const S3_FOLDER = 'sevak-library'
const S3_STORAGE = () => db.storage.from(S3_FOLDER)

// Field mapping between the applicant-facing data object (what the form posts)
// and the denormalized columns on applications — mirror of submit_application.
const toRow = (data) => ({
  data: data || {},
  full_name: data?.fullName || null,
  email: data?.emailAddress || null,
  mobile: data?.mobileNumber || null,
  membership_type: data?.membershipType || null,
  membership_fee: toNullableNumber(data?.membershipFee),
  start_date: toNullableDate(data?.startDate),
  end_date: toNullableDate(data?.endDate),
  identity_proof_type: data?.identityProofType || null,
  identity_number: toNullableText(data?.identityNumber),
})

const toNullableNumber = (v) => (v == null || v === '' ? null : Number(v))
const toNullableDate = (v) => (v == null || v === '' ? null : v)
const toNullableText = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim())

const rand = (n) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n).toUpperCase()

const makeRef = () => {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `SL-${ymd}-${rand(6)}`
}

const makePaymentRef = () => `SEV${rand(8)}`

const publicProjection = ['ref', 'status', 'membership_id', 'full_name', 'created_at', 'payment_ref', 'membership_type', 'membership_fee', 'start_date', 'end_date']

const ensureRow = (result, notFoundMessage) => {
  if (result.error || result.data == null) throw new AppError(notFoundMessage || 'Application not found', 404)
  return result.data
}

const safeFileName = (name) => String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')

async function uploadPhoto(ref, key, file) {
  if (!file) return null
  const name = `${ref}/${key}_${Date.now()}_${safeFileName(file.originalname)}`
  const { error } = await S3_STORAGE().upload(name, file.buffer, { contentType: file.mimetype || 'application/octet-stream' })
  if (error) throw new AppError(`Upload failed (${key}): ${error.message}`, 400)
  return name
}

async function removePhotos(paths) {
  const list = (paths || []).filter(Boolean)
  if (list.length === 0) return
  const { error } = await S3_STORAGE().remove(list)
  if (error) throw new AppError(`Could not remove files: ${error.message}`, 500)
}

export async function submitApplication({ data = {}, passportFile, identityFile, signatureFile }) {
  const missing = ['fullName', 'emailAddress', 'mobileNumber', 'membershipType', 'membershipFee'].filter((k) => !data[k])
  if (missing.length) throw new AppError(`Required fields are missing: ${missing.join(', ')}`, 400)

  const ref = makeRef()
  const paymentRef = makePaymentRef()
  const passportPath = await uploadPhoto(ref, 'passport', passportFile)
  const identityPath = await uploadPhoto(ref, 'identity', identityFile)
  const signaturePath = await uploadPhoto(ref, 'signature', signatureFile)

  const { data: row, error } = await db.from('applications').insert({
    ref,
    payment_ref: paymentRef,
    passport_photo: passportPath,
    identity_photo: identityPath,
    signature_photo: signaturePath,
    ...toRow(data),
  }).select().single()

  if (error) throw new AppError(`Could not submit: ${error.message}`, 500)
  return row
}

// Matches get_application_by_ref — the resume-payment page reads these only.
export async function getApplicationByRef(ref) {
  const { data, error } = await db.from('applications')
    .select(publicProjection.join(','))
    .eq('ref', ref)
    .single()
  if (error) return null
  return data
}

// Matches record_payment.
export async function recordPayment(ref, transactionId) {
  const txn = String(transactionId || '').trim()
  if (!ref || !txn) throw new AppError('Application reference and transaction id are required', 400)
  const rows = await sql(
    `UPDATE public.applications
        SET transaction_id = $1,
            status = CASE WHEN status = 'SUBMITTED' THEN 'PAYMENT_SUBMITTED' ELSE status END,
            updated_at = now()
      WHERE ref = $2
      RETURNING *`,
    [txn, ref]
  )
  if (rows.length === 0) throw new AppError(`Application ${ref} not found`, 404)
  return rows[0]
}

export async function listApplications({ q, status, page = 1, limit = 50 } = {}) {
  let query = db.from('applications').select('*', { count: 'exact' })
  if (status) query = query.eq('status', status)
  if (q) {
    const term = String(q).trim().replace(/\*/g, '')
    if (term) query = query.or(`full_name.ilike.*${term}*,email.ilike.*${term}*,mobile.ilike.*${term}*,ref.ilike.*${term}*,membership_id.ilike.*${term}*`)
  }
  query = query.order('created_at', { ascending: false, nullsFirst: false }).order('id', { ascending: false })

  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)
  const from = (Math.max(parseInt(page, 10) || 1, 1) - 1) * pageSize
  const result = pageSize > 0 ? await query.range(from, from + pageSize - 1) : { data: [], count: 0, error: null }
  if (result.error) throw new AppError(result.error.message, 500)
  return { data: result.data, count: result.count || result.data.length, page: parseInt(page, 10) || 1, pageSize }
}

export async function getApplicationById(id) {
  const { data, error } = await db.from('applications').select('*').eq('id', id).single()
  return ensureRow({ data, error }, 'Application not found')
}

export async function verifyPayment(id) {
  const { data, error } = await db.from('applications').update({ status: 'VERIFIED', updated_at: new Date().toISOString() }).eq('id', id).select().single()
  return ensureRow({ data, error })
}

// Matches approve_application: keeps an existing membership_id (imported
// members), otherwise issues the next sequential SL-YYYY-NNNN.
export async function approveApplication(id) {
  const existing = await getApplicationById(id)
  let membershipId = existing.membership_id

  if (!membershipId) {
    const { rows } = await db._pool.query(
      `SELECT count(*)::int AS seq FROM public.applications WHERE status = 'APPROVED' AND membership_id IS NOT NULL`
    )
    const seq = (rows[0]?.seq || 0) + 1
    membershipId = `SL-${new Date().getFullYear()}-${String(seq).padStart(4, '0')}`
  }

  const { data, error } = await db.from('applications')
    .update({ status: 'APPROVED', membership_id: membershipId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  return ensureRow({ data, error })
}

// Matches reject_application.
export async function rejectApplication(id, reason) {
  const { data, error } = await db.from('applications')
    .update({ status: 'REJECTED', reject_reason: toNullableText(reason), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()
  return ensureRow({ data, error })
}

// Renewal math mirrors the applicant form's computeEndDate (formUtils.js):
// the plan is added to a base date with month-end clamping.
const PLAN_ADD = {
  Daily: { days: 1 },
  'Half Monthly': { days: 15 },
  Monthly: { months: 1 },
  Quarterly: { months: 3 },
  'Half-Yearly': { months: 6 },
  Annual: { months: 12 },
}

const toISODate = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const addPlanDuration = (isoDate, plan) => {
  const rule = PLAN_ADD[plan]
  if (!rule) return null
  const d = new Date(`${isoDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  if (rule.days) {
    d.setDate(d.getDate() + rule.days)
    return toISODate(d)
  }
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + rule.months)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return toISODate(d)
}

// Renewal start date is editable. Accepts an ISO YYYY-MM-DD from the client and
// validates it; returns null when the value is blank/invalid so callers can
// fall back to the auto-computed base.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const parseISODate = (value) => {
  const s = String(value ?? '').trim()
  if (!ISO_DATE.test(s)) return null
  const d = new Date(`${s}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : s
}

// True renewal: extends the SAME row (keeps membership_id) instead of issuing a
// second membership for the same person. Base = the operator-chosen renewal
// start date when supplied, else whichever is later — the current end date
// (early renewal keeps the remaining days; renewing 9 Sep on a 7 Sep–7 Oct
// Monthly membership ends 7 Nov, not 9 Oct) or today (renewing after expiry
// starts the new period from today). Also records the fee as renewal revenue,
// appends the fee + UTR to renewal_payments history, and re-arms both reminder
// emails (advance expiry + post-expiry) for the new end date. The UTR of the
// original application payment is never touched.
export async function renewApplication(id, { fee, transactionId, startDate } = {}) {
  const row = await getApplicationById(id)
  if (row.status !== 'APPROVED') throw new AppError('Only approved memberships can be renewed', 400)
  if (!row.membership_type) throw new AppError('This application has no membership plan', 400)

  // Every renewal payment carries its own UTR — recorded in renewal_payments
  // history, never overwriting the original application's transaction_id.
  const txn = String(transactionId ?? '').trim()
  if (!txn) throw new AppError('Transaction / UTR id is required', 400)
  if (txn.length > 64) throw new AppError('Transaction / UTR id must be 64 characters or fewer', 400)

  const today = new Date().toISOString().slice(0, 10)
  const providedStart = String(startDate ?? '').trim()
  if (providedStart && !parseISODate(providedStart)) {
    throw new AppError('Renewal start date must be a valid date (YYYY-MM-DD)', 400)
  }
  const base = providedStart
    ? parseISODate(providedStart)
    : row.end_date && row.end_date >= today
      ? row.end_date
      : today
  const newEnd = addPlanDuration(base, row.membership_type)
  if (!newEnd) throw new AppError(`Cannot compute renewal dates for plan "${row.membership_type}"`, 400)

  const parsedFee = fee == null || fee === '' ? NaN : Number(fee)
  const amount = Number.isFinite(parsedFee) && parsedFee >= 0 ? parsedFee : Number(row.membership_fee) || 0

  const history = Array.isArray(row.renewal_payments) ? row.renewal_payments : []
  const { data, error } = await db.from('applications')
    .update({
      end_date: newEnd,
      renewal_count: (Number(row.renewal_count) || 0) + 1,
      renewal_fees: (Number(row.renewal_fees) || 0) + amount,
      renewal_payments: [...history, { date: today, amount, txn, start_date: base, end_date: newEnd }],
      last_renewed_at: today,
      renewal_email_sent: false,
      renewal_soon_sent: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select()
    .single()
  return ensureRow({ data, error })
}

// Matches update_application + replaceable photos (0007/0008).
export async function updateApplication(id, { data, transactionId, passportFile, identityFile, removePassport, removeIdentity, signatureFile, removeSignature }) {
  const existing = await getApplicationById(id)

  let passportPath = existing.passport_photo
  let identityPath = existing.identity_photo
  let signaturePath = existing.signature_photo

  if (passportFile) {
    const uploaded = await uploadPhoto(existing.ref, 'passport', passportFile)
    if (existing.passport_photo && existing.passport_photo !== uploaded) await removePhotos([existing.passport_photo])
    passportPath = uploaded
  } else if (removePassport) {
    await removePhotos([existing.passport_photo])
    passportPath = null
  }

  if (identityFile) {
    const uploaded = await uploadPhoto(existing.ref, 'identity', identityFile)
    if (existing.identity_photo && existing.identity_photo !== uploaded) await removePhotos([existing.identity_photo])
    identityPath = uploaded
  } else if (removeIdentity) {
    await removePhotos([existing.identity_photo])
    identityPath = null
  }

  if (signatureFile) {
    const uploaded = await uploadPhoto(existing.ref, 'signature', signatureFile)
    if (existing.signature_photo && existing.signature_photo !== uploaded) await removePhotos([existing.signature_photo])
    signaturePath = uploaded
  } else if (removeSignature) {
    await removePhotos([existing.signature_photo])
    signaturePath = null
  }

  const txnId = toNullableText(transactionId)
  const updates = {
    ...toRow(data || existing.data),
    passport_photo: passportPath,
    identity_photo: identityPath,
    signature_photo: signaturePath,
    transaction_id: txnId || existing.transaction_id,
    updated_at: new Date().toISOString(),
  }
  // Entering a transaction id counts as recording the payment (record_payment).
  if (txnId && existing.status === 'SUBMITTED') updates.status = 'PAYMENT_SUBMITTED'
  const { data: row, error } = await db.from('applications').update(updates).eq('id', id).select().single()

  return ensureRow({ data: row, error })
}

export async function deleteApplication(id) {
  const existing = await getApplicationById(id)
  await removePhotos([existing.passport_photo, existing.identity_photo, existing.signature_photo])
  const { error } = await db.from('applications').delete().eq('id', id).select()
  if (error) throw new AppError(error.message, 500)
  return existing
}

// Matches import_members (0012): inserted as PAYMENT_SUBMITTED (awaiting
// verification), membership IDs issued up-front, duplicates by mobile skipped.
export async function importMembers(rows) {
  if (!Array.isArray(rows)) throw new AppError('Rows must be an array', 400)

  const { rows: baseRows } = await db._pool.query(
    `SELECT count(*)::int AS seq FROM public.applications WHERE status = 'APPROVED' AND membership_id IS NOT NULL`
  )
  let base = baseRows[0]?.seq || 0
  let imported = 0
  let skipped = 0

  for (const r of rows) {
    if (toNullableText(r.mobile) == null) { skipped++; continue }
    const exists = await sql(`SELECT 1 FROM public.applications WHERE mobile = $1 LIMIT 1`, [r.mobile])
    if (exists.length) { skipped++; continue }

    base++
    const year = new Date().getFullYear()
    const { error } = await db.from('applications').insert({
      ref: makeRef(),
      data: r.data || {},
      full_name: r.fullName || null,
      mobile: r.mobile,
      membership_type: r.membershipType || null,
      membership_fee: toNullableNumber(r.membershipFee),
      start_date: toNullableDate(r.startDate),
      end_date: toNullableDate(r.endDate),
      status: 'PAYMENT_SUBMITTED',
      membership_id: `SL-${year}-${String(base).padStart(4, '0')}`,
    })
    if (error) {
      skipped++
      continue
    }
    imported++
  }

  return { imported, skipped }
}

export async function getMailLog({ limit = 100 } = {}) {
  const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500)
  const { data, error } = await db.from('mail_log').select('*').order('created_at', { ascending: false }).limit(pageSize)
  if (error) throw new AppError(error.message, 500)
  return data
}

export async function getDashboardStats() {
  const statusRows = await sql(`SELECT status, count(*)::int AS count FROM public.applications GROUP BY status`)
  const byStatus = Object.fromEntries(statusRows.map((r) => [r.status, r.count]))
  const expiring = await sql(
    `SELECT id, ref, full_name, email, mobile, membership_id, membership_type, end_date
       FROM public.applications
      WHERE status = 'APPROVED' AND renewal_email_sent = false AND end_date <= CURRENT_DATE
      ORDER BY end_date`
  )
  const coupons = await sql(`SELECT count(*)::int AS count FROM public.coupons`)
  return {
    total: statusRows.reduce((sum, r) => sum + r.count, 0),
    byStatus,
    expiringSoon: expiring,
    couponCount: coupons[0]?.count || 0,
  }
}

// Content type for a stored photo key — upload() keeps the original extension,
// so the suffix is enough for an img data URL.
const photoMime = (path) => {
  const ext = String(path).toLowerCase().split('.').pop()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

// format='data' returns base64 data URLs instead of presigned links. The PDF
// renderer (html2canvas) draws the photo onto a canvas, and cross-origin S3
// URLs without a bucket CORS policy taint/fail that draw — the on-screen <img>
// works either way, so only the PDF path asks for data.
export async function getPhotoUrl(rowId, { format } = {}) {
  const app = await getApplicationById(rowId)
  const result = { passport: null, identity: null, signature: null }
  for (const key of ['passport', 'identity', 'signature']) {
    const path = app[`${key}_photo`]
    if (!path) continue
    if (format === 'data') {
      const { data: buf, error } = await S3_STORAGE().download(path)
      if (error) throw new AppError(error.message, 500)
      if (buf) result[key] = `data:${photoMime(path)};base64,${Buffer.from(buf).toString('base64')}`
    } else {
      const { data, error } = await S3_STORAGE().presignDownload(path, 3600)
      if (error) throw new AppError(error.message, 500)
      result[key] = data.url
    }
  }
  return result
}