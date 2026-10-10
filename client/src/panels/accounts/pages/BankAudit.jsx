import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Plus, ListFilter, X, Landmark } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/auth';
import { useRealtime } from '../../../hooks/useRealtime';
import Toast from '../components/Toast';
import { toast } from '../../../components/Toast';
import SuspenseToast from '../components/SuspenseToast';
import DonorPicker from '../components/DonorPicker';
import { ModernDateInput } from '../components/ModernDateInput';
import { ModernTimeInput } from '../components/ModernTimeInput';
import RightPanel from '../components/RightPanel';
import Pagination from '../components/Pagination';
import { downloadSinglePDF } from '../services/pdfGenerator';
import { receivedMeta } from '../services/receivedSource';
import ReceiptTemplateManncar from '../components/ReceiptTemplateManncar';
import ReceiptTemplateAshray from '../components/ReceiptTemplateAshray';
import ReceiptTemplateBeingSevak from '../components/ReceiptTemplateBeingSevak';

const curr = n => n != null ? '\u20B9' + Number(n).toLocaleString('en-IN') : '\u20B90';
// A true suspense row is a bare suspense *receipt* (no bank_audit_entries row),
// whose id is prefixed 'suspense-'. Entries whose linked receipt is unlinked are
// also tagged kind:'suspense' by the backend, but they are real entries (numeric
// id) and must keep using the entry endpoints for edit/delete.
const isReceiptSuspense = (r) => !!(r && r.kind === 'suspense' && typeof r.id === 'string' && String(r.id).indexOf('suspense-') === 0);
const NGO_LABELS = { bsct:'Being Sevak', mann:'Mann Care', aflf:'Ashray' };
const NGO_STYLE = { bsct:{background:'#dbeafe',color:'#1d4ed8'}, aflf:{background:'#dcfce7',color:'#166534'}, mann:{background:'#fce7f3',color:'#be185d'} };
// Per-NGO card tints, matching the FRO Suspense section palette.
// Exported (single source of truth) for the Lead Verification card wave.
const NGO_CARD = { bsct:{background:'#d4e4ff',accent:'#1e40af'}, aflf:{background:'#c8ecd4',accent:'#166534'}, mann:{background:'#ecc9df',accent:'#be185d'} };
export { NGO_CARD }
const TODAY_IST=new Date(Date.now()+5.5*60*60*1000).toISOString().slice(0,10);
const EMPTY_FM={src_id:'',amount:'',payment_id:'',check_id:'NA',transaction_date:'',remarks:'NA',payer_name:'',donor_name:'',payment_time:'',project_id:'',donor_mobile:'',donor_email:'',donor_pan:'',donor_address_1:'',donor_address_2:'',donor_city:'',donor_pin_code:'',agent_name:'',log_id:'',donor_id:'',mode:'',modeCustom:'',_lead_amount:null};
const MODE_OPTIONS=['Google Pay','Freecharge','razorpay','online','PUM','Cheque','Paytm','others'];

const NGO_MAP = {
  bsct: { label: 'Being Sevak', comp: ReceiptTemplateBeingSevak },
  mann: { label: 'Mann Care', comp: ReceiptTemplateManncar },
  aflf: { label: 'Ashray', comp: ReceiptTemplateAshray },
};
function getNgoSettings(project) {
  const saved = localStorage.getItem('receipt_template_settings');
  const defaults = NGO_MAP[project] || NGO_MAP.bsct;
  if (!saved) return defaults;
  try {
    const overrides = JSON.parse(saved);
    const o = overrides[project];
    if (!o) return defaults;
    return { label: defaults.label, comp: NGO_MAP[o.receiptDesign]?.comp || defaults.comp };
  } catch { return defaults }
}
function entryToDonor(e) {
  return {
    'Donor Name': e.donor_name || e.payer_name || 'Unknown',
    'Receipt No.': e.receipt_no || 'N/A',
    'Receipt Date': e.transaction_date || e.receipt_date || '',
    'Amount': e.amount,
    'Payment ID No.': e.payment_id || '',
    'PAN No.': e.donor_pan || '',
    'Email ID': e.donor_email || '',
    'Address 1': e.donor_address_1 || '',
    'Address 2': e.donor_address_2 || '',
    'City': e.donor_city || '',
    'State': '',
    'Pincode': e.donor_pin_code || '',
    'Mode of Payment (MOP)': e.mode || 'Bank',
    'Donor Bank Name': e.bank_name || '',
    'Account Of': 'Corpus',
    'Project': e.project_id || 'bsct',
  };
}

function currentMonthIST(){
  const d=new Date(Date.now()+5.5*60*60*1000);
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');
}
const fmtTime = t => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return t;
  const ap = h >= 12 ? 'PM' : 'AM';
  return (h % 12 || 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
};
const fmtDate = d => {
  if (!d) return '';
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const [y, m, dd] = s.split('-'); return dd + '-' + m + '-' + y; }
  const dt = new Date(d);
  if (isNaN(dt)) return s;
  return String(dt.getDate()).padStart(2, '0') + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + dt.getFullYear();
};
function monthBounds(ym){
  const [y,m]=ym.split('-').map(Number);
  const last=new Date(Date.UTC(y,m,0)).getUTCDate();
  return {from:ym+'-01',to:ym+'-'+String(last).padStart(2,'0')};
}
// For the 'unverified' (pending) status, surface unclaimed entries across the
// month boundary: window from the start of the PREVIOUS month to the end of the
// current month. Otherwise Aug-31 entries (seen on suspense, no month limit)
// stay hidden in the current-month default audit view.
function unverifiedWindow(ym){
  const [y,m]=ym.split('-').map(Number);
  const prevY = m===1 ? y-1 : y;
  const prevM = m===1 ? 12 : m-1;
  const prevPad = String(prevM).padStart(2,'0');
  const curLast = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: prevY+'-'+prevPad+'-01',
           to:   y+'-'+String(m).padStart(2,'0')+'-'+String(curLast).padStart(2,'0') };
}

function Sk({h=14,w='100%'}){return <div style={{height:h,width:typeof w==='number'?w:w,borderRadius:6,background:'linear-gradient(90deg,#e5e7eb 25%,#f3f4f6 50%,#e5e7eb 75%)',backgroundSize:'200% 100%',animation:'sk-shimmer 1.4s infinite'}}/>}

function Tab({a,on,ic,ch}){return <button onClick={on} style={{padding:'10px 18px',fontSize:13,fontWeight:a?700:500,border:'none',background:a?'#fff':'transparent',cursor:'pointer',color:a?'var(--sage)':'#6b7280',borderBottom:a?'2px solid var(--sage)':'2px solid transparent',marginBottom:-2,display:'flex',alignItems:'center',gap:6,whiteSpace:'nowrap',transition:'all .15s'}}>{ic}{ch}</button>}

function IconBtn({on,ch,dis,title,bg='#fff',fg='var(--sage)',style}){return <button className="btn btn-sm fb-btn" onClick={on} disabled={dis} title={title} aria-label={title} style={{background:bg,color:fg,border:'none',opacity:dis?.5:1,...style}}>{ch}</button>}

const fieldStyle={padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,background:'#fff',transition:'border-color .15s, box-shadow .15s',outline:'none',width:'100%',boxSizing:'border-box'};
const fieldFocus={borderColor:'var(--sage)',boxShadow:'0 0 0 3px rgba(22,163,74,.08)'};
function FieldSection({title,children,style}){
  return <div style={{marginBottom:20,...style}}>
    <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
      <span style={{width:3,height:14,borderRadius:3,background:'var(--sage)',flexShrink:0}}/>
      <span style={{fontSize:13,fontWeight:700,color:'#111827',letterSpacing:'-.01em'}}>{title}</span>
    </div>
    {children}
  </div>;
}

// ─── Lead (Log) Picker ────────────────────────────────────
function LeadPicker({ value, locked, onPick, onClear }){
  const [open,setOpen]=useState(false);
  const [q,setQ]=useState('');
  const [leads,setLeads]=useState([]);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState('');
  const boxRef=useRef(null);

  const search=useCallback((term)=>{
    setLoading(true);setErr('');
    apiGet('/accounts/bank-audit/leads'+(term?'?q='+encodeURIComponent(term):''))
      .then(setLeads)
      .catch(e=>{setErr(e.message||'Failed to load leads');setLeads([])})
      .finally(()=>setLoading(false));
  },[]);

  useEffect(()=>{
    if(!open||locked)return;
    const t=setTimeout(()=>search(q),250);
    return ()=>clearTimeout(t);
  },[open,locked,q,search]);

  useEffect(()=>{
    const onDoc=(ev)=>{if(boxRef.current&&!boxRef.current.contains(ev.target))setOpen(false)};
    document.addEventListener('mousedown',onDoc);
    return ()=>document.removeEventListener('mousedown',onDoc);
  },[]);

  if(value){
    return <div style={{display:'flex',alignItems:'center',gap:8,padding:'9px 12px',borderRadius:8,border:'1.5px solid #cfe3cb',background:'#f0f7ef',fontSize:12,color:'#14532d',minWidth:0}}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
      <span style={{fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{locked?`Linked to Lead #${value}`:`Lead #${value}`}</span>
      {locked?<span style={{color:'#6b7280',flexShrink:0}}>· locked</span>:<button type="button" onClick={onClear} style={{marginLeft:'auto',flexShrink:0,border:'1px solid #fecaca',background:'#fff',color:'#dc2626',borderRadius:6,padding:'2px 8px',cursor:'pointer',fontSize:11,fontWeight:600}}>Clear</button>}
    </div>;
  }

  return <div ref={boxRef} style={{position:'relative'}}>
    <input className="field-input" placeholder="Search pending lead (donor / mobile / FRO / amount)..." value={q}
      onChange={e=>{setQ(e.target.value);setOpen(true)}}
      style={{...fieldStyle,width:'100%',boxSizing:'border-box'}}
      onFocus={()=>setOpen(true)}/>
    {open&&<div style={{position:'absolute',zIndex:40,top:'calc(100% + 6px)',left:0,right:0,background:'#fff',border:'1px solid #e5e7eb',borderRadius:12,boxShadow:'0 12px 32px rgba(0,0,0,.14)',overflow:'hidden'}}>
      <div style={{padding:'8px 12px',background:'#f9fafb',borderBottom:'1px solid #eef0f3',fontSize:11,fontWeight:600,color:'#6b7280'}}>Pending leads</div>
      <div style={{maxHeight:260,overflowY:'auto'}}>
      {loading?<div style={{padding:14,fontSize:12,color:'#9ca3af',textAlign:'center'}}>Searching...</div>
        :err?<div style={{padding:14,fontSize:12,color:'#dc2626',textAlign:'center'}}>{err}</div>
        :leads.length===0?<div style={{padding:14,fontSize:12,color:'#9ca3af',textAlign:'center'}}>No pending leads found</div>
        :leads.map(l=><button key={l.log_id} type="button" onClick={()=>{onPick(l);setOpen(false);setQ('')}}
          style={{display:'block',width:'100%',textAlign:'left',padding:'10px 12px',border:'none',borderBottom:'1px solid #f3f4f6',background:'#fff',cursor:'pointer',fontSize:12,transition:'background .12s'}}
          onMouseOver={e=>{e.currentTarget.style.background='#f0f7ef'}} onMouseOut={e=>{e.currentTarget.style.background='#fff'}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center'}}>
            <span style={{fontWeight:600,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.donor_name||'Unknown'}</span>
            <span style={{fontWeight:700,color:'var(--sage)',whiteSpace:'nowrap'}}>{curr(l.amount||0)}</span>
          </div>
          <div style={{color:'#6b7280',marginTop:2,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
            {l.donor_mobile||'\u2014'} · {l.agent_name||'No FRO'} · #{l.log_id}
          </div>
        </button>)}
      </div>
    </div>}
  </div>;
}

// ─── Agent (FRO) Picker ───────────────────────────────────
function AgentPicker({ value, workers, onChange }){
  const [open,setOpen]=useState(false);
  const [q,setQ]=useState('');
  const boxRef=useRef(null);

  const froSet=new Set(workers.filter(w=>String(w.department||'').toLowerCase()==='fro').map(w=>w.name));
  const base=[...workers].sort((a,b)=>(froSet.has(b.name)?1:0)-(froSet.has(a.name)?1:0));
  const kw=q.trim().toLowerCase();
  const list=kw?base.filter(w=>(w.name||'').toLowerCase().includes(kw)||(w.login_id||'').toLowerCase().includes(kw)):base;
  const staticAgents=[{name:'Priyank Shah'},{name:'Suspense'}];
  const fromLead=!!value&&!workers.some(w=>w.name===value)&&!staticAgents.some(s=>s.name===value);

  useEffect(()=>{
    const onDoc=(ev)=>{if(boxRef.current&&!boxRef.current.contains(ev.target))setOpen(false)};
    document.addEventListener('mousedown',onDoc);
    return ()=>document.removeEventListener('mousedown',onDoc);
  },[]);

  if(value){
    return <div style={{display:'flex',alignItems:'center',gap:6,padding:'9px 12px',borderRadius:8,border:'1.5px solid #d1d5db',background:'#f3f4f6',fontSize:13,color:'#374151',minWidth:0}}>
      <span style={{fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{value}</span>
      {fromLead&&<span style={{color:'#9ca3af',flexShrink:0,fontSize:11}}>(lead)</span>}
      <button type="button" onClick={()=>onChange('')} style={{marginLeft:'auto',flexShrink:0,border:'1px solid #fecaca',background:'#fff',color:'#dc2626',borderRadius:6,padding:'2px 8px',cursor:'pointer',fontSize:11}}>Clear</button>
    </div>;
  }

  return <div ref={boxRef} style={{position:'relative'}}>
    <input className="field-input" placeholder="Search agent / FRO by name or login..." value={q}
      onChange={e=>{setQ(e.target.value);setOpen(true)}}
      onFocus={()=>setOpen(true)}
      style={{padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,outline:'none',width:'100%',boxSizing:'border-box'}}/>
    {open&&<div style={{position:'absolute',zIndex:40,top:'calc(100% + 4px)',left:0,right:0,background:'#fff',border:'1px solid #e5e7eb',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.12)',maxHeight:220,overflowY:'auto'}}>
      {list.length===0&&!staticAgents.some(s=>!kw||s.name.toLowerCase().includes(kw))?<div style={{padding:14,fontSize:12,color:'#9ca3af'}}>No FROs found</div>
        :<>
          <button type="button" onClick={()=>{onChange('');setOpen(false);setQ('')}}
            style={{display:'block',width:'100%',textAlign:'left',padding:'9px 12px',border:'none',borderBottom:'1px solid #f3f4f6',background:'#fff',cursor:'pointer',fontSize:12,color:'#6b7280'}}
            onMouseOver={e=>e.currentTarget.style.background='#f9fafb'} onMouseOut={e=>e.currentTarget.style.background='#fff'}>None</button>
          {staticAgents.filter(s=>!kw||s.name.toLowerCase().includes(kw)).map(s=><button key={s.name} type="button" onClick={()=>{onChange(s.name);setOpen(false);setQ('')}}
            style={{display:'block',width:'100%',textAlign:'left',padding:'9px 12px',border:'none',borderBottom:'1px solid #f3f4f6',background:'#fff',cursor:'pointer',fontSize:12}}
            onMouseOver={e=>e.currentTarget.style.background='#f9fafb'} onMouseOut={e=>e.currentTarget.style.background='#fff'}>
            <span style={{fontWeight:600,color:'#111827'}}>{s.name}</span>
          </button>)}
          {list.map(w=><button key={w.id} type="button" onClick={()=>{onChange(w.name);setOpen(false);setQ('')}}
            style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center',width:'100%',textAlign:'left',padding:'9px 12px',border:'none',borderBottom:'1px solid #f3f4f6',background:'#fff',cursor:'pointer',fontSize:12}}
            onMouseOver={e=>e.currentTarget.style.background='#f9fafb'} onMouseOut={e=>e.currentTarget.style.background='#fff'}>
            <span style={{fontWeight:600,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{w.name}</span>
            <span style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
              {froSet.has(w.name)&&<span style={{fontSize:9,fontWeight:700,letterSpacing:'.4px',padding:'2px 6px',borderRadius:4,background:'#dcfce7',color:'#166534'}}>FRO</span>}
              {w.login_id&&<span style={{color:'#9ca3af'}}>{w.login_id}</span>}
            </span>
          </button>)}
        </>}
    </div>}
  </div>;
}

// ─── FRO Search Picker (for Manual Verify) ─────────────────
function FroSearchPicker({ value, fros = [], onChange }){
  const [open,setOpen]=useState(false);
  const [q,setQ]=useState('');
  const boxRef=useRef(null);

  const kw=q.trim().toLowerCase();
  const list=kw?fros.filter(w=>(w.name||'').toLowerCase().includes(kw)||(w.login_id||'').toLowerCase().includes(kw)):fros;
  const selected=fros.find(w=>String(w.id)===String(value));

  useEffect(()=>{
    const onDoc=(ev)=>{if(boxRef.current&&!boxRef.current.contains(ev.target))setOpen(false)};
    document.addEventListener('mousedown',onDoc);
    return ()=>document.removeEventListener('mousedown',onDoc);
  },[]);

  const selectedStyle={display:'flex',alignItems:'center',gap:8,padding:'9px 12px',borderRadius:8,border:'1.5px solid #cfe3cb',background:'#f0f7ef',fontSize:13,color:'#14532d',minWidth:0,cursor:'pointer'};

  if(value&&selected){
    return <div style={selectedStyle} onClick={()=>{onChange('');setOpen(true);setQ('')}}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--sage)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0}}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      <span style={{fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{selected.name}{selected.login_id?` (${selected.login_id})`:''}</span>
      <span style={{marginLeft:'auto',fontSize:10,color:'#6b7280',flexShrink:0}}>change</span>
    </div>;
  }

  return <div ref={boxRef} style={{position:'relative'}}>
    <div style={{position:'relative'}}>
      <input placeholder={fros.length===0?"Loading FROs...":"Search FRO by name or login..."} value={q}
        onChange={e=>{setQ(e.target.value);setOpen(true)}}
         style={{width:'100%',padding:'9px 12px',paddingRight:28,borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,background:'#fff',outline:'none',boxSizing:'border-box',transition:'border-color .15s, box-shadow .15s'}}
         onFocus={e=>{setOpen(true);e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}}
        onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',pointerEvents:'none'}}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </div>
    {open&&<div style={{position:'absolute',zIndex:40,top:'calc(100% + 4px)',left:0,right:0,background:'#fff',border:'1px solid #e5e7eb',borderRadius:10,boxShadow:'0 8px 24px rgba(0,0,0,.12)',maxHeight:250,overflowY:'auto'}}>
      {list.length===0?<div style={{padding:14,fontSize:12,color:'#9ca3af',textAlign:'center'}}>{kw?'No FROs found':'No FRO workers available'}</div>
        :list.map(w=><button key={w.id} type="button" onClick={()=>{onChange(String(w.id));setOpen(false);setQ('')}}
          style={{display:'flex',justifyContent:'space-between',gap:8,alignItems:'center',width:'100%',textAlign:'left',padding:'9px 12px',border:'none',borderBottom:'1px solid #f3f4f6',background:'#fff',cursor:'pointer',fontSize:12}}
          onMouseOver={e=>e.currentTarget.style.background='#f0f7ef'} onMouseOut={e=>e.currentTarget.style.background='#fff'}>
          <span style={{fontWeight:600,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{w.name}</span>
          <span style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
            <span style={{fontSize:9,fontWeight:700,letterSpacing:'.4px',padding:'2px 6px',borderRadius:4,background:'#dcfce7',color:'#166534'}}>FRO</span>
            {w.login_id&&<span style={{color:'#9ca3af',fontSize:11}}>{w.login_id}</span>}
          </span>
        </button>)}
    </div>}
  </div>;
}

// ─── Audit Stat Cards ──────────────────────────────────────
export function AuditStatCards({sources=[],summary={},loading=false,suspenseNgo='',setSuspenseNgo=null,combo=null,locked=false,bare=false}){
  const [alertBusy, setAlertBusy] = useState(false);
  const c=combo?(combo.all||{count:0,entries:0,suspense:0,amount:0}):null;
  const mask=(v)=>locked?'XXXX':v;

  const handleAlertAll = async () => {
    if (alertBusy || !apiPost) return;
    setAlertBusy(true);
    try {
      const res = await apiPost('/notifications/suspense-alert', {});
      toast('🔔 Alert sent to ' + (res?.count || 0) + ' FROs', 'success');
    } catch (e) { toast('Failed to send alert', 'error'); }
    setTimeout(() => setAlertBusy(false), 10000);
  };
  const handleAlertNgo = async (ngoKey) => {
    if (alertBusy || !apiPost) return;
    setAlertBusy(true);
    try {
      const res = await apiPost('/notifications/suspense-alert', { ngo: ngoKey });
      toast('🔔 Alert sent to ' + (res?.count || 0) + ' ' + ngoKey.toUpperCase() + ' FROs', 'success');
    } catch (e) { toast('Failed to send alert', 'error'); }
    setTimeout(() => setAlertBusy(false), 10000);
  };
  const ngoTiles=[
    {ngo:'bsct',label:'BSCT',bg:'#e7f0ff',accent:'#1e40af'},
    {ngo:'aflf',label:'AFLF',bg:'#e3f6e9',accent:'#166534'},
    {ngo:'mann',label:'MANN',bg:'#f6e8f2',accent:'#be185d'},
  ];
  const outer = bare
    ? {display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:16}
    : {display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:16,padding:'20px 22px',borderRadius:16,background:'linear-gradient(135deg,#ffffff 0%,#f6f8fb 100%)',border:'1px solid #e7ecf3',boxShadow:'0 6px 24px rgba(30,41,59,.06)'};

  if(loading){
    return (
      <div style={outer}>
        <div style={{display:'flex',alignItems:'center',gap:16}}>
          <span className="sk" style={{width:50,height:50,borderRadius:14,flexShrink:0}}/>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <span className="sk" style={{width:70,height:11,borderRadius:6}}/>
            <span className="sk" style={{width:150,height:28,borderRadius:8}}/>
            <span className="sk" style={{width:180,height:12,borderRadius:6}}/>
          </div>
        </div>
        {setSuspenseNgo&&(
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {ngoTiles.map((t,i)=><span key={i} className="sk" style={{width:120,height:64,borderRadius:12}}/>)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={outer}>
      <div style={{display:'flex',alignItems:'center',gap:16}}>
        <div style={{width:50,height:50,borderRadius:14,display:'flex',alignItems:'center',justifyContent:'center',background:'#111827',color:'#fff',boxShadow:'0 6px 16px rgba(17,24,39,.25)',flexShrink:0}}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 7V4H6l6 8-6 8h12v-3"/></svg>
        </div>
        <div>
          <div style={{fontSize:11.5,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'#8a93a3'}}>Suspense</div>
          <div style={{fontSize:28,fontWeight:800,letterSpacing:'-.02em',lineHeight:1.15,color:'#111827',fontVariantNumeric:'tabular-nums'}}>{mask(c&&c.count)}</div>
          <div style={{fontSize:12.5,color:'#6b7280',marginTop:2}}>{mask(c&&c.count)} leads · {mask(curr(c&&c.amount))}</div>
          {!locked && (
            <button onClick={handleAlertAll} disabled={alertBusy}
              style={{
                marginTop:6,padding:'3px 10px',borderRadius:8,border:'1px solid #d1d5db',
                background:alertBusy?'#f3f4f6':'#fff',color:'#374151',fontSize:10.5,
                fontWeight:600,cursor:alertBusy?'default':'pointer',opacity:alertBusy?0.6:1,
                transition:'opacity .15s',fontFamily:'inherit',
              }}
            >{alertBusy ? 'Sent ✓' : '🔔 Alert FROs'}</button>
          )}
        </div>
      </div>

      {setSuspenseNgo&&(
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {ngoTiles.map(({ngo,label,bg,accent})=>{
            const active=suspenseNgo===ngo;
            const d=(combo&&combo[ngo])||{count:0,amount:0};
            return (
              <button key={ngo} onClick={()=>setSuspenseNgo(active?'':ngo)} title={`Filter to ${label}`}
                style={{
                  display:'flex',flexDirection:'column',alignItems:'flex-start',gap:3,minWidth:120,
                  padding:'10px 14px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',textAlign:'left',
                  background:bg,color:accent,border:active?`2px solid ${accent}`:'2px solid transparent',
                  boxShadow:active?`0 4px 14px ${accent}30`:'none',transition:'box-shadow .12s, transform .12s',
                }}
                onMouseOver={e=>{e.currentTarget.style.transform='translateY(-1px)'}}
                onMouseOut={e=>{e.currentTarget.style.transform='none'}}>
                <div style={{display:'flex',alignItems:'center',gap:6,width:'100%'}}>
                  <span style={{fontSize:11,fontWeight:800,letterSpacing:'.04em',textTransform:'uppercase'}}>{label}</span>
                  <span style={{marginLeft:'auto',fontSize:10,fontWeight:700,opacity:.75,fontVariantNumeric:'tabular-nums'}}>{mask(d.count)}</span>
                  {!locked && (
                    <span onClick={(e) => { e.stopPropagation(); handleAlertNgo(ngo); }}
                      style={{fontSize:11,cursor:alertBusy?'default':'pointer',opacity:alertBusy?0.5:1,lineHeight:1}}
                      title={`Alert ${label} FROs`}>🔔</span>
                  )}
                </div>
                <div style={{fontSize:17,fontWeight:800,fontVariantNumeric:'tabular-nums',lineHeight:1.15,whiteSpace:'nowrap'}}>{mask(curr(d.amount))}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Entries (Bank Audit Core) ─────────────────────────────
function EntrySection({loading,entries,sources,summary,error,statusTab,setStatusTab,selDate,setSelDate,selDay,setSelDay,doLoad,ngoFilter,setNgoFilter,hideNgoFilter,showAdd,setShowAdd,showSrc,setShowSrc,form,setForm,handleAdd,handleDelete,handleAddSrc,handleDelSrc,sn,setSn,getSrcName,filtered,SvgX,onOpen,selectedEntryId,onSelectEntry,selectionEnabled,leadFilterKey,amountFilter='',dateFilter='',sharedListRef,onListScroll,locked=false}){
  const PAGE_SIZE=30;
  const[pg,setPg]=useState(1);
  const[sq,setSq]=useState('');
  const[stf,setStf]=useState('');
  const listRef=useRef(null);
  const clickRef=useRef(null);
  useEffect(()=>{if(listRef.current)listRef.current.scrollTop=0},[leadFilterKey]);
  const kw=sq.trim().toLowerCase();
  // Pending = no match made yet and not claimed by an FRO; Claimed = an FRO has
  // claimed the money (claimed_by set) but it is not resolved/confirmed yet.
  const claimVisible=stf?filtered.filter(e=>stf==='pending'?(!e.match_status&&!e.claimed_by):(!!e.claimed_by)):filtered;
  const searched=kw?claimVisible.filter(e=>
    [e.payer_name,e.donor_mobile,e.payment_id,e.check_id,e.receipt_no,e.amount,e.agent_name,e.transaction_date,e.bank_audit_sources?.name,getSrcName(e.source_id)]
      .some(v=>v!=null&&String(v).toLowerCase().includes(kw))
  ):claimVisible;
  const visible=searched;
  const dateVisible=dateFilter?visible.filter(e=>String(e.transaction_date||'').slice(0,10)===dateFilter):visible;
  const amountVisible=amountFilter!==''&&amountFilter!=null?dateVisible.filter(e=>Number(e.amount)===Number(amountFilter)):dateVisible;
  const pageCount=Math.max(1,Math.ceil(amountVisible.length/PAGE_SIZE));
  const pageItems=amountVisible.slice((pg-1)*PAGE_SIZE,pg*PAGE_SIZE);
  useEffect(()=>{setPg(1)},[statusTab,selDate,selDay,ngoFilter,sq,amountFilter,dateFilter,stf]);
  useEffect(()=>{if(pg>pageCount)setPg(pageCount)},[pageCount,pg]);
  const na=v=>(v===undefined||v===null||String(v).trim()==='')?'NA':v;
  const mask=v=>locked?'XXXX':v;
  const srcOf=e=>e.bank_audit_sources?.name||getSrcName(e.source_id);
  const NGO_LABELS={bsct:'Being Sevak',mann:'Mann Care',aflf:'Ashray'};
  const ngoOf=e=>{
    const prj=(e.project_id||'').toLowerCase();
    if(NGO_LABELS[prj])return prj;
    const s=((e.bank_audit_sources?.name||'')+' '+(e.remarks||'')).toLowerCase();
    if(/beingsevak|being sevak|\bsevak\b|\bbsct\b/.test(s))return 'bsct';
    if(/ashray|\baflf\b/.test(s))return 'aflf';
    if(/manncar|mann care|\bmann\b/.test(s))return 'mann';
    return '';
  };
  return <div>
    {error&&<div style={{display:'flex',alignItems:'center',gap:6,background:'#fef2f2',border:'1px solid #fecaca',borderRadius:8,padding:'8px 12px',marginBottom:14,fontSize:13,color:'#991b1b'}}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>{error}
    </div>}
    <div className="card" style={{marginBottom:14,borderRadius:10}}>
      <div className="filter-bar">
        <span style={{display:'inline-flex',alignItems:'center',gap:4,padding:'2px',borderRadius:7,background:'#f3f4f6',flexWrap:'wrap'}}>
          {[['','All'],['pending','Pending'],['claimed','Claimed']].map(([v,l])=>
            <button key={v||'all'} onClick={()=>setStf(v)} style={{fontSize:10,fontWeight:600,padding:'4px 10px',borderRadius:6,border:'none',cursor:'pointer',background:stf===v?'#111827':'transparent',color:stf===v?'#fff':'#4b5563',transition:'background .12s'}}>{l}</button>
          )}
        </span>
        <input type="date" value={selDay||selDate} max={new Date().toISOString().slice(0,10)} onChange={e=>{const v=e.target.value;if(!v){setSelDate('');setSelDay('');doLoad('',statusTab);return}setSelDay(v);setSelDate('');doLoad('',statusTab,v)}} style={{fontSize:12,padding:'4px 8px',borderRadius:6,border:'1px solid #d1d5db'}}/>
        {!hideNgoFilter&&<select value={ngoFilter} onChange={e=>setNgoFilter(e.target.value)} style={{fontSize:12,padding:'4px 8px',borderRadius:6,border:'1px solid #d1d5db'}}>
          <option value="">All NGOs</option><option value="bsct">Being Sevak</option><option value="mann">Mann Care</option><option value="aflf">Ashray</option>
        </select>}
        <input placeholder="Search..." value={sq} onChange={e=>setSq(e.target.value)} style={{fontSize:12,padding:'4px 8px',borderRadius:6,border:'1px solid #d1d5db',width:190,minWidth:0}}/>
        <IconBtn on={()=>{setForm({...EMPTY_FM});setShowAdd(true)}} ch={<Plus size={15} strokeWidth={2.5}/>} title="Add entry" bg="var(--sage)" fg="#fff" style={{marginLeft:'auto'}}/>
        <IconBtn on={()=>{setSn('');setShowSrc(true)}} ch={<ListFilter size={14} strokeWidth={2.5}/>} title="Manage sources" bg="transparent" fg="#374151" style={{border:'1px solid #d1d5db'}}/>
      </div>
    </div>
    <div className="entry-scroll" ref={sharedListRef} onScroll={onListScroll}>
      <div className="entry-grid">
        {loading ? Array.from({length:5}).map((_,i)=>
          <div key={i} className="entry-card is-skeleton">
          <div className="ec-main">
              <div className="ec-primary">
                <div className="sk" style={{width:'45%',height:13,borderRadius:4}}/>
                <div className="sk" style={{width:'60%',height:10,borderRadius:4,marginTop:6}}/>
              </div>
              <div className="sk" style={{width:64,height:18,borderRadius:5}}/>
            </div>
            <div className="ec-meta">
              <div className="sk" style={{width:60,height:16,borderRadius:8}}/>
              <div className="sk" style={{width:90,height:10,borderRadius:4}}/>
            </div>
          </div>
        ) : visible.length===0 ? (
          <div className="entry-card-empty">No entries yet</div>
        ) : pageItems.map((e,idx)=>{
        const ngoColor=NGO_CARD[ngoOf(e)];
        return (
        <div key={e.id||idx} data-entry-id={e.id} className={'entry-card'+(e.kind==='suspense'?' is-suspense':'')+((e.match_status==='matched'||e.match_status==='confirmed')?(e.match_source==='manual'?' is-match-manual':e.match_source==='static_fro'?' is-match-static':' is-match-auto'):' is-match-unmatched')+(e.suspense_claimed?' is-suspense-claimed':'')+(selectedEntryId===e.id?' is-selected':'')}
          style={ngoColor?{background:ngoColor.background}:undefined}
          onClick={()=>{if(clickRef.current)clearTimeout(clickRef.current);clickRef.current=setTimeout(()=>{clickRef.current=null;onOpen(e)},300)}}
          onDoubleClick={()=>{if(clickRef.current){clearTimeout(clickRef.current);clickRef.current=null}if(!onSelectEntry||!selectionEnabled||e.match_source==='auto'||e.match_status==='confirmed')return;if(selectedEntryId===e.id)onSelectEntry(null);else onSelectEntry(e)}}>
          {e.suspense_claimed&&<span className="twinkle-corner"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0L14.59 8.41L23 11L14.59 13.59L12 22L9.41 13.59L1 11L9.41 8.41Z"/></svg></span>}
          <div className="ec-main">
            <div className="ec-primary">
              <div className="ec-title">{e.payer_name||'\u2014'}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2, minWidth: 0 }}>
                <span className="ec-sub" style={{ marginTop: 0 }}>{e.transaction_date?fmtDate(e.transaction_date):'\u2014'}{e.payment_time?' \u00B7 '+fmtTime(e.payment_time):''}</span>
                {e.claimed_by
                  ? <>
                      <span className="pill" style={{ fontSize: 9, fontWeight: 700, background: '#e0f2fe', color: '#0369a1', whiteSpace: 'nowrap', flexShrink: 0 }} title="Claimed by FRO">Claimed by {e.claimed_by}</span>
                      {e.claimed_donor_name&&<span className="pill" style={{ fontSize: 9, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8', whiteSpace: 'nowrap', flexShrink: 0 }} title="Donor linked by the FRO on claim">Claimed for {e.claimed_donor_name}{e.claimed_donor_mobile?` \u00B7 ${e.claimed_donor_mobile}`:''}</span>}
                    </>
                  :(e.verify_type||e.verify_fro_worker_id)&&((ag)=>ag&&ag!=='Suspense'
                    ?<span className="pill" style={{ fontSize: 9, fontWeight: 700, background: '#ede9fe', color: '#7c3aed', whiteSpace: 'nowrap', flexShrink: 0 }} title="Manual verify details saved">SAVED · {ag}</span>
                    :<span className="pill" style={{ fontSize: 9, fontWeight: 700, background: '#ede9fe', color: '#7c3aed', whiteSpace: 'nowrap', flexShrink: 0 }} title="Manual verify details saved">SAVED</span>
                  )(e.agent_name||e.verify_fro_name||e.match_fro)}
              </div>
            </div>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              {e.receipt_no&&<span style={{fontSize:15,fontWeight:800,color:'#16a34a',fontFamily:'monospace',letterSpacing:'.5px'}}>{e.receipt_no}</span>}
              <div className="ec-amount">{mask(curr(e.amount))}</div>
              <svg className="ec-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </div>
          <div className="ec-meta">
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', minWidth: 0, flex: 1 }}>
              {e.suspense_claimed&&<span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:9,fontWeight:700,letterSpacing:'.4px',padding:'3px 8px',borderRadius:4,background:'#fef3c7',color:'#92400e',whiteSpace:'nowrap'}} title="Claimed from the Unclaimed suspense pool"><span className="pulse-dot"/>Suspense Claimed</span>}
              {e.match_status==='matched'&&<span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:9,fontWeight:700,letterSpacing:'.4px',padding:'3px 8px',borderRadius:4,background:'#ffedd5',color:'#c2410c',whiteSpace:'nowrap'}}>MATCHED</span>}
              {e.match_status==='confirmed'&&<span style={{display:'inline-flex',alignItems:'center',gap:4,fontSize:9,fontWeight:700,letterSpacing:'.4px',padding:'3px 8px',borderRadius:4,background:'#e8f0e4',color:'#5B6B4E',whiteSpace:'nowrap'}}>CONFIRMED</span>}
              {!e.match_status&&<span className="pill pill-yellow">Pending</span>}
              <span className="pill pill-gray">{e.bank_audit_sources?.name||getSrcName(e.source_id)}</span>
              <span className="ec-ref">{e.payment_id||e.check_id||'\u2014'}</span>
            </div>
            <span className="pill" style={{ marginLeft: 'auto', alignSelf: 'center', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', flexShrink: 0, background: (NGO_STYLE[ngoOf(e)]||{background:'#f3f4f6',color:'#6b7280'}).background, color: (NGO_STYLE[ngoOf(e)]||{background:'#f3f4f6',color:'#6b7280'}).color, borderRadius: 4, padding: '3px 10px' }}>{NGO_LABELS[ngoOf(e)]||'\u2014'}</span>
          </div>
        </div>
        );
      })}
      </div>
    </div>
    <Pagination page={pg} setPage={setPg} totalItems={visible.length} pageSize={PAGE_SIZE} />
  </div>;
}

// ─── Main ──────────────────────────────────────────────────
export default function BankAudit({embedded,onSummary,selectedEntryId,onSelectEntry,selectionEnabled=true,leadFilter,globalNgo,suspenseNgo:cardSuspenseNgo,onView,amountFilter='',dateFilter='',listRef,onListScroll,onAmounts,locked=false}){
  const[e,setE]=useState([]);const[sr,setSr]=useState([]);const[su,setSu]=useState({});const[ld,setLd]=useState(true);
  const[st,setSt]=useState('unverified');const[sd,setSd]=useState(currentMonthIST());const[dd,setDd]=useState('');const[nf,setNf]=useState('');const[snf,setSnf]=useState('');
  const[sa,setSa]=useState(false);const[se,setSe]=useState(null);const[ss,setSs]=useState(false);
  const[fm,setFm]=useState({...EMPTY_FM});
  const[sv,setSv]=useState(false);const[snn,setSnn]=useState('');const[srcTab,setSrcTab]=useState('bank');const[er,setEr]=useState('');
  const[fer,setFer]=useState('');const[dci,setDci]=useState(null);const[to,setTo]=useState({msg:'',type:'success',vis:false});
  const[cm,setCm]=useState(false);
  const[rp,setRp]=useState(null);const[dl,setDl]=useState(false);const receiptRef=useRef(null);const clickRef=useRef(null);
  const[mv,setMv]=useState(null);const[mvSub,setMvSub]=useState(false);const[mvErr,setMvErr]=useState('');
  const[mvFro,setMvFro]=useState('');const[mvType,setMvType]=useState('');const[mvMobile,setMvMobile]=useState('');const[mvName,setMvName]=useState('');const[mvAddr,setMvAddr]=useState('');const[mvPan,setMvPan]=useState('');const[mvEmail,setMvEmail]=useState('');const[mvCity,setMvCity]=useState('');const[mvPinCode,setMvPinCode]=useState('');  const[mvAddr2,setMvAddr2]=useState('');const[mvDonorId,setMvDonorId]=useState('');
  const[mvResults,setMvResults]=useState([]);const[mvSearching,setMvSearching]=useState(false);const[mvShowResults,setMvShowResults]=useState(false);const[mvSearched,setMvSearched]=useState(false);
  const[mvConflict,setMvConflict]=useState(null);const[mvConflictFro,setMvConflictFro]=useState('');
  const[mvSaved,setMvSaved]=useState(false);
  const mvSearchRef=useRef(null);
  const[showMvForm,setShowMvForm]=useState(false);
  const mvFormRef=useRef(null);
  const[wr,setWr]=useState([]);
  const srRef=useRef(st);useEffect(()=>{srRef.current=st},[st]);
  const orRef=useRef(onSummary);orRef.current=onSummary;
  const navigate=useNavigate();
  const[suspenseToasts,setSuspenseToasts]=useState([]);

  useEffect(()=>{if((sa||se)&&wr.length===0){Promise.allSettled([apiGet('/workers?status=all'),apiGet('/auth/fro-workers')]).then(([a,b])=>{
    const bList=(b.status==='fulfilled'&&b.value)?(Array.isArray(b.value)?b.value:(b.value.workers||[])):[];
    const list=[...(a.status==='fulfilled'&&Array.isArray(a.value)?a.value:[]),...bList];
    const seen=new Set();const merged=list.filter(w=>{const wid=String(w.id||'');if(!wid||seen.has(wid))return false;seen.add(wid);return true});
    setWr(merged);
  })}},[sa,se,wr.length]);

  async function load(dt,stv,day,silent){
    const s=stv||srRef.current;if(!silent)setLd(true);setEr('');
    try{
      const p=new URLSearchParams();
      if(day){p.set('date_from',day);p.set('date_to',day)}
      else if(dt&&s==='unverified'){const w=unverifiedWindow(dt);p.set('date_from',w.from);p.set('date_to',w.to)}
      else if(dt){const b=monthBounds(dt);p.set('date_from',b.from);p.set('date_to',b.to)}
      p.set('status',s);
      const q=p.toString();
      const res=await Promise.allSettled([apiGet('/accounts/bank-audit/entries?'+q),apiGet('/accounts/bank-audit/sources'),apiGet('/accounts/bank-audit/summary?'+q)]);
      if(res[0].status==='fulfilled')setE(res[0].value);else{console.error(res[0].reason);setEr('Failed: '+res[0].reason.message)}
      if(res[1].status==='fulfilled')setSr(res[1].value);if(res[2].status==='fulfilled')setSu(res[2].value);
    }catch(err){console.error(err);setEr(err.message)}finally{setLd(false)}
  }
  useEffect(()=>{load(sd,st,dd)},[sd,dd,st]);
  useEffect(()=>{onAmounts?.(e.map(x=>Number(x.amount)).filter(Number.isFinite))},[e,onAmounts]);
  const rtTimerRef=useRef(null);
  const rtLoad=()=>{if(rtTimerRef.current)clearTimeout(rtTimerRef.current);rtTimerRef.current=setTimeout(()=>load(sd,srRef.current,dd,true),400)};
  useEffect(()=>()=>{if(rtTimerRef.current)clearTimeout(rtTimerRef.current)},[]);
  useRealtime('bank_audit_entries',{event:'*',onInsert:(row)=>{rtLoad();if(row){const id=row.id||Date.now();setSuspenseToasts(prev=>[...prev.slice(-4),{...row,_toastId:id}]);setTimeout(()=>setSuspenseToasts(prev=>prev.filter(t=>t._toastId!==id)),8000)}},onUpdate:rtLoad,onDelete:rtLoad});
  useRealtime('receipts',{event:'*',onInsert:rtLoad,onUpdate:rtLoad,onDelete:rtLoad});

  const ngoKw={bsct:['bsct','beingsevak','being sevak','sevak'],mann:['mann','manncar','mann care'],aflf:['aflf','ashray']};
  const matchesNgo=(entry,code)=>{const src=(entry.bank_audit_sources?.name||'').toLowerCase();const rem=(entry.remarks||'').toLowerCase();const prj=(entry.project_id||'').toLowerCase();const kw=ngoKw[code]||[];return kw.some(k=>src.includes(k)||rem.includes(k)||prj.includes(k))};

  const useGlobalNgo = globalNgo !== undefined;
  const ngoFilter = useGlobalNgo ? globalNgo : nf;
  const suspenseNgo = useGlobalNgo ? (cardSuspenseNgo !== undefined ? cardSuspenseNgo : globalNgo) : snf;

  // Per-NGO totals over the whole loaded list (bank entries + suspense receipts)
  // so the cards show the same combined count as the list. The card's NGO buttons
  // (suspenseNgo) filter only these cards, never the panels below.
  const combo=useMemo(()=>{
    const build=(code)=>{
      const rows=code?e.filter(x=>matchesNgo(x,code)):e;
      let entries=0,suspenseRows=0;
      for(const r of rows){if(r.kind==='suspense')suspenseRows++;else entries++}
      const suspense=rows.filter(r=>r.kind==='suspense');
      return {count:suspenseRows,entries,suspense:suspenseRows,amount:suspense.reduce((s,r)=>s+Number(r.amount||0),0)};
    };
    return {all:build(''),bsct:build('bsct'),aflf:build('aflf'),mann:build('mann')};
  },[e]);
  useEffect(()=>{if(embedded&&orRef.current)orRef.current({sources:sr,summary:su,loading:ld,suspenseNgo,setSuspenseNgo:useGlobalNgo?null:setSnf,combo})},[sr,su,ld,embedded,suspenseNgo,useGlobalNgo,e]);
  useEffect(()=>{onView?.(se?se.id:null)},[se]);
  useEffect(()=>{if(showMvForm&&mvFormRef.current){setTimeout(()=>mvFormRef.current?.scrollIntoView({behavior:'smooth',block:'end'}),100)}},[showMvForm]);
  const fe=e.filter(en=>{
    if(ngoFilter&&!matchesNgo(en,ngoFilter))return false;
    if(leadFilter&&leadFilter.amount!=null&&leadFilter.amount!==''&&Number(en.amount)!==Number(leadFilter.amount))return false;
    if(leadFilter&&leadFilter.ngo&&!matchesNgo(en,leadFilter.ngo))return false;
    return true;
  });
  const getSrc=i=>{const s=sr.find(s=>s.id===i);return s?s.name:'Unknown'};

  const resolveMode=()=>fm.mode==='others'?(fm.modeCustom||'').trim():fm.mode;

  const addEntry=async()=>{setFer('');if(!fm.src_id||!fm.amount||!fm.transaction_date||!fm.payment_time||!fm.project_id){setTo({msg:'Received Bank, amount, NGO, date, and payment time are required',type:'error',vis:true});return};if(Number(fm.amount)<=0){setTo({msg:'Amount must be greater than zero',type:'error',vis:true});return};setSv(true);try{await apiPost('/accounts/bank-audit/entries',{source_id:fm.src_id,amount:fm.amount,payment_id:fm.payment_id,check_id:fm.check_id,transaction_date:fm.transaction_date,remarks:fm.remarks,payer_name:fm.payer_name,payment_time:fm.payment_time,project_id:fm.project_id,donor_mobile:fm.donor_mobile,donor_email:fm.donor_email,donor_pan:fm.donor_pan,donor_address_1:fm.donor_address_1,donor_address_2:fm.donor_address_2,donor_city:fm.donor_city,donor_pin_code:fm.donor_pin_code,agent_name:fm.agent_name,log_id:fm.log_id||null,donor_id:fm.donor_id||null,mode:resolveMode()||null});setSa(false);setFm({...EMPTY_FM});setTo({msg:'Entry added successfully',type:'success',vis:true});load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setSv(false)}};
  const editEntry=async()=>{if(!se)return;if(Number(fm.amount)<=0){setTo({msg:'Amount must be greater than zero',type:'error',vis:true});return};setFer('');setSv(true);try{
    if(isReceiptSuspense(se)){
      await apiPut('/accounts/bank-audit/suspense/'+se.receipt_id,{donor_name:fm.donor_name||fm.payer_name||null,donor_mobile:fm.donor_mobile||se.donor_mobile||null,amount:fm.amount,receipt_date:fm.transaction_date,payment_id:fm.payment_id||null,project_id:fm.project_id||'bsct',agent_name:fm.agent_name,log_id:fm.log_id||null,mode:resolveMode()||null});
    }else{
      await apiPut('/accounts/bank-audit/entries/'+se.id,{...fm,source_id:fm.src_id,mode:resolveMode()||null});
    }
    setSe(null);setFm({...EMPTY_FM});setFer('');setTo({msg:'Entry updated successfully',type:'success',vis:true});load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setSv(false)}};
  const delEntry=async()=>{if(!dci)return;try{
    if(isReceiptSuspense(dci)){await apiDelete('/accounts/bank-audit/suspense/'+dci.receipt_id)}
    else{await apiDelete('/accounts/bank-audit/entries/'+dci.id)}
    setDci(null);setTo({msg:'Entry deleted successfully',type:'success',vis:true});load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}};
  const dbModes=sr.filter(s=>s.kind==='mop').map(s=>s.name).filter(Boolean);
  const modeList=dbModes.length?[...new Set([...dbModes,'online','others'])]:[...MODE_OPTIONS];
  const modeSet=new Set([...MODE_OPTIONS,...dbModes]);
  const bankSrcs=sr.filter(s=>(s.kind||'bank')==='bank'&&s.is_active!==false);
  const addSrc=async()=>{if(!snn)return;try{await apiPost('/accounts/bank-audit/sources',{name:snn,kind:srcTab});setSnn('');setSr(await apiGet('/accounts/bank-audit/sources'))}catch(e){setTo({msg:e.message,type:'error',vis:true})}};
  const delSrc=async(id)=>{if(!confirm('Delete?'))return;try{await apiDelete('/accounts/bank-audit/sources/'+id);setSr(await apiGet('/accounts/bank-audit/sources'))}catch(e){setTo({msg:e.message,type:'error',vis:true})}};
  const openE=(entry)=>{setShowMvForm(false);setMv(null);setMvErr('');setMvResults([]);setMvShowResults(false);const aName=entry.agent_name&&entry.agent_name!=='Suspense'?entry.agent_name:'';const edMode=entry.mode||'';const knownMode=[...modeSet].find(m=>m.toLowerCase()===edMode.toLowerCase());const modeFilled={mode:knownMode||(edMode?'others':''),modeCustom:knownMode?'':edMode};if(isReceiptSuspense(entry)){setFm({...EMPTY_FM,...modeFilled,src_id:'',amount:entry.amount,payment_id:entry.payment_id||'',transaction_date:entry.transaction_date,remarks:entry.remarks||'',payer_name:entry.payer_name||'',donor_name:entry.donor_name||entry.payer_name||'',project_id:entry.project_id||'bsct',donor_mobile:entry.donor_mobile||'',agent_name:aName,log_id:entry.log_id||'',donor_id:entry.donor_id||''});setSe(entry);return}setFm({...EMPTY_FM,...modeFilled,src_id:entry.source_id,amount:entry.amount,payment_id:entry.payment_id||'',check_id:entry.check_id||'',transaction_date:entry.transaction_date,remarks:entry.remarks||'',payer_name:entry.payer_name||'',donor_name:entry.donor_name||entry.payer_name||'',payment_time:entry.payment_time||'',project_id:entry.project_id||'bsct',donor_mobile:entry.donor_mobile||'',donor_email:entry.donor_email||'',donor_pan:entry.donor_pan||'',donor_address_1:entry.donor_address_1||'',donor_address_2:entry.donor_address_2||'',donor_city:entry.donor_city||'',donor_pin_code:entry.donor_pin_code||'',agent_name:aName,log_id:entry.log_id||'',donor_id:entry.donor_id||'',_lead_amount:entry.log_id?Number(entry.lead_amount||0):null});setSe(entry);if(entry.match_lead&&!entry.log_id){pickLead(entry.match_lead);setFm(p=>({...p,log_id:''}))}else if(entry.match_lead)setFm(p=>({...p,donor_mobile:entry.match_lead.donor_mobile||p.donor_mobile}))};
  const orNa=(v,fallback)=>v||fallback||'NA';
  const pickLead=(l)=>{setFm(p=>({...p,log_id:l.log_id,donor_id:l.donor_id||'',payer_name:l.donor_name||p.payer_name,donor_name:l.donor_name||p.donor_name,donor_mobile:orNa(l.donor_mobile,p.donor_mobile),donor_email:orNa(l.donor_email,p.donor_email),donor_pan:orNa(l.donor_pan,p.donor_pan),donor_address_1:orNa(l.donor_address_1,p.donor_address_1),donor_address_2:orNa(l.donor_address_2,p.donor_address_2),donor_city:orNa(l.donor_city,p.donor_city),donor_pin_code:orNa(l.donor_pin_code,p.donor_pin_code),project_id:l.donor_project||p.project_id,agent_name:l.agent_name||p.agent_name,_lead_amount:Number(l.amount||0)}));};
  const clearLead=()=>setFm(p=>({...p,log_id:'',donor_id:'',donor_name:'',donor_mobile:'',donor_email:'',donor_pan:'',donor_address_1:'',donor_address_2:'',donor_city:'',donor_pin_code:'',_lead_amount:null}));
  const confirmMatch=async(entry)=>{setCm(true);try{await apiPost('/accounts/bank-audit/entries/'+entry.id+'/confirm-match');setSe(null);setTo({msg:'Match confirmed and credited',type:'success',vis:true});load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setCm(false)}};
  const clearMatch=async(entry)=>{setCm(true);try{await apiPost('/accounts/bank-audit/entries/'+entry.id+'/clear-match');setSe(null);setTo({msg:'Match cleared',type:'success',vis:true});load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setCm(false)}};
  const openManualVerify=(entry)=>{setMv(entry);setMvErr('');setMvFro(entry.verify_fro_worker_id||'');setMvSaved(!!entry.verify_fro_worker_id);setMvType(entry.verify_type||'');setMvMobile(entry.donor_mobile&&entry.donor_mobile!=='NA'?entry.donor_mobile:'');setMvName(entry.mv_donor_name||entry.donor_profiles?.name||(entry.donor_name&&entry.donor_name!=='NA'?entry.donor_name:'')||'');setMvAddr(entry.donor_address_1||'');setMvPan(entry.donor_pan||'');setMvEmail(entry.donor_email||'');setMvCity(entry.donor_city||'');setMvPinCode(entry.donor_pin_code||'');setMvAddr2(entry.donor_address_2||'');setMvDonorId(entry.donor_id||'');setMvResults([]);setMvShowResults(false);setMvSearched(!!entry.donor_mobile&&entry.donor_mobile!=='NA');setShowMvForm(true);};
  const mvTimerRef=useRef(null);
  const searchMvDonors=(q)=>{setMvMobile(q);setMvErr('');setMvSearched(false);if(mvTimerRef.current)clearTimeout(mvTimerRef.current);const raw=q.replace(/[^\d]/g,'');if(raw.length<3){setMvResults([]);setMvShowResults(false);return}mvTimerRef.current=setTimeout(async()=>{try{setMvSearching(true);setMvShowResults(true);const r=await apiGet('/accounts/donors?search='+encodeURIComponent(raw));const donors=Array.isArray(r)?r:(r.data||[]);if(donors.length>0){setMvResults(donors);setMvSearched(true)}else{try{const rec=await apiGet('/accounts/receipts/by-mobile?mobile='+encodeURIComponent(raw));if(rec&&rec.donor_name){setMvName(rec.donor_name||'');setMvAddr(rec.address||'');setMvPan(rec.pan_number||'');setMvEmail(rec.email||'');setMvCity(rec.city||rec.donor_city||'');setMvPinCode(rec.pin_code||rec.donor_pin_code||'');setMvAddr2(rec.address_2||'');setMvDonorId(rec.donor_id||'');setMvShowResults(false);setMvSearched(true)}else{setMvResults([]);setMvSearched(true)}}catch(_){setMvResults([]);setMvSearched(true)}}}catch(e){setMvResults([])}finally{setMvSearching(false)}},350)};
  const selectMvDonor=(d)=>{setMvName(d.name||'');setMvMobile(d.mobile_number||d.mobile||d.phone||mvMobile);setMvAddr(d.address_1||d.address||'');setMvPan(d.pan_number||d.pan||'');setMvEmail(d.email||'');setMvCity(d.city||'');setMvPinCode(d.pin_code||d.pincode||'');setMvAddr2(d.address_2||'');setMvDonorId(d.id||'');setMvResults([]);setMvShowResults(false);setMvSearched(true)};
  const checkDonorConflict=useCallback(async(mobile)=>{
    const raw=String(mobile||'').replace(/[^\d]/g,'');
    if(raw.length<10){setMvConflict(null);setMvConflictFro('');return}
    try{
      const res=await apiGet('/accounts/bank-audit/check-donor-assignment?mobile='+encodeURIComponent(raw));
      if(res?.assigned&&res.assignments?.length>0){
        const otherFroAssignments=res.assignments.filter(a=>a.fro_worker_id!==mvFro);
        if(otherFroAssignments.length>0){
          setMvConflict(otherFroAssignments);
          setMvConflictFro(otherFroAssignments[0]?.fro_worker_id||'');
        }else{
          setMvConflict(null);setMvConflictFro('');
        }
      }else{setMvConflict(null);setMvConflictFro('')}
    }catch(_){setMvConflict(null);setMvConflictFro('')}
  },[mvFro]);
  const handleManualVerify=async()=>{if(!mv||mvSub)return;const mobile=String(mvMobile||'').replace(/[^\d]/g,'');if(mobile.length<10){setTo({msg:'Please enter a valid donor mobile number',type:'error',vis:true});return}setMvSub(true);try{const payload={donor_mobile:mobile,donor_name:mvName||null,donor_address:mvAddr||null,donor_pan:mvPan||null,donor_email:mvEmail||null,donor_city:mvCity||null,donor_pin_code:mvPinCode||null,donor_address_2:mvAddr2||null,donor_id:mvDonorId||null,verify_type:'fro',verify_fro_worker_id:mvFro||null};if(mvFro)payload.fro_worker_id=mvFro;if(mvConflict&&mvConflictFro&&mvConflictFro!=='new'){payload.credit_to_fro_worker_id=mvConflictFro}const res=await apiPost('/accounts/bank-audit/entries/'+mv.id+'/manual-verify',payload);setMv(null);setSe(null);setShowMvForm(false);setMvResults([]);setMvShowResults(false);setMvConflict(null);setMvConflictFro('');setTo({msg:res?.message||'Entry manually verified',type:'success',vis:true});await load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setMvSub(false)}};
  const saveMvDetails=async()=>{if(!mv||mvSub)return;setMvSub(true);try{await apiPut('/accounts/bank-audit/entries/'+mv.id+'/manual-verify-details',{fro_worker_id:mvFro||null,verify_type:mvType||null,verify_fro_worker_id:mvFro||null,donor_mobile:mvMobile||null,donor_name:mvName||null,donor_address:mvAddr||null,donor_pan:mvPan||null,donor_email:mvEmail||null,donor_city:mvCity||null,donor_pin_code:mvPinCode||null,donor_address_2:mvAddr2||null,donor_id:mvDonorId||null});setMvSaved(true);setTo({msg:'Details saved successfully',type:'success',vis:true});await load(sd,st)}catch(e){setTo({msg:e.message,type:'error',vis:true})}finally{setMvSub(false)}};
  const mvBlurTimerRef=useRef(null);
  const blurSaveMv=useCallback(()=>{
    if(!mv)return;
    if(mvBlurTimerRef.current)clearTimeout(mvBlurTimerRef.current);
    mvBlurTimerRef.current=setTimeout(async()=>{
      try{await apiPut('/accounts/bank-audit/entries/'+mv.id+'/manual-verify-details',{fro_worker_id:mvFro||null,verify_type:mvType||null,verify_fro_worker_id:mvFro||null,donor_mobile:mvMobile||null,donor_name:mvName||null,donor_address:mvAddr||null,donor_pan:mvPan||null,donor_email:mvEmail||null,donor_city:mvCity||null,donor_pin_code:mvPinCode||null,donor_address_2:mvAddr2||null,donor_id:mvDonorId||null});setMvSaved(true)}catch(_){}
    },600);
  },[mv,mvFro,mvType,mvMobile,mvName,mvAddr,mvPan,mvEmail,mvCity,mvPinCode,mvAddr2,mvDonorId]);
  const handleDownloadReceipt=async()=>{setDl(true);try{await downloadSinglePDF(receiptRef.current,entryToDonor(rp),rp.project_id||'bsct')}catch(e){setTo({msg:'Failed to download PDF: '+e.message,type:'error',vis:true})}setDl(false)};
  const handlePrintReceipt=()=>{const pw=window.open('','_blank');if(!pw){setTo({msg:'Please allow pop-ups to print',type:'error',vis:true});return}pw.document.write(`<html><head><title>Donation Receipt</title><style>body{font-family:Arial,sans-serif;padding:20px}@media print{body{padding:0}}</style></head><body>${receiptRef.current.innerHTML}</body></html>`);pw.document.close();pw.focus();setTimeout(()=>pw.print(),500)};
  const SvgX=()=><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
  const ddStyle={position:'fixed',zIndex:9999,background:'#fff',border:'1px solid #e5e7eb',borderRadius:8,boxShadow:'0 4px 16px rgba(0,0,0,.12)',marginTop:4};
  const [mvDdPos, setMvDdPos] = useState(null);
  const updateMvDdPos = useCallback(() => { if (mvSearchRef.current) { const r = mvSearchRef.current.getBoundingClientRect(); setMvDdPos({ top: r.bottom + 4, left: r.left, width: r.width }); } }, []);
  useEffect(() => { if (mvShowResults) updateMvDdPos(); }, [mvShowResults, updateMvDdPos]);
  useEffect(() => { if (!mvShowResults) return; const h = () => updateMvDdPos(); window.addEventListener('scroll', h, true); window.addEventListener('resize', h); return () => { window.removeEventListener('scroll', h, true); window.removeEventListener('resize', h); }; }, [mvShowResults, updateMvDdPos]);
  const renderMvDropdown=()=>{
    if(!mvShowResults||!mvDdPos) return null;
    const ps={...ddStyle,top:mvDdPos.top,left:mvDdPos.left,width:mvDdPos.width};
    if(mvSearching) return createPortal(<div data-mv style={{...ps,padding:'10px 12px',fontSize:12,color:'#6b7280'}}>Searching donors...</div>,document.body);
    if(mvResults.length>0) return createPortal(<div data-mv style={{...ps,maxHeight:180,overflowY:'auto'}}>
      {mvResults.slice(0,6).map((d,i)=>{
        const last=i===mvResults.length-1;
        return <div key={d.id||i} onMouseDown={e=>{e.preventDefault();selectMvDonor(d)}} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 12px',cursor:'pointer',borderBottom:last?'none':'1px solid #f3f4f6',fontSize:12,transition:'background .1s'}} onMouseOver={e=>e.currentTarget.style.background='#f0fdf4'} onMouseOut={e=>e.currentTarget.style.background='#fff'}>
          <div style={{width:28,height:28,borderRadius:'50%',background:'var(--sage)',display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:10,fontWeight:700,flexShrink:0}}>{(d.name||'?')[0].toUpperCase()}</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,color:'#111827',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{d.name||'Unknown'}</div>
            <div style={{fontSize:10,color:'#6b7280',marginTop:1,display:'flex',gap:8,flexWrap:'wrap'}}>{d.mobile_number&&<span>{d.mobile_number}</span>}{d.city&&<span>{d.city}</span>}</div>
          </div>
        </div>;
      })}
    </div>,document.body);
    return createPortal(<div data-mv style={{...ps,padding:'10px 12px',fontSize:12,color:'#9ca3af'}}>No donor found — will create new</div>,document.body);
  };

  const renderEntryFields=(isEdit,seEntry)=>(
    <>
      <FieldSection title="Transaction Details">
        <div className="fg2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Mode of Payment <span style={{color:'#9ca3af',fontWeight:400}}>— optional</span></span>
            <select className="field-input" value={modeSet.has(fm.mode)?fm.mode:''} onChange={e=>{setFm(p=>({...p,mode:e.target.value}));if(fer)setFer('')}} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}>
              <option value="">Select mode...</option>
              {modeList.filter(m=>m!=='others').map(m=><option key={m} value={m}>{m[0].toUpperCase()+m.slice(1)}</option>)}
            </select>
            {fm.mode==='others'&&<input className="field-input" placeholder="Type your mode..." value={fm.modeCustom||''} onChange={e=>setFm(p=>({...p,modeCustom:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>}
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Received Bank <span style={{color:'#dc2626'}}>*</span></span>
            <select className="field-input" value={fm.src_id} disabled={isEdit&&seEntry&&isReceiptSuspense(seEntry)} onChange={e=>{setFm(p=>({...p,src_id:e.target.value}));if(fer)setFer('')}} style={{...fieldStyle,background:isEdit&&seEntry&&isReceiptSuspense(seEntry)?'#f3f4f6':'#fff'}} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}>
              <option value="">Select received bank...</option>
              {bankSrcs.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        </div>
        <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5,marginTop:14}}>
          <span>Amount (₹) <span style={{color:'#dc2626'}}>*</span></span>
          <input className="field-input" type="number" min="0.01" step="0.01" placeholder="0.00" value={fm.amount} onChange={e=>{setFm(p=>({...p,amount:e.target.value}));if(fer)setFer('')}} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
        </label>
        <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5,marginTop:14}}>
          <span>NGO</span>
          <select className="field-input" value={fm.project_id||''} onChange={e=>setFm(p=>({...p,project_id:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}>
            {Object.entries(NGO_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            <option value="" disabled>Select NGO...</option>
          </select>
        </label>
      </FieldSection>

      <FieldSection title="Date & Time">
        <div className="fg2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Transaction Date <span style={{color:'#dc2626'}}>*</span></span>
            <ModernDateInput value={fm.transaction_date} max={new Date(Date.now()+5.5*60*60*1000)} onChange={d=>{setFm(p=>({...p,transaction_date:d}));if(fer)setFer('')}} />
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Payment Time {!isEdit&&<span style={{color:'#dc2626'}}>*</span>}</span>
            <input className="field-input" type="text" placeholder="HH:MM" value={fm.payment_time||''} onChange={e=>setFm(p=>({...p,payment_time:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
          </label>
        </div>
      </FieldSection>

      <FieldSection title="Additional Info">
        <div className="fg2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Payer Name</span>
            <input className="field-input" placeholder="e.g. Ravi Kumar" value={fm.payer_name} onChange={e=>setFm(p=>({...p,payer_name:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Payment ID</span>
            <input className="field-input" placeholder="e.g. pay_xxx" value={fm.payment_id} onChange={e=>setFm(p=>({...p,payment_id:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Check ID</span>
            <input className="field-input" placeholder="e.g. chk_xxx" value={fm.check_id} onChange={e=>setFm(p=>({...p,check_id:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Remarks</span>
            <input className="field-input" placeholder="Optional note..." value={fm.remarks} onChange={e=>setFm(p=>({...p,remarks:e.target.value}))} style={fieldStyle} onFocus={e=>{Object.assign(e.currentTarget.style,fieldFocus)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none'}}/>
          </label>
        </div>
      </FieldSection>

      {isEdit&&!showMvForm&&<FieldSection title="Agent & Lead Link">
        <div className="fg2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,alignItems:'start'}}>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Agent (FRO) <span style={{color:'#9ca3af',fontWeight:400}}>— optional</span></span>
            <AgentPicker value={fm.agent_name||''} workers={wr} onChange={n=>setFm(p=>({...p,agent_name:n}))}/>
          </label>
          <label style={{fontSize:12,fontWeight:500,color:'#374151',display:'flex',flexDirection:'column',gap:5}}>
            <span>Log / Lead Verification <span style={{color:'#9ca3af',fontWeight:400}}>— optional</span></span>
            <LeadPicker value={fm.log_id} locked={!!(isEdit&&seEntry&&!isReceiptSuspense(seEntry)&&seEntry.log_id)} onPick={pickLead} onClear={clearLead}/>
          </label>
        </div>
        {fm.log_id&&fm._lead_amount!=null&&fm.amount!==''&&Number(fm.amount)!==Number(fm._lead_amount)&&
          <div style={{marginTop:10,padding:'9px 12px',background:'#fffbeb',border:'1px solid #fde68a',borderRadius:8,fontSize:12,color:'#92400e',display:'flex',alignItems:'center',gap:8}}>
            <span style={{width:16,height:16,borderRadius:'50%',background:'#f59e0b',color:'#fff',display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:700,flexShrink:0}}>!</span>
            <span>Amount <strong>{curr(fm.amount)}</strong> differs from the linked lead <strong>{curr(fm._lead_amount)}</strong></span>
          </div>}
      </FieldSection>}
    </>
  );

  const openDetail=(entry)=>{openE(entry)};

  return <div>
    {!embedded&&<div style={{marginBottom:16}}><AuditStatCards sources={sr} summary={su} loading={ld} suspenseNgo={snf} setSuspenseNgo={setSnf} combo={combo}/></div>}

    {leadFilter&&(
      <div style={{display:'flex',alignItems:'center',gap:8,background:'#f0f7ef',border:'1px solid #cfe3cb',borderRadius:10,padding:'8px 12px',marginBottom:12,fontSize:12,color:'#5B6B4E',flexWrap:'wrap'}}>
        <span style={{fontWeight:700,textTransform:'uppercase',letterSpacing:'.4px'}}>Filter</span>
        <span style={{fontWeight:600,whiteSpace:'nowrap'}}>{'\u20B9'}{Number(leadFilter.amount||0).toLocaleString('en-IN')}</span>
        {leadFilter.ngo&&<span style={{whiteSpace:'nowrap'}}>{'\u00B7'} {({bsct:'Being Sevak',mann:'Mann Care',aflf:'Ashray'})[leadFilter.ngo]||leadFilter.ngo}</span>}
      </div>
    )}

    <EntrySection
      loading={ld} entries={e} sources={sr} summary={su} error={er}
      statusTab={st} setStatusTab={setSt}
      selDate={sd} setSelDate={setSd} selDay={dd} setSelDay={setDd} doLoad={load}
      ngoFilter={ngoFilter} setNgoFilter={setNf} hideNgoFilter={useGlobalNgo}
      showAdd={sa} setShowAdd={setSa} showSrc={ss} setShowSrc={setSs}
      amountFilter={amountFilter} dateFilter={dateFilter} sharedListRef={listRef} onListScroll={onListScroll} locked={locked}
      form={fm} setForm={setFm}
      handleAdd={addEntry} handleDelete={setDci}
      handleAddSrc={addSrc} handleDelSrc={delSrc}
      sn={snn} setSn={setSnn} getSrcName={getSrc} filtered={fe} SvgX={SvgX} onOpen={openDetail}
      confirmMatch={confirmMatch} clearMatch={clearMatch} cm={cm}
      selectedEntryId={selectedEntryId} onSelectEntry={onSelectEntry} selectionEnabled={selectionEnabled}
      leadFilterKey={leadFilter ? `${leadFilter.amount}|${leadFilter.ngo || ''}` : ''}
    />

    {/* Add Entry Modal */}
    {sa&&(()=>{const isEdit=false;return <div className="modal-overlay" onClick={()=>{setSa(false);setFer('')}}><div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:760,borderRadius:14,overflow:'hidden',borderTop:'3px solid var(--sage)'}}>
      <div className="modal-body" style={{padding:'20px 24px',maxHeight:'72vh',overflowY:'auto'}}>
        {renderEntryFields(false,null)}


      </div>
      <div style={{padding:'16px 24px',borderTop:'1px solid #eef0f3',display:'flex',gap:10,justifyContent:'flex-end',background:'#fafafa',borderRadius:'0 0 14px 14px'}}>
        <button className="btn btn-sm" onClick={()=>{setSa(false);setFer('')}} style={{padding:'9px 18px',borderRadius:8,fontSize:12,fontWeight:600,border:'1px solid #d1d5db',background:'#fff',color:'#374151',cursor:'pointer',transition:'all .15s'}} onMouseOver={e=>{e.currentTarget.style.background='#f3f4f6'}} onMouseOut={e=>{e.currentTarget.style.background='#fff'}}>Cancel</button>
        <button className="btn btn-sm" onClick={addEntry} disabled={sv} style={{padding:'9px 22px',borderRadius:8,fontSize:12,fontWeight:600,background:'var(--sage)',color:'#fff',border:'none',display:'inline-flex',alignItems:'center',gap:6,opacity:sv?.6:1,cursor:sv?'not-allowed':'pointer',transition:'all .15s'}} onMouseOver={e=>{e.currentTarget.style.filter='brightness(.95)'}} onMouseOut={e=>{e.currentTarget.style.filter='none'}}>
          {sv?'Adding...':'Add Entry'}
        </button>
      </div>
    </div></div>})()}

    {/* Sources Modal */}
    {ss&&<div className="modal-overlay" onClick={()=>setSs(false)}><div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:420,borderRadius:12}}>
      <div className="modal-head"><h3 style={{fontSize:16,fontWeight:700}}>Manage Sources</h3><button className="btn btn-sm btn-icon" onClick={()=>setSs(false)} style={{padding:4}}><SvgX/></button></div>
      <div className="modal-body" style={{padding:20,maxHeight:'65vh',overflowY:'auto'}}>
        <div style={{display:'flex',gap:6,marginBottom:14}}>
          {[['Received Banks','bank'],['Modes of Payment','mop']].map(([label,key])=>
            <button key={key} onClick={()=>{setSrcTab(key);setSnn('')}} style={{flex:1,padding:'6px 8px',fontSize:12,fontWeight:600,borderRadius:8,cursor:'pointer',border:'1px solid '+(srcTab===key?'#2563eb':'#e5e7eb'),background:srcTab===key?'#eff6ff':'#fff',color:srcTab===key?'#2563eb':'#6b7280'}}>{label}</button>)}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr auto',gap:8,marginBottom:12}}>
          <input className="field-input" value={snn} onChange={e=>setSnn(e.target.value)} placeholder={srcTab==='mop'?'New payment mode name':'New received bank name'} onKeyDown={e=>e.key==='Enter'&&addSrc()}/>
          <button className="btn btn-primary btn-sm" onClick={addSrc}>Add</button>
        </div>
        {sr.filter(s=>(s.kind||'bank')===srcTab).map(s=><div key={s.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 0',borderBottom:'1px solid #f3f4f6',fontSize:13,gap:8}}>
          <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</span>
          <button className="btn btn-sm" onClick={()=>delSrc(s.id)} style={{fontSize:11,padding:'2px 8px',color:'#dc2626',background:'none',border:'1px solid #fecaca',borderRadius:6}}>Delete</button>
        </div>)}
      </div>
    </div></div>}

    {/* Delete Confirmation Modal */}
    {dci&&<div className="modal-overlay" onClick={()=>setDci(null)}><div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:400,borderRadius:12}}>
      <div className="modal-head"><h3 style={{fontSize:16,fontWeight:700}}>Delete Entry</h3><button className="btn btn-sm btn-icon" onClick={()=>setDci(null)} style={{padding:4}}><SvgX/></button></div>
      <div className="modal-body" style={{padding:20,textAlign:'center'}}>
        <div style={{width:48,height:48,borderRadius:'50%',background:'#fef2f2',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 14px'}}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </div>
        <p style={{fontSize:14,fontWeight:600,color:'#111827',margin:'0 0 6px'}}>Are you sure you want to delete this entry?</p>
        <p style={{fontSize:12,color:'#6b7280',margin:0}}>This action cannot be undone.</p>
        <div style={{display:'flex',gap:10,justifyContent:'center',marginTop:18}}>
          <button className="btn btn-sm" onClick={()=>setDci(null)} style={{padding:'6px 18px'}}>Cancel</button>
          <button className="btn btn-sm" onClick={delEntry} style={{padding:'6px 18px',background:'#dc2626',color:'#fff',border:'none'}}>Delete</button>
        </div>
      </div>
    </div></div>}

    {/* Entry Editor (Sidebar). Only true suspense-pool receipts (suspense-
        prefixed ids) get the Suspense styling — a plain unclaimed bank entry
        is still an Entry Editor row. */}
    {se&&<RightPanel open={!!se} onClose={()=>{setSe(null);setShowMvForm(false);setMv(null);setMvResults([]);setMvShowResults(false)}} topOffset={72} title={isReceiptSuspense(se)?'Suspense Receipt':'Entry Editor'} subtitle={se.transaction_date||''} accent={isReceiptSuspense(se)?'#B5603A':'var(--sage)'} icon={<Landmark size={19} strokeWidth={2} />}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
        <div style={{fontSize:24,fontWeight:700,color:isReceiptSuspense(se)?'#B5603A':'var(--sage)'}}>{curr(se.amount)}</div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {isReceiptSuspense(se)
            ? <span style={{fontSize:8,padding:'2px 6px',borderRadius:3,background:'#FDE7DB',color:'#B5603A',fontWeight:700,letterSpacing:'.4px'}}>SUSPENSE</span>
            : <span className="pill pill-gray" style={{fontSize:8,padding:'2px 6px'}}>{se.bank_audit_sources?.name||getSrc(se.source_id)}</span>}
          {(se.receipt_id||se.receipt_no)&&<span className="pill pill-green" style={{fontSize:8,padding:'2px 6px'}}>RECEIPT ISSUED</span>}
        </div>
      </div>

      {st==='unverified'&&!isReceiptSuspense(se)&&se.match_status==='matched'&&<div style={{display:'flex',gap:10,marginBottom:14,padding:'10px 12px',background:se.match_source==='static_fro'?'#fefce8':'#f0fdf4',border:`1px solid ${se.match_source==='static_fro'?'#fde68a':'#86efac'}`,borderRadius:10,alignItems:'center'}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:10,fontWeight:700,letterSpacing:'.6px',color:se.match_source==='static_fro'?'#92400e':'#166534'}}>{se.match_source==='static_fro'?'STATIC FRO VERIFIED':'MATCHED'}</div>
          <div style={{fontSize:12,color:se.match_source==='static_fro'?'#92400e':'#166534',marginTop:2,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{se.agent_name||''}{se.match_donor?` · ${se.match_donor}`:''}</div>
          {se.editable_until&&<div style={{fontSize:10,color:'#92400e',marginTop:2}}>Editable until {new Date(se.editable_until).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})}</div>}
        </div>
        <div style={{display:'flex',gap:8,flexShrink:0}}>
          <button className="btn btn-sm" style={{background:'var(--sage)',color:'#fff',border:'none'}} disabled={cm} onClick={()=>confirmMatch(se)}>Confirm</button>
          <button className="btn btn-sm" style={{background:'#f3f4f6',color:'#6b7280',border:'none'}} disabled={cm} onClick={()=>clearMatch(se)}>Clear</button>
        </div>
      </div>}

      {renderEntryFields(true,se)}

      {st==='unverified'&&(showMvForm||mv)&&(mv||showMvForm)&&<div ref={mvFormRef} style={{margin:'16px 0',padding:'16px',background:'#f8fdf8',border:'1.5px solid #cfe3cb',borderRadius:10}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div style={{width:28,height:28,borderRadius:8,background:'#dcfce7',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            </div>
            <span style={{fontSize:13,fontWeight:700,color:'#111827'}}>Manual Verify</span>
            {mvSaved&&<span title="Manual verify details saved" style={{fontSize:10,fontWeight:700,letterSpacing:'.3px',color:'#166534',background:'#dcfce7',border:'1px solid #86efac',padding:'2px 8px',borderRadius:999,textTransform:'uppercase'}}>Saved{(mvFro&&(wr.find(w=>w.id===mvFro)||wr.find(w=>w.id===String(mvFro)))?.name)?` · ${wr.find(w=>w.id===mvFro||w.id===String(mvFro)).name}`:''}</span>}
            <span style={{fontSize:20,fontWeight:700,color:'var(--sage)'}}>{curr(mv?.amount||0)}</span>
          </div>
          <button onClick={()=>{setShowMvForm(false);setMv(null);setMvErr('')}} style={{width:24,height:24,borderRadius:6,border:'none',background:'transparent',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',color:'#9ca3af',transition:'all .15s'}} onMouseOver={e=>{e.currentTarget.style.background='#fee2e2';e.currentTarget.style.color='#dc2626'}} onMouseOut={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='#9ca3af'}}><SvgX/></button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:14}}>
          <div style={{gridColumn:'1 / -1'}}>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>FRO <span style={{color:'#9ca3af',fontWeight:400,textTransform:'none',letterSpacing:0}}>— optional</span></label>
             <FroSearchPicker value={mvFro} fros={wr.filter(w=>String(w.department||'').toLowerCase()==='fro')} onChange={id=>{setMvFro(id);setMvErr('');setTimeout(blurSaveMv,0);setTimeout(()=>checkDonorConflict(mvMobile),0)}}/>
          </div>
          {mvConflict&&mvConflict.length>0&&(
            <div style={{gridColumn:'1 / -1',background:'#fef3c7',border:'1px solid #f59e0b',borderRadius:8,padding:'10px 14px',fontSize:12,color:'#92400e'}}>
              <div style={{fontWeight:700,marginBottom:6}}>This donor is already assigned to:</div>
              {mvConflict.map((a,i)=>(
                <div key={i} style={{display:'flex',alignItems:'center',gap:6,marginBottom:3}}>
                  <span style={{fontWeight:600}}>{a.fro_name}</span>
                  {a.ngo_name&&<span style={{fontSize:10,background:'#fde68a',padding:'1px 6px',borderRadius:4}}>{a.ngo_name}</span>}
                  {a.station&&<span style={{fontSize:10,color:'#92400e'}}>({a.station})</span>}
                </div>
              ))}
              <div style={{marginTop:6,fontSize:11,fontWeight:600}}>Credit will go to you.</div>
            </div>
          )}
          <div ref={mvSearchRef} style={{position:'relative',gridColumn:'1 / -1'}}>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Donor Mobile <span style={{color:'#dc2626'}}>*</span></label>
            <input type="tel" autoComplete="off" value={mvMobile} onChange={e=>searchMvDonors(e.target.value)} placeholder="e.g. 9876543210" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)';if(mvResults.length)setMvShowResults(true)}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';setTimeout(()=>setMvShowResults(false),200);blurSaveMv();checkDonorConflict(mvMobile)}}/>
            {renderMvDropdown()}
          </div>
          <div>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Donor Name <span style={{color:'#9ca3af',fontWeight:400,textTransform:'none',letterSpacing:0}}>— used if new</span></label>
            <input value={mvName} onChange={e=>setMvName(e.target.value)} placeholder="Optional" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';blurSaveMv()}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Donor Address</label>
            <input value={mvAddr} onChange={e=>setMvAddr(e.target.value)} placeholder="Optional" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';blurSaveMv()}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Donor PAN</label>
            <input value={mvPan} onChange={e=>setMvPan(e.target.value.toUpperCase())} placeholder="Optional" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',textTransform:'uppercase',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';blurSaveMv()}}/>
          </div>
          <div>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Email</label>
            <input value={mvEmail} onChange={e=>setMvEmail(e.target.value)} placeholder="Optional" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';blurSaveMv()}}/>
          </div>

          <div style={{gridColumn:'1 / -1'}}>
            <label style={{display:'block',fontSize:11,fontWeight:600,color:'#6b7280',marginBottom:5,textTransform:'uppercase',letterSpacing:'.4px'}}>Address Line 2</label>
            <input value={mvAddr2} onChange={e=>setMvAddr2(e.target.value)} placeholder="Optional" style={{width:'100%',padding:'9px 12px',borderRadius:8,border:'1.5px solid #e5e7eb',fontSize:13,boxSizing:'border-box',outline:'none',transition:'border-color .15s, box-shadow .15s'}} onFocus={e=>{e.currentTarget.style.borderColor='var(--sage)';e.currentTarget.style.boxShadow='0 0 0 3px rgba(22,163,74,.08)'}} onBlur={e=>{e.currentTarget.style.borderColor='#e5e7eb';e.currentTarget.style.boxShadow='none';blurSaveMv()}}/>
          </div>
        </div>

        <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
          <button className="btn btn-sm" onClick={saveMvDetails} disabled={mvSub} style={{padding:'8px 16px',borderRadius:8,fontSize:12,fontWeight:600,background:'#111827',color:'#fff',border:'none',cursor:'pointer'}}>{mvSub?'Saving...':'Save'}</button>
          <button className="btn btn-sm" onClick={()=>{setShowMvForm(false);setMv(null);setMvResults([]);setMvShowResults(false)}} disabled={mvSub} style={{padding:'8px 16px',borderRadius:8,fontSize:12,fontWeight:600,border:'1px solid #d1d5db',background:'#fff',color:'#374151',cursor:'pointer'}}>Cancel</button>
          <button className="btn btn-sm" style={{background: mvSearched ? '#059669' : '#9ca3af',color:'#fff',border:'none',fontWeight:600,padding:'8px 18px',borderRadius:8,fontSize:12,display:'inline-flex',alignItems:'center',gap:6,opacity:(mvSub||!mvSearched)?.6:1,cursor:(mvSub||!mvSearched)?'not-allowed':'pointer',transition:'all .15s'}} onClick={handleManualVerify} disabled={mvSub||!mvSearched} onMouseOver={e=>{e.currentTarget.style.filter='brightness(.95)'}} onMouseOut={e=>{e.currentTarget.style.filter='none'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            {mvSub?'Verifying...':'Verify & Generate Receipt'}
          </button>
        </div>
      </div>}

      <div style={{position:'sticky',bottom:-18,margin:'16px -18px -18px',padding:'12px 18px',background:'rgba(255,255,255,.97)',borderTop:'1px solid #e5e7eb',boxShadow:'0 -2px 12px rgba(0,0,0,.06)'}}>
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          {st==='unverified'&&!showMvForm&&!mv&&<button title="Manual Verify (FRO + Donor)" style={{flex:1,height:42,padding:'0 14px',display:'flex',alignItems:'center',justifyContent:'center',gap:7,background:'#059669',color:'#fff',border:'none',borderRadius:10,cursor:'pointer',fontSize:13,fontWeight:600,whiteSpace:'nowrap',transition:'all .15s'}} onClick={()=>openManualVerify(se)} onMouseOver={e=>{e.currentTarget.style.filter='brightness(.92)';e.currentTarget.style.transform='translateY(-1px)'}} onMouseOut={e=>{e.currentTarget.style.filter='none';e.currentTarget.style.transform='none'}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            Manual Verify
          </button>}
          {!showMvForm&&<button title={sv?'Saving...':'Save Changes'} style={{flex:1,height:42,padding:'0 14px',display:'flex',alignItems:'center',justifyContent:'center',gap:7,background:'var(--sage)',color:'#fff',border:'none',borderRadius:10,cursor:sv?'not-allowed':'pointer',opacity:sv?.6:1,fontSize:13,fontWeight:600,whiteSpace:'nowrap',transition:'all .15s'}} disabled={sv} onClick={editEntry} onMouseOver={e=>{if(!sv){e.currentTarget.style.filter='brightness(.92)';e.currentTarget.style.transform='translateY(-1px)'}}} onMouseOut={e=>{e.currentTarget.style.filter='none';e.currentTarget.style.transform='none'}}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.34"/><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"/></svg>
            {sv?'Saving...':'Save'}
          </button>}
          <button title="Delete" style={{width:42,height:42,padding:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#fef2f2',color:'#dc2626',border:'1.5px solid #fecaca',borderRadius:10,cursor:'pointer',flexShrink:0,transition:'all .15s'}} onClick={()=>{setDci(se);setSe(null)}} onMouseOver={e=>{e.currentTarget.style.background='#fee2e2';e.currentTarget.style.transform='translateY(-1px)'}} onMouseOut={e=>{e.currentTarget.style.background='#fef2f2';e.currentTarget.style.transform='none'}}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    </RightPanel>}

    {/* Receipt Preview Modal */}
    {rp&&(()=>{const donor=entryToDonor(rp);const ngo=donor['Project']||'bsct';const tpl=getNgoSettings(ngo);const Comp=tpl.comp;return <div className="modal-overlay" onClick={()=>setRp(null)} style={{zIndex:1000}}>
      <div className="modal" style={{width:'95%',maxWidth:1060,height:'95vh',display:'flex',flexDirection:'column'}} onClick={e=>e.stopPropagation()}>
        <div className="modal-header" style={{flexShrink:0}}>
          <h3 style={{fontSize:15}}>{donor['Donor Name']} — {tpl.label}</h3>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <button className="btn btn-primary btn-sm" onClick={handleDownloadReceipt} disabled={dl}>{dl?'Generating...':'Download PDF'}</button>
            <button className="btn btn-sm" onClick={handlePrintReceipt}>Print</button>
            <button className="btn btn-sm" onClick={()=>setRp(null)}>Close</button>
          </div>
        </div>
        <div className="modal-body" style={{flex:1,overflow:'auto',padding:20,display:'flex',justifyContent:'center'}}>
          <div ref={receiptRef} data-receipt style={{display:'inline-block',transform:'scale(0.7)',transformOrigin:'top center'}}>
            <Comp donor={donor} project={ngo} />
          </div>
        </div>
      </div>
    </div>})()}

    <Toast message={to.msg} type={to.type} visible={to.vis} onClose={()=>setTo(p=>({...p,vis:false}))}/>
    <SuspenseToast entries={suspenseToasts} onDismiss={(id)=>setSuspenseToasts(prev=>prev.filter(t=>t._toastId!==id))} onNavigate={()=>{setSuspenseToasts([]);navigate('/accounts/leads')}}/>
  </div>;
}
