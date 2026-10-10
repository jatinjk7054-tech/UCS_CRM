import { useState, useEffect, useMemo, useRef } from 'react';
import { Inbox, Search, ChevronRight, Phone } from 'lucide-react';
import { getSuspenseReceipts, claimSuspenseReceipt, searchDonorsByMobile, searchSuspenseDonors } from '../api/donors';
import { useRealtime } from '../../../hooks/useRealtime';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { SkeletonTable } from '../../../components/Skeleton';
import LeadWave from '../../accounts/components/LeadWave';
import moneyMp3 from '../../../assets/audio/money.mp3';

// Shared 0.8s money chime for new suspense arrivals. One instance so rapid
// arrivals restart from zero instead of stacking over each other.
const moneyAudio = new Audio(moneyMp3);
moneyAudio.preload = 'auto';

const currency = n => n != null ? '\u20B9' + Number(n).toLocaleString('en-IN') : '\u2014';

const fieldStyle = { width: '100%', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s' };

function fmtTime12(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return String(t);
  const ap = h >= 12 ? 'PM' : 'AM';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
}

const CLAIM_BADGES = {
  pending: { text: 'Claimed · Pending', color: '#b45309', bg: '#fef3c7' },
  verified: { text: 'Claim Verified', color: '#166534', bg: '#dcfce7' },
  rejected: { text: 'Claim Rejected', color: '#b91c1c', bg: '#fee2e2' },
  receipt_sent: { text: 'Receipt Sent · Awaiting FRO', color: '#0369a1', bg: '#e0f2fe' },
};

const NGO_LABELS = { bsct: 'Being Sevak', mann: 'Mann Care', aflf: 'Ashray' };
const NGO_SHORT = { bsct: 'BSCT', mann: 'MANN', aflf: 'AFLF' };
const NGO_PILL = {
  bsct: { bg: '#d4e4ff', color: '#1e40af' },
  mann: { bg: '#ecc9df', color: '#be185d' },
  aflf: { bg: '#c8ecd4', color: '#166534' },
};

const initials = (name) => (name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

// Stable identity for the suspense pool. The pool keys rows by r.id normally,
// but a row's id CHANGES when someone claims it: an unclaimed entry shows as
// `entry-{entry_id}`, then the claim links a receipt so the same bank-audit
// entry re-appears as `{receipt_id}` (or drops out once credited). Chime + wave
// detection must key on the entry id so claiming never looks like a brand-new
// suspense arrival.
const suspenseKey = (r) => {
  const entryId = r && (r.entry_id ?? r._bank_audit_entry_id);
  if (entryId != null) return String(entryId);
  return r && r.id != null ? String(r.id) : '';
};

// Newest-first order for the suspense pool. Falls back to 0 when there is no
// usable date/time so those sink to the bottom of the list.
const recencyMs = (r) => {
  const d = (r && (r.receipt_date || r.transaction_date)) ? new Date((r.receipt_date || r.transaction_date) + (r.receipt_time || r.payment_time ? 'T' + (r.receipt_time || r.payment_time) : '')) : null;
  if (d && !isNaN(d.getTime())) return d.getTime();
  if (r && r.created_at) { const c = new Date(r.created_at); if (!isNaN(c.getTime())) return c.getTime(); }
  return 0;
};

export default function FroSuspense() {
  const isMobile = useIsMobile()
  const isCompact = useIsMobile(480)
  const [month, setMonth] = useState('');
  const [receipts, setReceipts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [ngoFilter, setNgoFilter] = useState('');
  const [query, setQuery] = useState('');
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [claimReceipt, setClaimReceipt] = useState(null);
  const [claimDonor, setClaimDonor] = useState(null);
  const [claimSearch, setClaimSearch] = useState('');
  const [claimResults, setClaimResults] = useState([]);
  const [claimSearching, setClaimSearching] = useState(false);
  const claimTimer = useRef(null);
  const [claimUpi, setClaimUpi] = useState('');
  const [claimDate, setClaimDate] = useState('');
  const [claimTime, setClaimTime] = useState('');
  const [claimNotes, setClaimNotes] = useState('');
  const [claimError, setClaimError] = useState('');
  const [claimSuccess, setClaimSuccess] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimDName, setClaimDName] = useState('');
  const [claimDMobile, setClaimDMobile] = useState('');
  const [claimDCity, setClaimDCity] = useState('');
  const [claimDAddress, setClaimDAddress] = useState('');
  const [claimDPan, setClaimDPan] = useState('');
  const [claimDEmail, setClaimDEmail] = useState('');

  const load = async () => {
    try {
      const data = await getSuspenseReceipts();
      setMonth(data?.month || '');
      setReceipts(data?.receipts || []);
    } catch (err) {
      console.error('API error:', err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSuspenseReceipts();
        if (!cancelled) {
          setMonth(data?.month || '');
          setReceipts(data?.receipts || []);
        }
      } catch (err) { console.error('API error:', err.message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  useRealtime('bank_audit_entries', {
    event: '*',
    onInsert: () => load(),
    onUpdate: () => load(),
    onDelete: () => load(),
  });

  useRealtime('receipts', {
    event: '*',
    onInsert: () => load(),
    onUpdate: () => load(),
    onDelete: () => load(),
  });

  // Wave animation for newly-arrived suspense receipts only. The first real
  // load is treated as the baseline (no animation); only the single newest
  // receipt that appears afterwards gets the square wave, exactly once per id.
  const seenIdsRef = useRef(null);
  const [newIds, setNewIds] = useState(() => new Set());
  const moneyTimerRef = useRef(null);
  const moneyPendingRef = useRef(false);

  const stopMoney = () => {
    if (moneyTimerRef.current) { clearTimeout(moneyTimerRef.current); moneyTimerRef.current = null; }
    moneyAudio.pause();
  };

  const playMoney = () => {
    moneyPendingRef.current = false;
    stopMoney();
    moneyAudio.currentTime = 0;
    const p = moneyAudio.play();
    if (p && p.catch) {
      p.catch(() => {
        // Browsers block audio until the page has received a user gesture;
        // queue it so the chime plays on the user's next click/tap/keypress.
        moneyPendingRef.current = true;
        console.warn('money chime autoplay blocked; will play on next interaction');
      });
    }
    moneyTimerRef.current = setTimeout(() => moneyAudio.pause(), 800);
  };

  // First user gesture unlocks audio playback (autoplay policy) and flushes any
  // chime that was queued while playback was blocked.
  useEffect(() => {
    const unlock = () => {
      if (moneyPendingRef.current) {
        moneyPendingRef.current = false;
        stopMoney();
        moneyAudio.currentTime = 0;
        moneyAudio.play().catch(() => {});
        moneyTimerRef.current = setTimeout(() => moneyAudio.pause(), 800);
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
      if (moneyTimerRef.current) clearTimeout(moneyTimerRef.current);
      moneyAudio.pause();
    };
  }, []);

  useEffect(() => {
    if (loading) return;
    const ids = (receipts || []).map(suspenseKey);
    if (!seenIdsRef.current) {
      seenIdsRef.current = new Set(ids);
      return;
    }
    const fresh = [];
    for (const id of ids) {
      if (!seenIdsRef.current.has(id)) {
        seenIdsRef.current.add(id);
        fresh.push(id);
      }
    }
    if (fresh.length === 0) return;
    const newest = (receipts || []).filter(r => fresh.includes(suspenseKey(r))).reduce(
      (m, r) => (recencyMs(r) > recencyMs(m) ? r : m),
      null
    );
    if (!newest) return;
    const id = suspenseKey(newest);
    playMoney();
    setNewIds(prev => {
      const n = new Set(prev);
      n.add(id);
      return n;
    });
  }, [receipts, loading]);

  const dropNew = (id) => {
    setNewIds(prev => {
      const n = new Set(prev);
      n.delete(String(id));
      return n;
    });
  };

  const openClaimModal = (r) => {
    setClaimReceipt(r);
    setClaimDonor(null);
    setClaimSearch('');
    setClaimResults([]);
    setClaimUpi('');
    setClaimDate('');
    setClaimTime('');
    setClaimNotes('');
    setClaimError('');
    setClaimSuccess(false);
    setClaimDName('');
    setClaimDMobile('');
    setClaimDCity('');
    setClaimDAddress('');
    setClaimDPan('');
    setClaimDEmail('');
    setShowClaimModal(true);
  };

  const searchClaimDonors = (q) => {
    setClaimSearch(q);
    clearTimeout(claimTimer.current);
    if ((q || '').trim().length < 2) { setClaimResults([]); setClaimSearching(false); return; }
    claimTimer.current = setTimeout(async () => {
      setClaimSearching(true);
      try {
        const [profileRes, receiptRes] = await Promise.all([
          searchDonorsByMobile(q.trim()).catch(() => []),
          searchSuspenseDonors(q.trim()).catch(() => []),
        ]);
        const profileList = Array.isArray(profileRes) ? profileRes : [];
        const receiptList = Array.isArray(receiptRes) ? receiptRes : [];
        const merged = [];
        const seenById = new Set();
        const seenByMobile = new Set();
        for (const d of profileList) {
          merged.push(d);
          if (d.donor_id) seenById.add(String(d.donor_id));
          const m = (d.donor_mobile || '').replace(/\D/g, '');
          if (m) seenByMobile.add(m);
        }
        for (const d of receiptList) {
          if (d.donor_id && seenById.has(String(d.donor_id))) continue;
          const m = (d.donor_mobile || '').replace(/\D/g, '');
          if (m && seenByMobile.has(m)) continue;
          merged.push(d);
          if (d.donor_id) seenById.add(String(d.donor_id));
          if (m) seenByMobile.add(m);
        }
        setClaimResults(merged);
      } catch (err) {
        setClaimResults([]);
      } finally {
        setClaimSearching(false);
      }
    }, 350);
  };

  const submitClaim = async () => {
    if (!claimReceipt) return;
    if (!claimDonor) { setClaimError('Select the donor to claim this receipt'); return; }
    setClaiming(true);
    setClaimError('');
    try {
      let txDatetime = null;
      if (claimDate) txDatetime = claimTime ? `${claimDate}T${claimTime}` : claimDate;
      await claimSuspenseReceipt(claimReceipt.id, {
        donor_id: claimDonor.donor_id,
        donor_name: claimDName.trim() || undefined,
        donor_mobile: claimDMobile.trim() || undefined,
        donor_city: claimDCity.trim() || undefined,
        donor_email: claimDEmail.trim() || undefined,
        donor_pan: claimDPan.trim() || undefined,
        donor_address: claimDAddress.trim() || undefined,
        upi_transaction_id: (claimUpi || '').trim() || undefined,
        transaction_datetime: txDatetime || undefined,
        notes: claimNotes.trim() || undefined,
      });
      setClaimSuccess(true);
      const data = await getSuspenseReceipts();
      setMonth(data?.month || '');
      setReceipts(data?.receipts || []);
      setTimeout(() => setShowClaimModal(false), 1200);
    } catch (err) {
      setClaimError(err.message);
    } finally {
      setClaiming(false);
    }
  };

  const ngos = [...new Set((receipts || []).map(r => r.project_id).filter(Boolean))];

  const list = useMemo(() => {
    let base = [...(receipts || [])];
    if (ngoFilter === '__unclaimed') base = base.filter(r => r.pool === 'unclaimed');
    else base = base.filter(r => r.pool !== 'unclaimed' && (!ngoFilter || r.project_id === ngoFilter));
    const q = query.trim().toLowerCase();
    if (q) base = base.filter(r =>
      (r.donor_name || '').toLowerCase().includes(q) ||
      (r.donor_mobile || '').includes(q) ||
      (r.receipt_no || '').toLowerCase().includes(q) ||
      (r.payment_id || '').toLowerCase().includes(q)
    );
    return base.sort((a, b) => recencyMs(b) - recencyMs(a));
  }, [receipts, ngoFilter, query]);

  const totalAmount = list.reduce((s, r) => s + Number(r.amount || 0), 0);

  if (loading) return <div style={{ padding: 18 }}><SkeletonTable rows={8} /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        @keyframes froPulse {
          0%, 100% { transform: scale(1); box-shadow: 0 2px 8px rgba(91,107,78,.22); }
          50% { transform: scale(1.045); box-shadow: 0 4px 16px rgba(91,107,78,.4); }
        }
        @keyframes froWaveWipe {
          from { clip-path: inset(0 100% 0 0); }
          to { clip-path: inset(0 0 0 0); }
        }
        @keyframes froWaveSweep {
          from { transform: translateX(108%); }
          to { transform: translateX(-108%); }
        }
        .fro-wave-bg {
          position: absolute; inset: 0; z-index: 0; border-radius: inherit; pointer-events: none;
          clip-path: inset(0 0 0 0);
        }
        .fro-wave-bg.is-waving {
          animation: froWaveWipe 1.15s ease-out .12s forwards;
        }
        .fro-wave {
          position: absolute; inset: 0; z-index: 1; overflow: hidden; border-radius: inherit; pointer-events: none;
          animation: froWaveSweep 1.05s linear .05s forwards;
        }
        .fro-wave-sq { position: absolute; display: block; border-radius: 0; }
        @media (prefers-reduced-motion: reduce) {
          .fro-wave { display: none; }
          .fro-wave-bg.is-waving { animation: none; clip-path: inset(0 0 0 0); }
        }
      `}</style>
      {/* Toolbar: NGO pill tabs + search */}
      <div style={{ padding: isCompact ? '10px 12px 6px' : '14px 18px 8px', flexShrink: 0, minWidth: 0 }}>
        <div style={{ display: 'flex', width: '100%', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 10, padding: 3, overflowX: 'auto', minWidth: 0 }}>
          {[['', 'All'], ['__unclaimed', 'Unclaimed']].concat(ngos.map(p => [p, NGO_SHORT[p] || p.toUpperCase()])).map(([v, l]) => {
            const count = v === '__unclaimed'
              ? receipts.filter(r => r.pool === 'unclaimed').length
              : receipts.filter(r => r.pool !== 'unclaimed' && (!v || r.project_id === v)).length;
            const active = ngoFilter === v;
            return (
              <button key={v || 'all'} onClick={() => setNgoFilter(v)}
                style={{
                  flex: isCompact ? '0 0 auto' : 1, padding: '5px 10px', borderRadius: 999, border: 'none', fontFamily: 'inherit',
                  fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, whiteSpace: 'nowrap',
                  background: active ? 'var(--sage)' : 'transparent', color: active ? '#fff' : 'var(--ink-soft)',
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,.18)' : 'none', transition: 'all .15s', flexShrink: 0,
                }}>
                {l}
                <span style={{
                  minWidth: 16, padding: '0 4px', borderRadius: 999, fontSize: 9, fontWeight: 700,
                  background: active ? 'rgba(255,255,255,.22)' : 'var(--line)', color: active ? '#fff' : 'var(--ink-soft)',
                }}>{count}</span>
              </button>
            );
          })}
        </div>

        <div style={{ position: 'relative', marginTop: 10 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-soft)' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search name or mobile…"
            style={{
              width: '100%', padding: '8px 12px 8px 32px', border: '1px solid var(--line)', borderRadius: 10, background: 'var(--card-bg)',
              fontSize: 12, fontFamily: 'inherit', outline: 'none', color: 'var(--ink)', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: isCompact ? '2px 10px 10px' : '2px 18px 18px' }}>
        {list.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', minHeight: 220, gap: 10, color: 'var(--ink-soft)' }}>
            <span style={{ width: 54, height: 54, borderRadius: '50%', background: 'var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Inbox size={24} />
            </span>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{query ? 'No matching receipts' : 'No suspense receipts'}{ngoFilter === '__unclaimed' ? ' in the unclaimed pool' : ngoFilter ? ' for this NGO' : ''}</div>
            <div style={{ fontSize: 11 }}>{query ? 'Try a different name or mobile number.' : 'New suspense receipts will appear here.'}</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map(r => {
              const badge = r.pool === 'unclaimed'
                ? { text: 'Unclaimed', color: '#92400e', bg: '#fef3c7' }
                : r.waiting_receipt_no ? { text: 'Waiting for receipt number', color: '#6b7280', bg: '#f3f4f6' } : r.kind === 'receipt_sent' ? CLAIM_BADGES.receipt_sent : r.my_claim_status ? CLAIM_BADGES[r.my_claim_status] : null;
              const claimable = !r.waiting_receipt_no && (!r.my_claim_status || r.kind === 'receipt_sent');
              const amtStr = currency(r.amount);
              const amtW = isCompact ? 78 : 96;
              const amtFont = amtStr.length >= 12 ? (isCompact ? 8 : 10) : amtStr.length >= 10 ? (isCompact ? 9 : 11) : amtStr.length >= 8 ? (isCompact ? 10 : 12.5) : amtStr.length >= 6 ? (isCompact ? 11.5 : 13.5) : (isCompact ? 13 : 15);
              const isNew = newIds.has(suspenseKey(r));
              const pill = NGO_PILL[r.project_id] || { bg: 'var(--card-bg)' };
              const isUnclaimed = r.pool === 'unclaimed';
              return (
                <div key={r.id} onClick={() => claimable && openClaimModal(r)}
                  onMouseOver={e => { e.currentTarget.style.borderColor = 'var(--sage)'; e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,.08)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseOut={e => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.boxShadow = 'var(--shadow)'; e.currentTarget.style.transform = 'none'; }}
                  style={{
                    position: 'relative', overflow: 'hidden',
                    display: 'flex', alignItems: 'center', gap: isCompact ? 8 : 12, padding: isCompact ? '10px 10px' : '12px 14px',
                    background: isUnclaimed ? pill.bg : (isNew ? 'var(--card-bg)' : pill.bg), border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)',
                    boxShadow: 'var(--shadow)', cursor: claimable ? 'pointer' : 'default', transition: 'transform .12s, box-shadow .12s, border-color .12s',
                  }}>
                  {isNew && (
                    <LeadWave animate bg={pill.bg} square={pill.color || '#1e40af'} seed={suspenseKey(r)} cls="fro" onDone={() => dropNew(suspenseKey(r))} />
                  )}
                  <div style={{ position: 'relative', zIndex: 2, display: 'flex', alignItems: 'center', gap: isCompact ? 8 : 12, flex: 1, minWidth: 0 }}>
                    <div style={{ width: isCompact ? 34 : 40, height: isCompact ? 34 : 40, borderRadius: '50%', background: '#B5603A1A', color: '#B5603A', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: isCompact ? 12 : 14, fontWeight: 700, flexShrink: 0 }}>
                      {initials(r.donor_name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.donor_name || 'Unknown donor'}</span>
                        <span style={{
                          padding: '2px 7px', borderRadius: 6, fontSize: 10, fontWeight: 700, flexShrink: 0,
                          background: (NGO_PILL[r.project_id] || { bg: '#f3f4f6', color: '#6b7280' }).bg,
                          color: (NGO_PILL[r.project_id] || { bg: '#f3f4f6', color: '#6b7280' }).color,
                        }}>{NGO_SHORT[r.project_id] || NGO_LABELS[r.project_id] || r.project_id}</span>
                        {badge && (
                          <span style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: badge.bg, color: badge.color }}>
                            {badge.text}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
                        {r.receipt_date || '\u2014'}{r.receipt_time ? ` | ${fmtTime12(r.receipt_time)}` : ''}
                      </div>
                      {r.payment_id && (
                        <div style={{ fontSize: 11, marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
                          <span style={{ color: 'var(--ink-soft)' }}>UPI:</span>
                          <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{r.payment_id}</span>
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      {claimable ? (
                        <button
                          onClick={e => { e.stopPropagation(); openClaimModal(r); }}
                          style={{ width: amtW, maxWidth: '100%', fontSize: amtFont, fontWeight: 700, color: '#fff', background: 'var(--sage)', padding: isCompact ? '5px 8px' : '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', animation: 'froPulse 1.6s ease-in-out infinite', transition: 'transform .15s, box-shadow .15s' }}
                          onMouseOver={e => { e.currentTarget.style.transform = 'scale(1.06)'; e.currentTarget.style.boxShadow = '0 6px 18px rgba(91,107,78,.45)'; }}
                          onMouseOut={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.boxShadow = 'none'; }}>
                          {amtStr}
                        </button>
                      ) : (
                        <div style={{ width: amtW, textAlign: 'right', fontSize: amtFont, fontWeight: 700, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{amtStr}</div>
                      )}
                      {r.claim_count > 1 && !claimable && (
                        <div style={{ fontSize: 10, color: 'var(--ink-soft)' }}>{r.claim_count} claims</div>
                      )}
                    </div>{claimable && <ChevronRight size={isCompact ? 14 : 16} style={{ color: 'var(--ink-soft)', flexShrink: 0 }} />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showClaimModal && claimReceipt && (
        <div onClick={() => { if (!claiming && !claimSuccess) setShowClaimModal(false) }} style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', backdropFilter: 'blur(4px)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 16, width: isCompact ? 'calc(100vw - 20px)' : isMobile ? 'calc(100vw - 32px)' : 480, maxWidth: '100%', maxHeight: '90vh', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ padding: isCompact ? '16px 16px' : '20px 24px', borderBottom: '1px solid var(--line)', background: 'linear-gradient(135deg, #f8fafc 0%, #fff 100%)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--sage)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18 }}>
                  <Inbox size={18} />
                </div>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>Claim Suspense Receipt</div>
                  <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>Link this receipt to a donor for verification</div>
                </div>
              </div>
            </div>

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: isCompact ? 16 : 24 }}>
              {claimSuccess ? (
                <div style={{ textAlign: 'center', padding: '32px 20px' }}>
                  <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#166534', marginBottom: 6 }}>Claim Submitted Successfully</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>This receipt is now pending in Lead Verification</div>
                </div>
              ) : (
                <>
                  {/* Receipt Summary */}
                  <div style={{ background: 'linear-gradient(135deg, #fef3c7 0%, #fde68a 100%)', borderRadius: 12, padding: '16px 18px', marginBottom: 20, border: '1px solid #fbbf24' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Receipt Details</div>
                      <div style={{ fontSize: 10, color: '#92400e', opacity: 0.7 }}>{NGO_SHORT[claimReceipt.project_id] || claimReceipt.project_id}</div>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#78350f', marginBottom: 4 }}>{claimReceipt.donor_name || 'Unknown donor'}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 11, color: '#92400e' }}>
                      <span>{claimReceipt.receipt_date || '—'}</span>
                      {claimReceipt.receipt_time && <span>· {fmtTime12(claimReceipt.receipt_time)}</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 18, fontWeight: 800, color: '#78350f' }}>{currency(claimReceipt.amount)}</span>
                    </div>
                  </div>

                  {/* Donor Selection */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Select Donor</div>
                    {claimDonor ? (
                      <div style={{ background: '#f0fdf4', border: '2px solid var(--sage)', borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--sage)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700 }}>
                            {initials(claimDonor.donor_name)}
                          </div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{claimDonor.donor_name}</div>
                            <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 2 }}>
                              {claimDonor.donor_mobile || '—'}
                              {claimDonor.donor_city && <span> · {claimDonor.donor_city}</span>}
                            </div>
                          </div>
                        </div>
                        <button onClick={() => { setClaimDonor(null); setClaimSearch(''); setClaimResults([]); setClaimDName(''); setClaimDMobile(''); setClaimDCity(''); setClaimDAddress(''); setClaimDPan(''); setClaimDEmail('') }}
                          style={{ border: 'none', background: 'rgba(0,0,0,.05)', width: 28, height: 28, borderRadius: '50%', fontSize: 18, cursor: 'pointer', color: 'var(--ink-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ position: 'relative', marginBottom: 8 }}>
                          <Search size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-soft)' }} />
                          <input
                            value={claimSearch}
                            onChange={e => searchClaimDonors(e.target.value)}
                            placeholder="Search by donor name or mobile number..."
                            style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s' }}
                            onFocus={e => e.target.style.borderColor = 'var(--sage)'}
                            onBlur={e => e.target.style.borderColor = 'var(--line)'}
                          />
                        </div>
                        {claimSearching && (
                          <div style={{ fontSize: 11, color: 'var(--ink-soft)', textAlign: 'center', padding: '12px 0' }}>
                            <span style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid var(--line)', borderTopColor: 'var(--sage)', borderRadius: '50%', animation: 'spin 0.6s linear infinite', marginRight: 6 }} />
                            Searching donors...
                          </div>
                        )}
                        {!claimSearching && claimResults.length > 0 && (
                          <div style={{ border: '1px solid var(--line)', borderRadius: 10, maxHeight: 180, overflowY: 'auto', background: 'var(--card-bg)' }}>
                            {claimResults.map((d, i) => (
                              <div key={d.donor_id} onClick={() => { setClaimDonor(d); setClaimResults([]); setClaimDName(d.donor_name || ''); setClaimDMobile(d.donor_mobile || ''); setClaimDCity(d.donor_city || ''); setClaimDAddress(d.donor_address || ''); setClaimDPan(d.donor_pan || ''); setClaimDEmail(d.donor_email || '') }}
                                style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: i < claimResults.length - 1 ? '1px solid var(--line)' : 'none', display: 'flex', alignItems: 'center', gap: 10, transition: 'background .1s' }}
                                onMouseOver={e => e.currentTarget.style.background = 'var(--bg)'}
                                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                                <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--sage)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                                  {initials(d.donor_name)}
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{d.donor_name}</div>
                                  <div style={{ fontSize: 10.5, color: 'var(--ink-soft)', marginTop: 1 }}>{d.donor_mobile || ''}{d.donor_city ? ` · ${d.donor_city}` : ''}</div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {!claimSearching && claimSearch.trim().length >= 2 && claimResults.length === 0 && (
                          <div style={{ padding: '16px', border: '1.5px dashed var(--line)', borderRadius: 10, textAlign: 'center', fontSize: 11, color: 'var(--ink-soft)', background: 'var(--bg)' }}>
                            <div style={{ fontSize: 20, marginBottom: 4 }}>🔍</div>
                            No donor found for "{claimSearch}"
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {/* Donor Details — editable, prefilled from the selected donor,
                      written onto the Accounts audit entry with the claim */}
                  {claimDonor && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                        Donor Details
                        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', marginLeft: 6, color: 'var(--ink-soft)' }}>— editable, shown on the Accounts audit entry</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                          <input value={claimDName} onChange={e => setClaimDName(e.target.value)} placeholder="Full name" style={{ ...fieldStyle, flex: '1.4 1 120px' }} />
                          <input value={claimDMobile} onChange={e => setClaimDMobile(e.target.value)} placeholder="Mobile number" style={{ ...fieldStyle, flex: '1 1 120px' }} />
                        </div>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <input value={claimDPan} onChange={e => setClaimDPan(e.target.value)} placeholder="PAN (ABCDE1234F)" style={fieldStyle} />
                        </div>
                        <input value={claimDAddress} onChange={e => setClaimDAddress(e.target.value)} placeholder="Address" style={fieldStyle} />
                        <input value={claimDEmail} onChange={e => setClaimDEmail(e.target.value)} placeholder="Email" style={fieldStyle} />
                      </div>
                    </div>
                  )}

                  {/* Optional Details */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Optional Details</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <input
                        value={claimUpi}
                        onChange={e => setClaimUpi(e.target.value)}
                        placeholder="UPI Transaction ID (e.g., UPI123456789)"
                        style={{ width: '100%', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s' }}
                        onFocus={e => e.target.style.borderColor = 'var(--sage)'}
                        onBlur={e => e.target.style.borderColor = 'var(--line)'}
                      />
                      <div style={{ display: 'flex', gap: isCompact ? 8 : 10, flexWrap: 'wrap' }}>
                        <input type="date" value={claimDate} onChange={e => setClaimDate(e.target.value)}
                          style={{ flex: '1 1 120px', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s' }}
                          onFocus={e => e.target.style.borderColor = 'var(--sage)'}
                          onBlur={e => e.target.style.borderColor = 'var(--line)'} />
                        <input type="time" value={claimTime} onChange={e => setClaimTime(e.target.value)}
                          style={{ flex: '1 1 120px', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s' }}
                          onFocus={e => e.target.style.borderColor = 'var(--sage)'}
                          onBlur={e => e.target.style.borderColor = 'var(--line)'} />
                      </div>
                      <textarea value={claimNotes} onChange={e => setClaimNotes(e.target.value)} rows={2}
                        placeholder="Note for accounts (how do you know this donor?)"
                        style={{ width: '100%', padding: '10px 12px', border: '1.5px solid var(--line)', borderRadius: 10, fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', outline: 'none', transition: 'border-color .15s', minHeight: 60 }}
                        onFocus={e => e.target.style.borderColor = 'var(--sage)'}
                        onBlur={e => e.target.style.borderColor = 'var(--line)'} />
                    </div>
                  </div>

                  {claimError && (
                    <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', fontSize: 11, color: '#b91c1c', marginBottom: 16 }}>
                      {claimError}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            {!claimSuccess && (
              <div style={{ padding: isCompact ? '12px 16px' : '16px 24px', borderTop: '1px solid var(--line)', background: 'var(--bg)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowClaimModal(false)} disabled={claiming}
                  style={{ padding: '10px 20px', border: '1.5px solid var(--line)', borderRadius: 10, background: '#fff', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', transition: 'all .15s' }}
                  onMouseOver={e => e.currentTarget.style.background = 'var(--bg)'}
                  onMouseOut={e => e.currentTarget.style.background = '#fff'}>
                  Cancel
                </button>
                <button onClick={submitClaim} disabled={claiming || !claimDonor}
                  style={{ padding: '10px 20px', border: 'none', borderRadius: 10, background: 'var(--sage)', color: '#fff', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', boxShadow: '0 2px 8px rgba(91,107,78,.3)', transition: 'all .15s', opacity: (claiming || !claimDonor) ? .5 : 1 }}
                  onMouseOver={e => { if (!claiming && claimDonor) e.currentTarget.style.transform = 'translateY(-1px)' }}
                  onMouseOut={e => e.currentTarget.style.transform = 'none'}>
                  {claiming ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 12, height: 12, border: '2px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.6s linear infinite' }} />
                      Claiming...
                    </span>
                  ) : 'Submit Claim'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
