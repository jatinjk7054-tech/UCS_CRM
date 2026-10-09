// API client for the embedded Sevak Library admin panel. Reuses the CRM api()
// helper (auto Bearer token, JSON/FormData handling, 401→login redirect), so
// the panel is only reachable while logged into the HR / Accounts panel.

import { api } from '../../api/auth'

const P = '/sevak-library'

async function req(path, options = {}) {
  return api(path, { _prefix: 'ucs', ...options })
}

function queryString(params) {
  const q = new URLSearchParams()
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null && v !== '') q.set(k, String(v))
  })
  const s = q.toString()
  return s ? `?${s}` : ''
}

export async function listApplications({ q, status, page, limit } = {}) {
  const res = await req(`${P}/applications${queryString({ q, status, page, limit })}`)
  return res
}

export async function getDashboard() {
  const res = await req(`${P}/dashboard`)
  return res.data
}

// format 'data' → base64 data URLs (for the PDF renderer, which cannot draw
// cross-origin S3 photos onto a canvas); default → presigned URLs (display).
// Returns the {passport, identity, signature} object (or null) — the envelope
// is unwrapped here, every caller reads .passport / .signature off it directly.
export async function getPhotoUrls(applicationId, format) {
  const res = await req(`${P}/applications/${applicationId}/photo-url${format ? `?format=${format}` : ''}`)
  return res && res.data != null ? res.data : null
}

export async function updateApplication(id, data, transactionId, photos = {}) {
  const hasFiles =
    photos.passport instanceof File ||
    photos.identity instanceof File ||
    photos.signature instanceof File ||
    photos.removeSignature === true
  if (hasFiles) {
    const fd = new FormData()
    fd.append('data', JSON.stringify(data))
    if (transactionId) fd.append('transactionId', String(transactionId))
    if (photos.passport instanceof File) fd.append('passport', photos.passport)
    if (photos.identity instanceof File) fd.append('identity', photos.identity)
    if (photos.signature instanceof File) fd.append('signature', photos.signature)
    if (photos.removeSignature === true) fd.append('removeSignature', 'true')
    const res = await req(`${P}/applications/${id}`, { method: 'PUT', body: fd })
    return res.data
  }
  const res = await req(`${P}/applications/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ data, transactionId: transactionId || null }),
  })
  return res.data
}

export async function verifyApplication(id) {
  const res = await req(`${P}/applications/${id}/verify`, { method: 'POST', body: JSON.stringify({}) })
  return res.data
}

export async function approveApplication(id) {
  const res = await req(`${P}/applications/${id}/approve`, { method: 'POST', body: JSON.stringify({}) })
  return res.data
}

export async function rejectApplication(id, reason) {
  const res = await req(`${P}/applications/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) })
  return res.data
}

export async function renewApplication(id, { fee, transactionId, startDate } = {}) {
  const body = { transactionId: transactionId || '' }
  if (fee != null && fee !== '') body.fee = fee
  if (startDate) body.startDate = startDate
  const res = await req(`${P}/applications/${id}/renew`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return res.data
}

export async function removeApplication(id) {
  await req(`${P}/applications/${id}`, { method: 'DELETE' })
}

export async function resendMembershipEmail(id) {
  return req(`${P}/applications/${id}/emails/membership`, { method: 'POST', body: JSON.stringify({}) })
}

export async function sendPaymentReminder(id) {
  return req(`${P}/applications/${id}/emails/payment-reminder`, { method: 'POST', body: JSON.stringify({}) })
}

export async function getMailLog(limit = 500) {
  const res = await req(`${P}/applications/mail-log${queryString({ limit })}`)
  return res.data || []
}

export async function importMembers(rows) {
  const res = await req(`${P}/applications/import`, { method: 'POST', body: JSON.stringify({ rows }) })
  return res.data
}

export async function listCoupons() {
  const res = await req(`${P}/coupons`)
  return res.data || []
}

export async function createCoupon(values) {
  const res = await req(`${P}/coupons`, { method: 'POST', body: JSON.stringify(values) })
  return res.data
}

export async function updateCoupon(id, values) {
  const res = await req(`${P}/coupons/${id}`, { method: 'PUT', body: JSON.stringify(values) })
  return res.data
}

export async function deleteCoupon(id) {
  await req(`${P}/coupons/${id}`, { method: 'DELETE' })
}

export async function sendCouponEmail(couponId, applicationIds) {
  return req(`${P}/coupons/${couponId}/email`, {
    method: 'POST',
    body: JSON.stringify({ couponId, applicationIds }),
  })
}

export function exportApplicationsCsv(rows) {
  const headers = [
    'Reference', 'Status', 'Membership ID', 'Full Name', 'Email', 'Mobile',
    'Plan', 'Fee', 'Start Date', 'End Date', 'Identity Proof', 'Identity Number',
    'Transaction ID', 'Created At', 'Renewals', 'Renewal Fees', 'Last Renewed',
    'Renewal UTRs'
  ]
  const esc = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  rows.forEach((r) => {
    const utrs = Array.isArray(r.renewal_payments)
      ? r.renewal_payments.map((p) => p && p.txn).filter(Boolean).join('; ')
      : ''
    lines.push(
      [
        r.ref, r.status, r.membership_id, r.full_name, r.email, r.mobile,
        r.membership_type, r.membership_fee, r.start_date, r.end_date,
        r.identity_proof_type, r.identity_number, r.transaction_id, r.created_at,
        r.renewal_count || 0, r.renewal_fees || 0, r.last_renewed_at || '',
        utrs
      ].map(esc).join(',')
    )
  })
  return lines.join('\n')
}