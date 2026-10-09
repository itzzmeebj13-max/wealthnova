import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import {
  getGetAdminDepositRequestsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetDepositDecisionAuditQueryKey,
  getGetMyDepositRequestsQueryKey,
  useApproveDepositRequest,
  useGetCurrentUser,
  useGetAdminDepositRequests,
  useGetDepositDecisionAudit,
  useRejectDepositRequest,
} from '@workspace/api-client-react';
import type { AdminDeposit } from '@workspace/api-client-react';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const FILTERS = [
  ['ALL', 'All'],
  ['PENDING_VERIFICATION', 'Pending'],
  ['APPROVED', 'Approved'],
  ['REJECTED', 'Rejected'],
] as const;
type Filter = (typeof FILTERS)[number][0];
const LABEL: Record<string, string> = { PENDING_VERIFICATION: 'Pending Verification', APPROVED: 'Approved', REJECTED: 'Rejected' };
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

function peso(v: string) {
  return `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function when(v: string | null) {
  return v ? new Date(v).toLocaleString() : '—';
}
function msg(e: unknown, fb: string) {
  const err = e as { message?: string; data?: { error?: string } } | null;
  return err?.data?.error || err?.message || fb;
}

function Audit({ id }: { id: string }) {
  const q = useGetDepositDecisionAudit(id, { query: { enabled: true, queryKey: getGetDepositDecisionAuditQueryKey(id) } });
  return (
    <div className="wn-confirm" data-testid={`panel-audit-${id}`}>
      <strong style={{ fontSize: 13 }}>Decision audit log</strong>
      {q.isLoading && <div className="wn-skeleton" style={{ height: 40, marginTop: 8 }} />}
      {q.isError && <div className="wn-feedback error" role="alert" style={{ marginTop: 8 }}>{msg(q.error, 'Could not load audit log.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>}
      {q.data && q.data.length === 0 && <p style={{ margin: '8px 0 0' }}>No decisions recorded.</p>}
      {q.data?.map(a => (
        <div key={a.id} className="wn-summary-row" style={{ display: 'block' }} data-testid={`audit-entry-${a.id}`}>
          <div><strong style={{ textAlign: 'left' }}>{a.decision}</strong> by {a.admin.mobileNumber} · {when(a.createdAt)}</div>
          {a.verifiedAmount && <div>Verified amount: {peso(a.verifiedAmount)}</div>}
          {a.amountDifferenceConfirmed && <div data-testid={`audit-difference-${a.id}`}>Admin acknowledged the verified amount differs from the requested amount.</div>}
          {a.verificationNote && <div style={{ whiteSpace: 'pre-wrap' }}>Note: {a.verificationNote}</div>}
          {a.rejectionReason && <div style={{ whiteSpace: 'pre-wrap' }}>Reason: {a.rejectionReason}</div>}
        </div>
      ))}
    </div>
  );
}

function Card({ d, selfId, onNotice }: { d: AdminDeposit; selfId: string; onNotice: (s: string) => void }) {
  const client = useQueryClient();
  const approve = useApproveDepositRequest(REQ);
  const reject = useRejectDepositRequest(REQ);
  const [mode, setMode] = useState<'' | 'approve' | 'reject'>('');
  const [open, setOpen] = useState(false);
  const [amt, setAmt] = useState('');
  const [ok, setOk] = useState(false);
  const [diffAck, setDiffAck] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const busy = approve.isPending || reject.isPending;
  const pending = d.status === 'PENDING_VERIFICATION';
  const self = d.user.id === selfId;
  const differs = AMOUNT_RE.test(amt) && Number(amt) > 0 && Number(amt) !== Number(d.amount);

  const done = (alreadyProcessed: boolean) => {
    void client.invalidateQueries({ queryKey: getGetAdminDepositRequestsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMyDepositRequestsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDepositDecisionAuditQueryKey(d.id) });
    onNotice(alreadyProcessed ? `Deposit ${d.id} was already processed. No extra credit was made.` : `Deposit ${d.id} decision recorded.`);
    setMode(''); setAmt(''); setOk(false); setDiffAck(false); setNote(''); setReason(''); setErr('');
  };
  const onError = (e: unknown) => setErr(msg(e, 'Could not record the decision.'));

  const sendApprove = () => {
    if (busy) return;
    setErr('');
    const n = note.trim();
    if (!AMOUNT_RE.test(amt)) return setErr('Enter the amount you confirmed, up to 2 decimals.');
    if (!(Number(amt) > 0)) return setErr('Verified amount must be greater than zero.');
    if (differs && !diffAck) return setErr('Acknowledge that the verified payment differs from the requested amount.');
    if (!ok) return setErr('Confirm you independently verified the payment.');
    if (n.length < 10 || n.length > 1000) return setErr('Verification note must be 10–1000 characters.');
    approve.mutate({ depositId: d.id, data: { verifiedAmount: amt, confirmedPaymentReceived: ok, confirmedAmountDifference: differs && diffAck, verificationNote: n } }, { onSuccess: r => done(r.alreadyProcessed), onError });
  };
  const sendReject = () => {
    if (busy) return;
    setErr('');
    const r = reason.trim();
    if (r.length < 5 || r.length > 1000) return setErr('Reason must be 5–1000 characters.');
    reject.mutate({ depositId: d.id, data: { reason: r } }, { onSuccess: x => done(x.alreadyProcessed), onError });
  };

  return (
    <article className="wn-inv" style={{ marginBottom: 12 }} data-testid={`card-deposit-${d.id}`}>
      <div className="wn-panel-head" style={{ marginBottom: 8 }}>
        <h3><span className="wn-helper" style={{ display: 'block' }}>Requested amount</span>{peso(d.amount)}</h3>
        <span className="wn-status-pill" data-testid={`status-admin-deposit-${d.id}`}>{LABEL[d.status] ?? d.status}</span>
      </div>
      <div className="wn-summary-row"><span>Member</span><strong>{d.user.mobileNumber} <small style={{ fontWeight: 500 }}>({d.user.id})</small></strong></div>
      <div className="wn-summary-row"><span>Reference</span><strong>{d.transactionReference}</strong></div>
      <div className="wn-summary-row"><span>Submitted</span><strong>{when(d.createdAt)}</strong></div>
      <div className="wn-summary-row"><span>Receipt</span><a className="wn-link" href={d.receiptUrl} target="_blank" rel="noreferrer">Open receipt</a></div>
      <img src={d.receiptUrl} alt="Receipt preview" loading="lazy" style={{ maxWidth: 160, maxHeight: 200, borderRadius: 10, border: '1px solid #e2d6bb', margin: '4px 0 8px' }} />
      {!pending && <>
        <div className="wn-summary-row"><span>Reviewer</span><strong>{d.reviewer?.mobileNumber ?? '—'}</strong></div>
        <div className="wn-summary-row"><span>Reviewed</span><strong>{when(d.reviewedAt)}</strong></div>
        {d.approvedAt && <div className="wn-summary-row"><span>Approved</span><strong>{when(d.approvedAt)}</strong></div>}
        {d.verifiedAmount && <div className="wn-summary-row"><span>Verified amount</span><strong>{peso(d.verifiedAmount)}</strong></div>}
        {d.rejectionReason && <div className="wn-summary-row"><span>Rejection reason</span><strong>{d.rejectionReason}</strong></div>}
      </>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {pending && !mode && <>
          <button className="wn-button" disabled={self} onClick={() => { setErr(''); setMode('approve'); }} data-testid={`button-approve-${d.id}`}>Approve</button>
          <button className="wn-button wn-button-quiet" onClick={() => { setErr(''); setMode('reject'); }} data-testid={`button-reject-${d.id}`}>Reject</button>
        </>}
        <button className="wn-button wn-button-light" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid={`button-audit-${d.id}`}>{open ? 'Hide audit log' : 'Audit log'}</button>
      </div>
      {pending && self && <p className="wn-helper" style={{ marginTop: 8 }} data-testid={`text-self-approval-${d.id}`}>You can’t approve your own deposit. Another administrator must review it.</p>}
      {mode === 'approve' && pending && (
        <fieldset disabled={busy} className="wn-confirm" style={{ border: 0, minWidth: 0 }}>
          <p>A receipt alone is not proof of payment. Check the receiving GCash account yourself. Requested amount: <strong>{peso(d.amount)}</strong>. Enter the exact amount you verified; only that amount is credited.</p>
          {err && <div className="wn-feedback error" role="alert" data-testid="error-admin-decision">{err}</div>}
          <div className="wn-field"><label htmlFor={`va-${d.id}`}>Amount you confirmed (PHP)</label>
            <input id={`va-${d.id}`} className="wn-input" inputMode="decimal" value={amt} onChange={e => { setAmt(e.target.value); setDiffAck(false); }} data-testid="input-verified-amount" /></div>
          {differs && <div className="wn-auth-warning" style={{ marginBottom: 14 }} data-testid="warning-amount-difference">
            <div>Requested: <strong>{peso(d.amount)}</strong></div><div>Proposed credit: <strong>{peso(amt)}</strong></div>
            <p style={{ margin: '8px 0' }}>Verify the discrepancy in the receiving account. Only the verified amount is credited; explain the difference in your note.</p>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontWeight: 700 }}><input type="checkbox" checked={diffAck} onChange={e => setDiffAck(e.target.checked)} style={{ width: 20, height: 20, flex: 'none' }} data-testid="checkbox-amount-difference" />I acknowledge the verified payment differs from the requested amount</label></div>}
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, fontWeight: 700, marginBottom: 14 }}>
            <input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} style={{ width: 20, height: 20, flex: 'none' }} data-testid="checkbox-payment-confirmed" />
            I independently confirmed this payment in the receiving GCash account
          </label>
          <div className="wn-field"><label htmlFor={`vn-${d.id}`}>Verification note (10–1000 characters)</label>
            <textarea id={`vn-${d.id}`} className="wn-input" style={{ height: 90, padding: 12 }} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} data-testid="input-verification-note" /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="wn-button" onClick={sendApprove} data-testid="button-confirm-approval">{approve.isPending && <LoaderCircle className="animate-spin" size={16} />}Confirm approval</button>
            <button className="wn-button wn-button-quiet" type="button" onClick={() => { setMode(''); setErr(''); setDiffAck(false); }}>Cancel</button>
          </div>
        </fieldset>
      )}
      {mode === 'reject' && pending && (
        <fieldset disabled={busy} className="wn-confirm" style={{ border: 0, minWidth: 0 }}>
          <p>Rejecting does not credit any wallet. The member will see your reason.</p>
          {err && <div className="wn-feedback error" role="alert" data-testid="error-admin-decision">{err}</div>}
          <div className="wn-field"><label htmlFor={`rr-${d.id}`}>Reason (5–1000 characters)</label>
            <textarea id={`rr-${d.id}`} className="wn-input" style={{ height: 90, padding: 12 }} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} data-testid="input-rejection-reason" /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="wn-button" onClick={sendReject} data-testid="button-confirm-rejection">{reject.isPending && <LoaderCircle className="animate-spin" size={16} />}Confirm rejection</button>
            <button className="wn-button wn-button-quiet" type="button" onClick={() => { setMode(''); setErr(''); setDiffAck(false); }}>Cancel</button>
          </div>
        </fieldset>
      )}
      {open && <Audit id={d.id} />}
    </article>
  );
}

export function AdminDepositDashboard() {
  const me = useGetCurrentUser();
  const isAdmin = me.data?.role === 'ADMIN';
  const [status, setStatus] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const q = useGetAdminDepositRequests({ status, page, pageSize: 20 }, { query: { enabled: isAdmin, refetchInterval: 15000, queryKey: getGetAdminDepositRequestsQueryKey({ status, page, pageSize: 20 }) } });

  const head = <div className="wn-page-head"><div className="wn-eyebrow">Administrator</div><h1 className="wn-display">Review deposits.</h1><p>Approve only after you independently confirm the payment in the receiving GCash account. A receipt image alone is not proof.</p></div>;
  if (me.data && !isAdmin) {
    return <>{head}<div className="wn-empty" role="alert" data-testid="denied-admin-deposits"><div className="wn-empty-mark"><ShieldAlert size={21} /></div><h3>Administrators only</h3><p>Your account doesn’t have access to deposit review.</p><Link href="/deposit" className="wn-link" style={{ marginTop: 14 }}>Back to deposits</Link></div></>;
  }
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return (
    <section data-testid="admin-review-dashboard">
      {head}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }} role="group" aria-label="Filter by status" data-testid="filter-admin-deposits">
        {FILTERS.map(([v, l]) => (
          <button key={v} className={`wn-button ${status === v ? '' : 'wn-button-quiet'}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }} data-testid={`filter-${v.toLowerCase()}`}>{l}</button>
        ))}
      </div>
      {notice && <div className="wn-feedback" role="status" data-testid="status-admin-notice">{notice}</div>}
      {q.isError ? <div className="wn-feedback error" role="alert">{msg(q.error, 'Could not load deposits.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>
        : !q.data ? <div className="wn-loading"><div className="wn-skeleton" /><div className="wn-skeleton" /></div>
        : q.data.items.length === 0 ? <div className="wn-empty" data-testid="empty-admin-deposits"><h3>Nothing here</h3><p>No deposit requests match this filter.</p></div>
        : <div className="wn-inv-list" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', alignItems: 'start' }}>{q.data.items.map(d => <Card key={d.id} d={d} selfId={me.data?.id ?? ''} onNotice={setNotice} />)}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 }} data-testid="page-nav">
        <button className="wn-button wn-button-quiet" disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="button-prev-page">Previous</button>
        <span className="wn-helper" data-testid="text-page">Page {q.data?.page ?? page} of {pages}</span>
        <button className="wn-button wn-button-quiet" disabled={page >= pages} onClick={() => setPage(p => p + 1)} data-testid="button-next-page">Next</button>
      </div>
    </section>
  );
}
