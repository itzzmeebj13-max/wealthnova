import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  getGetAdminCommissionsQueryKey,
  getGetAdminReferralRatesQueryKey,
  getGetCommissionAuditQueryKey,
  getGetCommissionFundQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMyCommissionsQueryKey,
  getGetMyReferralsQueryKey,
  getGetReferralNotificationsQueryKey,
  useApproveCommission,
  useGetAdminCommissions,
  useGetAdminReferralRates,
  useGetCommissionAudit,
  useGetCommissionFund,
  useGetCurrentUser,
  usePayCommission,
  useRejectCommission,
  useUpdateReferralRates,
  useUploadCompanyCapitalReceipt,
  useVerifyCompanyCapital,
} from '@workspace/api-client-react';
import type { Commission } from '@workspace/api-client-react';
import { errMsg, peso, when } from '@/components/withdrawal-content';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const FILTERS = [['ALL', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['PAID', 'Paid']] as const;
type Filter = (typeof FILTERS)[number][0];
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const PCT_RE = /^\d{1,3}(\.\d{1,2})?$/;
const chk = { width: 20, height: 20, flex: 'none' } as const;
const lbl = { display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, fontWeight: 700, marginBottom: 14 } as const;
const linkBtn = { background: 'none', border: 0, cursor: 'pointer' } as const;

function statusStatus(e: unknown) { return (e as { status?: number } | null)?.status; }

/* ---------- Rates ---------- */
function Rates() {
  const client = useQueryClient();
  const q = useGetAdminReferralRates({ query: { queryKey: getGetAdminReferralRatesQueryKey() } });
  const save = useUpdateReferralRates(REQ);
  const [f, setF] = useState<{ tier1: string; tier2: string; tier3: string } | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [stale, setStale] = useState(false);
  if (q.isError) return <section className="wn-card wn-full"><div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load rates.')} <button className="wn-link" style={linkBtn} onClick={() => void q.refetch()}>Retry</button></div></section>;
  if (!q.data) return <section className="wn-card wn-full"><div className="wn-skeleton" /></section>;
  const cur = q.data.current;
  const vals = f ?? { tier1: String(cur.tier1), tier2: String(cur.tier2), tier3: String(cur.tier3) };
  const submit = () => {
    if (save.isPending) return;
    setMsg(null);
    const keys = ['tier1', 'tier2', 'tier3'] as const;
    for (const k of keys) {
      if (!PCT_RE.test(vals[k]) || Number(vals[k]) > 100) return setMsg({ ok: false, text: 'Each rate must be 0 to 100 with at most 2 decimals.' });
    }
    if (Number(vals.tier1) + Number(vals.tier2) + Number(vals.tier3) > 100 + 1e-9) return setMsg({ ok: false, text: 'Combined rates cannot exceed 100.' });
    const r = reason.trim();
    if (r.length < 5 || r.length > 1000) return setMsg({ ok: false, text: 'Reason must be 5 to 1000 characters.' });
    save.mutate({ data: { ...vals, expectedVersion: cur.version, reason: r } }, {
      onSuccess: () => { setF(null); setReason(''); setStale(false); setMsg({ ok: true, text: 'Rates saved. They apply to future plan purchases only.' }); void client.invalidateQueries({ queryKey: getGetAdminReferralRatesQueryKey() }); void client.invalidateQueries({ queryKey: getGetMyReferralsQueryKey() }); },
      onError: e => {
        if (statusStatus(e) === 409) { setStale(true); void q.refetch(); setMsg({ ok: false, text: 'Rates were changed by someone else. The latest version is loaded; review your values and save again.' }); setF(null); }
        else setMsg({ ok: false, text: errMsg(e, 'Rates could not be saved.') });
      },
    });
  };
  return <section className="wn-card wn-full" data-testid="panel-referral-rates">
    <div className="wn-panel-head"><h2>Referral rates</h2><span className="wn-status-pill">version {cur.version}</span></div>
    <p className="wn-helper" style={{ marginBottom: 12 }}>Saved rates apply to FUTURE investment purchases. Existing commission rows keep their saved rate and rate version.</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12 }}>
      {(['tier1', 'tier2', 'tier3'] as const).map((k, i) => <div className="wn-field" key={k}><label htmlFor={`rate-${k}`}>Tier {i + 1} percent</label><input id={`rate-${k}`} className="wn-input" inputMode="decimal" value={vals[k]} onChange={e => setF({ ...vals, [k]: e.target.value })} data-testid={`input-rate-${k}`} /></div>)}
    </div>
    <div className="wn-field"><label htmlFor="rate-reason">Reason for change (5-1000 characters)</label><textarea id="rate-reason" className="wn-input" style={{ height: 80, padding: 12 }} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} data-testid="input-rate-reason" /></div>
    {stale && <p className="wn-helper">Version refreshed to {cur.version}.</p>}
    {msg && <div className={`wn-feedback${msg.ok ? '' : ' error'}`} role={msg.ok ? 'status' : 'alert'} data-testid="status-rates">{msg.text}</div>}
    <button className="wn-button" onClick={submit} disabled={save.isPending} data-testid="button-save-rates">{save.isPending && <LoaderCircle className="animate-spin" size={16} />}Save rates</button>
    <details style={{ marginTop: 16 }}><summary className="wn-helper" style={{ cursor: 'pointer' }}>Version history ({q.data.history.length})</summary>
      {q.data.history.map(h => <div className="wn-summary-row" key={h.version} style={{ display: 'block' }}><strong style={{ textAlign: 'left' }}>v{h.version}: {h.tier1}% / {h.tier2}% / {h.tier3}%</strong><div className="wn-helper">{when(h.createdAt)} by {h.changedByAccount ?? 'system'}. {h.changeReason}</div></div>)}
    </details>
  </section>;
}

/* ---------- Fund ---------- */
function Fund() {
  const client = useQueryClient();
  const q = useGetCommissionFund({ query: { queryKey: getGetCommissionFundQueryKey() } });
  const upload = useUploadCompanyCapitalReceipt(REQ);
  const verify = useVerifyCompanyCapital(REQ);
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string; name: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const frozen = useRef<{ key: string; body: { amount: string; transactionReference: string; receiptImageId: string; verificationNote: string; confirmedCapitalReceived: boolean } } | null>(null);
  const [, bump] = useState(0);
  const locked = frozen.current !== null;
  const busy = upload.isPending || verify.isPending;

  const pick = (file: File | undefined) => {
    if (!file || locked) return;
    setMsg(null);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setMsg({ ok: false, text: 'Receipt must be JPEG, PNG or WebP.' });
    if (file.size > 5 * 1024 * 1024) return setMsg({ ok: false, text: 'Receipt must be 5 MB or smaller.' });
    upload.mutate({ data: { file } }, { onSuccess: r => setReceipt({ id: r.id, name: file.name }), onError: e => setMsg({ ok: false, text: errMsg(e, 'Receipt upload failed.') }) });
  };
  const sendFrozen = () => {
    const fz = frozen.current; if (!fz || verify.isPending) return;
    verify.mutate({ data: { ...fz.body, idempotencyKey: fz.key } }, {
      onSuccess: () => { frozen.current = null; setAmount(''); setRef(''); setNote(''); setConfirmed(false); setReceipt(null); setMsg({ ok: true, text: 'Company capital recorded.' }); void client.invalidateQueries({ queryKey: getGetCommissionFundQueryKey() }); },
      onError: e => {
        const s = statusStatus(e);
        if (typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429) { frozen.current = null; setMsg({ ok: false, text: errMsg(e, 'Capital was rejected.') }); }
        else { setMsg({ ok: false, text: 'The result is unknown (network or server problem). Your entry is locked. Retry the exact same request; it will not be recorded twice.' }); }
        bump(n => n + 1);
      },
    });
    bump(n => n + 1);
  };
  const submit = () => {
    if (busy) return; setMsg(null);
    const r = ref.trim(); const n = note.trim();
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return setMsg({ ok: false, text: 'Enter a positive amount with at most 2 decimals.' });
    if (r.length < 6 || r.length > 64) return setMsg({ ok: false, text: 'Transaction reference must be 6-64 characters.' });
    if (!receipt) return setMsg({ ok: false, text: 'Upload the receipt first.' });
    if (n.length < 10 || n.length > 1000) return setMsg({ ok: false, text: 'Verification note must be 10-1000 characters.' });
    if (!confirmed) return setMsg({ ok: false, text: 'Confirm that the capital was actually received.' });
    frozen.current = { key: crypto.randomUUID(), body: { amount, transactionReference: r, receiptImageId: receipt.id, verificationNote: n, confirmedCapitalReceived: true } };
    sendFrozen();
  };
  const d = q.data;
  return <section className="wn-card wn-full" data-testid="panel-commission-fund">
    <div className="wn-panel-head"><h2>Commission fund</h2></div>
    <p className="wn-helper" style={{ marginBottom: 12 }}>Company capital is separately, actually received funding. It is not user deposits.</p>
    {q.isError ? <div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load the fund.')} <button className="wn-link" style={linkBtn} onClick={() => void q.refetch()}>Retry</button></div>
      : !d ? <div className="wn-skeleton" />
      : <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
          {[['Available reserve', d.availableBalance], ['Reserved for approved', d.reservedBalance], ['Verified capital', d.totalCapital], ['Verified fees', d.totalFees], ['Total paid', d.totalPaid]].map(([l, v]) => <div className="wn-inv" key={l}><div className="wn-card-label">{l}</div><div className="wn-stat" style={{ fontSize: 24 }} data-testid={`fund-${l.toLowerCase().replaceAll(' ', '-')}`}>{peso(v)}</div></div>)}
        </div>
        <details style={{ marginTop: 14 }}><summary className="wn-helper" style={{ cursor: 'pointer' }}>Capital evidence ({d.recentCapital.length})</summary>
          {d.recentCapital.length === 0 && <p className="wn-helper">No capital has been verified.</p>}
          {d.recentCapital.map(c => <div className="wn-summary-row" key={c.id} style={{ display: 'block' }}><strong style={{ textAlign: 'left' }}>{peso(c.amount)} · {c.transactionReference}</strong><div className="wn-helper">{when(c.createdAt)} · verified by {c.verifiedById} · {c.verificationNote} · <a className="wn-inline-link" href={`/api/deposits/images/${c.receiptImageId}`} target="_blank" rel="noreferrer">Private receipt</a></div></div>)}
        </details>
        <details style={{ marginTop: 10 }}><summary className="wn-helper" style={{ cursor: 'pointer' }}>Fund ledger ({d.entries.length})</summary>
          {d.entries.length === 0 && <p className="wn-helper">No ledger entries yet.</p>}
          {d.entries.map(e => <div className="wn-summary-row" key={e.id}><span>{e.type.replaceAll('_', ' ')} · {e.balanceBucket} · {when(e.createdAt)}<br /><small>{e.reference}</small></span><strong>{peso(e.amount)} <small>(bal {peso(e.balanceAfter)})</small></strong></div>)}
        </details>
      </>}
    <h3 style={{ margin: '22px 0 10px' }}>Record received company capital</h3>
    <fieldset disabled={locked || busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
      <div className="wn-field"><label htmlFor="cap-amount">Amount (PHP)</label><input id="cap-amount" className="wn-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} data-testid="input-capital-amount" /></div>
      <div className="wn-field"><label htmlFor="cap-ref">Transaction reference (6-64)</label><input id="cap-ref" className="wn-input" maxLength={64} value={ref} onChange={e => setRef(e.target.value)} data-testid="input-capital-reference" /></div>
      <div className="wn-field"><label htmlFor="cap-file">Receipt image (JPEG, PNG or WebP, max 5 MB)</label><input id="cap-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }} data-testid="input-capital-receipt" />{upload.isPending && <span className="wn-helper">Uploading</span>}{receipt && <span className="wn-helper">Attached: {receipt.name}</span>}</div>
      <div className="wn-field"><label htmlFor="cap-note">Verification note (10-1000)</label><textarea id="cap-note" className="wn-input" style={{ height: 80, padding: 12 }} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} data-testid="input-capital-note" /></div>
      <label style={lbl}><input type="checkbox" style={chk} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="checkbox-capital-received" />I confirm this capital was actually received by the company</label>
    </fieldset>
    {msg && <div className={`wn-feedback${msg.ok ? '' : ' error'}`} role={msg.ok ? 'status' : 'alert'} data-testid="status-capital">{msg.text}</div>}
    {locked ? <button className="wn-button" onClick={sendFrozen} disabled={verify.isPending} data-testid="button-capital-retry">{verify.isPending && <LoaderCircle className="animate-spin" size={16} />}Retry same request</button>
      : <button className="wn-button" onClick={submit} disabled={busy} data-testid="button-capital-submit">{busy && <LoaderCircle className="animate-spin" size={16} />}Record capital</button>}
  </section>;
}

/* ---------- Commissions ---------- */
function Audit({ id }: { id: string }) {
  const q = useGetCommissionAudit(id, { query: { queryKey: getGetCommissionAuditQueryKey(id) } });
  return <div className="wn-confirm" data-testid={`panel-audit-${id}`}>
    <strong style={{ fontSize: 13 }}>Decision audit log</strong>
    {!q.data && !q.isError && <div className="wn-skeleton" style={{ height: 40, marginTop: 8 }} />}
    {q.isError && <div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load audit log.')} <button className="wn-link" style={linkBtn} onClick={() => void q.refetch()}>Retry</button></div>}
    {q.data && q.data.length === 0 && <p style={{ margin: '8px 0 0' }}>No decisions recorded.</p>}
    {q.data?.map((a: { id: string; adminId: string; decision: string; note: string; createdAt: string }) => <div key={a.id} className="wn-summary-row" style={{ display: 'block' }}><strong style={{ textAlign: 'left' }}>{a.decision}</strong> by admin {a.adminId} · {when(a.createdAt)}<div style={{ whiteSpace: 'pre-wrap' }}>Note: {a.note}</div></div>)}
  </div>;
}

function Row({ c, onNotice }: { c: Commission; onNotice: (s: string) => void }) {
  const client = useQueryClient();
  const approve = useApproveCommission(REQ);
  const reject = useRejectCommission(REQ);
  const pay = usePayCommission(REQ);
  const [mode, setMode] = useState<'' | 'approve' | 'reject' | 'pay'>('');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState('');
  const busy = approve.isPending || reject.isPending || pay.isPending;
  const allowed = mode === 'approve' ? c.status === 'PENDING' : mode === 'pay' ? c.status === 'APPROVED' :
    mode === 'reject' ? (c.status === 'PENDING' || c.status === 'APPROVED') : true;
  useEffect(() => {
    if (mode && !allowed && !busy) { setMode(''); setNote(''); setOk(false); setErr(''); }
  }, [mode, allowed, busy]);
  const reset = () => { setMode(''); setNote(''); setOk(false); setErr(''); };
  const run = () => {
    if (busy || !mode || !allowed) return; setErr('');
    const n = note.trim();
    if (n.length < 5 || n.length > 1000) return setErr('Note must be 5 to 1000 characters.');
    if (!ok) return setErr('Tick the confirmation to continue.');
    const m = mode;
    const fn = m === 'approve' ? approve : m === 'reject' ? reject : pay;
    fn.mutate({ commissionId: c.id, data: { note: n, confirmed: true } }, {
      onSuccess: () => {
        for (const key of [getGetAdminCommissionsQueryKey(), getGetCommissionAuditQueryKey(c.id), getGetCommissionFundQueryKey(), getGetMyCommissionsQueryKey(), getGetMyReferralsQueryKey(), getGetReferralNotificationsQueryKey(), getGetDashboardSummaryQueryKey()]) void client.invalidateQueries({ queryKey: key });
        onNotice(m === 'approve' ? 'Commission approved and reserve held. No wallet credit yet.' : m === 'reject' ? 'Commission rejected and reserve released.' : 'Commission paid into the member wallet.');
        reset();
      },
      onError: e => setErr(errMsg(e, 'The action could not be recorded.')),
    });
  };
  const copy = { approve: 'Approving reserves verified operating money for this commission. Nothing is credited to the wallet yet.', reject: c.status === 'PENDING' ? 'Rejecting a pending commission changes no wallet or reserve funds.' : 'Rejecting an approved commission releases its reserved money back to the available reserve once.', pay: 'Paying transfers the reserved verified funds into the member wallet. This is not a GCash payout.' }[mode || 'approve'];
  return <article className="wn-inv" data-testid={`card-commission-${c.id}`}>
    <div className="wn-panel-head" style={{ marginBottom: 8 }}><h3>{peso(c.amount)}</h3><span className="wn-status-pill">{c.status}</span></div>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }} aria-label="Commission actions">
      {c.status === 'PENDING' && <button className="wn-button" disabled={busy} onClick={() => { reset(); setMode('approve'); }} data-testid={`button-approve-${c.id}`}>Approve</button>}
      {c.status === 'APPROVED' && <button className="wn-button" disabled={busy} onClick={() => { reset(); setMode('pay'); }} data-testid={`button-pay-${c.id}`}>Pay to wallet</button>}
      {(c.status === 'PENDING' || c.status === 'APPROVED') && <button className="wn-button wn-button-quiet" disabled={busy} onClick={() => { reset(); setMode('reject'); }} data-testid={`button-reject-${c.id}`}>Reject</button>}
      <button className="wn-button wn-button-light" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid={`button-audit-${c.id}`}>{open ? 'Hide audit log' : 'Audit log'}</button>
    </div>
    <div className="wn-summary-row"><span>ID</span><strong style={{ wordBreak: 'break-all' }}>{c.id}</strong></div>
    <div className="wn-summary-row"><span>Referring account</span><strong>{c.beneficiaryAccount}</strong></div>
    <div className="wn-summary-row"><span>Referred account</span><strong>{c.sourceAccount}</strong></div>
    <div className="wn-summary-row"><span>Tier</span><strong>{c.tier}</strong></div>
    <div className="wn-summary-row"><span>Source ref (internal ledger)</span><strong style={{ wordBreak: 'break-all' }}>{c.sourceTransactionReference}</strong></div>
    <div className="wn-summary-row"><span>Rate (v{c.rateVersion})</span><strong>{c.ratePercent}% of {peso(c.basisAmount)}</strong></div>
    <div className="wn-summary-row"><span>Date</span><strong>{when(c.createdAt)}</strong></div>
    {c.rejectionReason && <div className="wn-summary-row"><span>Rejection reason</span><strong>{c.rejectionReason}</strong></div>}
    {c.status === 'PENDING' && <p className="wn-helper" style={{ marginTop: 8 }}>Pending holds no wallet funds.</p>}
    <Dialog open={Boolean(mode)} onOpenChange={opened => { if (!opened && !busy) reset(); }}>
      <DialogContent style={{ width: 'calc(100vw - 32px)', maxWidth: 440 }} data-testid="dialog-commission-decision">
      <DialogHeader>
        <DialogTitle>{mode === 'approve' ? 'Approve commission' : mode === 'reject' ? 'Reject commission' : 'Pay commission to wallet'}</DialogTitle>
        <DialogDescription>{copy}</DialogDescription>
      </DialogHeader>
      <p className="wn-helper">Commission {c.id} · {peso(c.amount)} · Current status: {c.status}. The server rechecks status, source eligibility and verified reserve funds before recording approval or payment.</p>
      <fieldset disabled={busy || !allowed} style={{ border: 0, padding: 0, minWidth: 0 }}>
      {err && <div className="wn-feedback error" role="alert" data-testid="error-commission-action">{err}</div>}
      <div className="wn-field"><label htmlFor={`n-${c.id}`}>Note (5-1000 characters)</label><textarea id={`n-${c.id}`} className="wn-input" style={{ height: 80, padding: 12 }} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} data-testid="input-decision-note" /></div>
      <label style={lbl}><input type="checkbox" style={chk} checked={ok} onChange={e => setOk(e.target.checked)} data-testid="checkbox-decision-confirm" />I confirm I reviewed this commission and want to {mode === 'pay' ? 'pay it to the wallet' : mode}</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 16 }}>
        <button className="wn-button" disabled={busy || !allowed} onClick={run} data-testid="button-confirm-decision">{busy && <LoaderCircle className="animate-spin" size={16} />}Confirm {mode}</button>
        <button className="wn-button wn-button-quiet" type="button" onClick={reset}>Cancel</button>
      </div>
      </fieldset>
      </DialogContent>
    </Dialog>
    {open && <Audit id={c.id} />}
  </article>;
}

function Commissions() {
  const [status, setStatus] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const params = { status, page, ...(search ? { search } : {}) };
  const q = useGetAdminCommissions(params, { query: { queryKey: getGetAdminCommissionsQueryKey(params), refetchInterval: 15000 } });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return <section className="wn-card wn-full" data-testid="panel-admin-commissions">
    <div className="wn-panel-head"><h2>Commissions</h2></div>
    <form onSubmit={e => { e.preventDefault(); setSearch(text.trim().slice(0, 100)); setPage(1); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
      <input className="wn-input" aria-label="Search commissions" placeholder="Search account, ID or source reference" maxLength={100} value={text} onChange={e => setText(e.target.value)} data-testid="input-commission-search" />
      <button className="wn-button" type="submit" data-testid="button-commission-search">Search</button>
    </form>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }} role="group" aria-label="Filter by status">
      {FILTERS.map(([v, l]) => <button key={v} className={`wn-button ${status === v ? '' : 'wn-button-quiet'}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }} data-testid={`filter-${v.toLowerCase()}`}>{l}</button>)}
    </div>
    {notice && <div className="wn-feedback" role="status" data-testid="status-admin-notice">{notice}</div>}
    {q.isError ? <div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load commissions.')} <button className="wn-link" style={linkBtn} onClick={() => void q.refetch()}>Retry</button></div>
      : !q.data ? <div className="wn-loading"><div className="wn-skeleton" /><div className="wn-skeleton" /></div>
      : q.data.items.length === 0 ? <div className="wn-empty" data-testid="empty-admin-commissions"><h3>Nothing here</h3><p>No commissions match this filter or search.</p></div>
      : <div className="wn-inv-list" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,320px),1fr))', alignItems: 'start' }}>{q.data.items.map(c => <Row key={c.id} c={c} onNotice={setNotice} />)}</div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
      <button className="wn-button wn-button-quiet" disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="button-prev-page">Previous</button>
      <span className="wn-helper">Page {q.data?.page ?? page} of {pages}</span>
      <button className="wn-button wn-button-quiet" disabled={page >= pages} onClick={() => setPage(p => p + 1)} data-testid="button-next-page">Next</button>
    </div>
  </section>;
}

export function AdminReferralDashboard() {
  const me = useGetCurrentUser();
  const head = <div className="wn-page-head"><div className="wn-eyebrow">Administrator</div><h1 className="wn-display">Referral management.</h1><p>Rates, commission decisions and the verified commission fund. Paid means a verified transfer into the member wallet, not a GCash payout.</p></div>;
  if (me.data && me.data.role !== 'ADMIN') return <>{head}<div className="wn-empty" role="alert" data-testid="denied-admin-referrals"><div className="wn-empty-mark"><ShieldAlert size={21} /></div><h3>Administrators only</h3><p>Your account doesn’t have access to referral management.</p><Link href="/account" className="wn-link" style={{ marginTop: 14 }}>Back to account</Link></div></>;
  if (!me.data) return <>{head}<div className="wn-loading"><div className="wn-skeleton" /></div></>;
  return <section className="wn-referral-content" data-testid="admin-referral-dashboard">{head}<div className="wn-grid"><Commissions /><Rates /><Fund /></div></section>;
}
