import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import {
  getGetAdminWithdrawalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetMyWithdrawalsQueryKey,
  getGetWithdrawalAuditQueryKey,
  getGetWithdrawalSummaryQueryKey,
  useCompleteWithdrawal,
  useGetAdminWithdrawals,
  useGetCurrentUser,
  useGetWithdrawalAudit,
  useProcessWithdrawal,
  useRejectWithdrawal,
} from '@workspace/api-client-react';
import type { Withdrawal } from '@workspace/api-client-react';
import { errMsg, peso, when } from '@/components/withdrawal-content';
import { WithdrawalHandoffForm } from '@/components/withdrawal-handoff-form';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const FILTERS = [['ALL', 'All'], ['PENDING', 'Pending'], ['PROCESSING', 'Processing'], ['COMPLETED', 'Completed'], ['REJECTED', 'Rejected']] as const;
type Filter = (typeof FILTERS)[number][0];
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;

function Audit({ id }: { id: string }) {
  const q = useGetWithdrawalAudit(id, { query: { enabled: true, refetchInterval: 15000, queryKey: getGetWithdrawalAuditQueryKey(id) } });
  return (
    <div className="wn-confirm" data-testid={`panel-audit-${id}`}>
      <strong style={{ fontSize: 13 }}>Decision audit log</strong>
      {q.isLoading && <div className="wn-skeleton" style={{ height: 40, marginTop: 8 }} />}
      {q.isError && <div className="wn-feedback error" role="alert" style={{ marginTop: 8 }}>{errMsg(q.error, 'Could not load audit log.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>}
      {q.data && q.data.length === 0 && <p style={{ margin: '8px 0 0' }}>No decisions recorded.</p>}
      {q.data?.map(a => <div key={a.id} className="wn-summary-row" style={{ display: 'block' }} data-testid={`audit-entry-${a.id}`}>
        <div><strong style={{ textAlign: 'left' }}>{a.decision}</strong> by admin {a.adminId} · {when(a.createdAt)}</div>
        {a.payoutReference && <div>Reference: {a.payoutReference}</div>}
        {a.fromAdminId && <div>From: {a.fromAdminId} → To: {a.toAdminId} · Payment: {a.payoutStatus}</div>}
        <div style={{ whiteSpace: 'pre-wrap' }}>Note: {a.note}</div>
      </div>)}
    </div>
  );
}

function Card({ w, selfId, onNotice }: { w: Withdrawal; selfId: string; onNotice: (s: string) => void }) {
  const client = useQueryClient();
  const proc = useProcessWithdrawal(REQ);
  const complete = useCompleteWithdrawal(REQ);
  const reject = useRejectWithdrawal(REQ);
  const [mode, setMode] = useState<'' | 'complete' | 'reject' | 'handoff'>('');
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState('');
  const [paid, setPaid] = useState('');
  const [sent, setSent] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [noPayout, setNoPayout] = useState(false);
  const [err, setErr] = useState('');
  const busy = proc.isPending || complete.isPending || reject.isPending;
  const self = w.userId === selfId;
  const mine = w.processingById === selfId;

  const reset = () => { setMode(''); setRef(''); setPaid(''); setSent(false); setNote(''); setReason(''); setNoPayout(false); setErr(''); };
  useEffect(() => {
    // Polling must also revoke open action forms after another Admin takes over.
    reset();
  }, [w.processingById, w.status]);
  const done = (text: string) => {
    void client.invalidateQueries({ queryKey: getGetAdminWithdrawalsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetWithdrawalAuditQueryKey(w.id) });
    void client.invalidateQueries({ queryKey: getGetWithdrawalSummaryQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMyWithdrawalsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    void client.invalidateQueries({ queryKey: ['/api/portfolio'] });
    onNotice(text); reset();
  };
  const onError = (e: unknown) => setErr(errMsg(e, 'Could not record the action.'));

  const start = () => { if (busy) return; setErr(''); proc.mutate({ withdrawalId: w.id }, { onSuccess: () => done(`Withdrawal ${w.id} is now processing under you. No money has been marked as sent.`), onError }); };
  const sendComplete = () => {
    if (busy) return; setErr('');
    const r = ref.trim(); const n = note.trim();
    if (r.length < 6 || r.length > 64) return setErr('Payout reference must be 6–64 characters.');
    if (!AMOUNT_RE.test(paid) || Number(paid) !== Number(w.netAmount)) return setErr(`Actual paid amount must equal the net amount ${peso(w.netAmount)}.`);
    if (!sent) return setErr('Confirm you independently verified the GCash transfer.');
    if (n.length < 10 || n.length > 1000) return setErr('Verification note must be 10–1000 characters.');
    complete.mutate({ withdrawalId: w.id, data: { payoutReference: r, paidAmount: paid, confirmedPayoutSent: sent, verificationNote: n } }, { onSuccess: () => done(`Withdrawal ${w.id} recorded as completed.`), onError });
  };
  const sendReject = () => {
    if (busy) return; setErr('');
    const r = reason.trim();
    if (r.length < 5 || r.length > 1000) return setErr('Reason must be 5–1000 characters.');
    if (!noPayout) return setErr('Confirm that no payout was sent.');
    reject.mutate({ withdrawalId: w.id, data: { reason: r, confirmedNoPayoutSent: noPayout } }, { onSuccess: () => done(`Withdrawal ${w.id} rejected; the full amount was returned.`), onError });
  };
  const chk = { width: 20, height: 20, flex: 'none' } as const;
  const lbl = { display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, fontWeight: 700, marginBottom: 14 } as const;

  return (
    <article className="wn-inv" data-testid={`card-withdrawal-${w.id}`}>
      <div className="wn-panel-head" style={{ marginBottom: 8 }}>
        <h3><span className="wn-helper" style={{ display: 'block' }}>Requested (held)</span>{peso(w.requestedAmount)}</h3>
        <span className={`wn-status-pill wn-wd-${w.status.toLowerCase()}`} data-testid={`status-admin-withdrawal-${w.id}`}>{w.status}</span>
      </div>
      <div className="wn-summary-row"><span>Fee ({w.feePercent}%)</span><strong>{peso(w.feeAmount)}</strong></div>
      <div className="wn-summary-row"><span>Net to pay</span><strong data-testid={`data-net-${w.id}`}>{peso(w.netAmount)}</strong></div>
      <div className="wn-summary-row"><span>Member</span><strong>{w.userMobileNumber}</strong></div>
      <div className="wn-summary-row"><span>GCash name</span><strong>{w.accountName}</strong></div>
      <div className="wn-summary-row"><span>GCash number</span><strong>{w.accountNumber}</strong></div>
      <div className="wn-summary-row"><span>Submitted</span><strong>{when(w.createdAt)}</strong></div>
      {w.processingById && <div className="wn-summary-row"><span>Processor</span><strong>{mine ? 'You' : w.processingById}</strong></div>}
      {w.processedAt && <div className="wn-summary-row"><span>Processing started</span><strong>{when(w.processedAt)}</strong></div>}
      {w.completedAt && <div className="wn-summary-row"><span>Completed</span><strong>{when(w.completedAt)}</strong></div>}
      {w.payoutReference && <div className="wn-summary-row"><span>Payout reference</span><strong>{w.payoutReference}</strong></div>}
      {w.verificationNote && <div className="wn-summary-row"><span>Verification note</span><strong>{w.verificationNote}</strong></div>}
      {w.rejectionReason && <div className="wn-summary-row"><span>Rejection reason</span><strong>{w.rejectionReason}</strong></div>}
      {err && !mode && <div className="wn-feedback error" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {w.status === 'PENDING' && !mode && <>
          <button className="wn-button" disabled={self || busy} onClick={start} data-testid={`button-process-${w.id}`}>{proc.isPending && <LoaderCircle className="animate-spin" size={16} />}Start processing</button>
          <button className="wn-button wn-button-quiet" disabled={self || busy} onClick={() => { setErr(''); setMode('reject'); }} data-testid={`button-reject-${w.id}`}>Reject</button>
        </>}
        {w.status === 'PROCESSING' && !mode && <>
          <button className="wn-button" disabled={!mine || self || busy} onClick={() => { setErr(''); setRef(w.payoutReference ?? ''); setPaid(w.payoutReference ? w.netAmount : ''); setMode('complete'); }} data-testid={`button-complete-${w.id}`}>Complete</button>
          <button className="wn-button wn-button-quiet" disabled={!mine || self || busy || !!w.payoutReference} onClick={() => { setErr(''); setMode('reject'); }} data-testid={`button-reject-${w.id}`}>Reject</button>
          {!mine && <button className="wn-button wn-button-quiet" disabled={self || busy} onClick={() => { setErr(''); setMode('handoff'); }} data-testid={`button-handoff-${w.id}`}>Reconcile & take over</button>}
        </>}
        <button className="wn-button wn-button-light" onClick={() => setOpen(o => !o)} aria-expanded={open} data-testid={`button-audit-${w.id}`}>{open ? 'Hide audit log' : 'Audit log'}</button>
      </div>
      {self && (w.status === 'PENDING' || w.status === 'PROCESSING') && <p className="wn-helper" style={{ marginTop: 8 }}>You can’t review your own withdrawal. Another administrator must.</p>}
      {w.status === 'PENDING' && <p className="wn-helper" style={{ marginTop: 8 }}>Starting processing is review only. It does not mean money was sent.</p>}
      {w.status === 'PROCESSING' && !mine && <p className="wn-helper" style={{ marginTop: 8 }}>Only the assigned processor can complete or reject. If unavailable, reconcile payment and coordinate an audited handoff first.</p>}
      {w.status === 'PROCESSING' && w.payoutReference && <div className="wn-feedback" role="status">Payment already reconciled as sent. Do not send again or reject. Complete using reference {w.payoutReference}.</div>}
      {mode === 'handoff' && <WithdrawalHandoffForm withdrawal={w} onCancel={reset} onDone={() => done(`Withdrawal ${w.id} handed off to you. Funds remain reserved; no payment was sent by this app.`)} />}
      {mode === 'complete' && w.status === 'PROCESSING' && (
        <fieldset disabled={busy} className="wn-confirm" style={{ border: 0, minWidth: 0 }}>
          <p>{w.payoutReference ? 'Do not send again. Record the already-sent payment after independently verifying' : 'Complete only after actually sending and independently verifying'} <strong>{peso(w.netAmount)}</strong> to GCash {w.accountNumber} ({w.accountName}). This app does not send money.</p>
          {err && <div className="wn-feedback error" role="alert" data-testid="error-admin-withdrawal">{err}</div>}
          <div className="wn-field"><label htmlFor={`pr-${w.id}`}>Payout reference (6–64 characters)</label><input id={`pr-${w.id}`} className="wn-input" maxLength={64} value={ref} onChange={e => setRef(e.target.value)} data-testid="input-payout-reference" /></div>
          <div className="wn-field"><label htmlFor={`pa-${w.id}`}>Actual amount paid (PHP)</label><input id={`pa-${w.id}`} className="wn-input" inputMode="decimal" value={paid} onChange={e => setPaid(e.target.value)} data-testid="input-paid-amount" /></div>
          <div className="wn-field"><label htmlFor={`pn-${w.id}`}>Verification note (10–1000 characters)</label><textarea id={`pn-${w.id}`} className="wn-input" style={{ height: 90, padding: 12 }} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} data-testid="input-verification-note" /></div>
          <label style={lbl}><input type="checkbox" style={chk} checked={sent} onChange={e => setSent(e.target.checked)} data-testid="checkbox-payout-sent" />I independently verified this GCash payout was sent; I will not send it again</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="wn-button" onClick={sendComplete} data-testid="button-confirm-complete">{complete.isPending && <LoaderCircle className="animate-spin" size={16} />}Confirm completion</button>
            <button className="wn-button wn-button-quiet" type="button" onClick={reset}>Cancel</button>
          </div>
        </fieldset>
      )}
      {mode === 'reject' && (w.status === 'PENDING' || w.status === 'PROCESSING') && (
        <fieldset disabled={busy || self || (w.status === 'PROCESSING' && !mine)} className="wn-confirm" style={{ border: 0, minWidth: 0 }}>
          <p>Rejecting returns the full held amount to the member once. The member will see your reason.</p>
          {err && <div className="wn-feedback error" role="alert" data-testid="error-admin-withdrawal">{err}</div>}
          <div className="wn-field"><label htmlFor={`rr-${w.id}`}>Reason (5–1000 characters)</label><textarea id={`rr-${w.id}`} className="wn-input" style={{ height: 90, padding: 12 }} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} data-testid="input-rejection-reason" /></div>
          <label style={lbl}><input type="checkbox" style={chk} checked={noPayout} onChange={e => setNoPayout(e.target.checked)} data-testid="checkbox-no-payout" />I confirm no payout was sent</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="wn-button" onClick={sendReject} data-testid="button-confirm-reject">{reject.isPending && <LoaderCircle className="animate-spin" size={16} />}Confirm rejection</button>
            <button className="wn-button wn-button-quiet" type="button" onClick={reset}>Cancel</button>
          </div>
        </fieldset>
      )}
      {open && <Audit id={w.id} />}
    </article>
  );
}

export function AdminWithdrawalDashboard() {
  const me = useGetCurrentUser();
  const isAdmin = me.data?.role === 'ADMIN';
  const [status, setStatus] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState('');
  const q = useGetAdminWithdrawals({ status, page }, { query: { enabled: isAdmin, refetchInterval: 15000, queryKey: getGetAdminWithdrawalsQueryKey({ status, page }) } });
  const head = <div className="wn-page-head"><div className="wn-eyebrow">Administrator</div><h1 className="wn-display">Review withdrawals.</h1><p>Payouts are sent manually through GCash. Mark completed only after you verify the transfer yourself.</p></div>;
  if (me.data && !isAdmin) return <>{head}<div className="wn-empty" role="alert" data-testid="denied-admin-withdrawals"><div className="wn-empty-mark"><ShieldAlert size={21} /></div><h3>Administrators only</h3><p>Your account doesn’t have access to withdrawal review.</p><Link href="/withdrawal" className="wn-link" style={{ marginTop: 14 }}>Back to withdrawals</Link></div></>;
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return (
    <section data-testid="admin-withdrawal-dashboard">
      {head}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }} role="group" aria-label="Filter by status">
        {FILTERS.map(([v, l]) => <button key={v} className={`wn-button ${status === v ? '' : 'wn-button-quiet'}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }} data-testid={`filter-${v.toLowerCase()}`}>{l}</button>)}
      </div>
      {notice && <div className="wn-feedback" role="status" data-testid="status-admin-notice">{notice}</div>}
      {q.isError ? <div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load withdrawals.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>
        : !q.data ? <div className="wn-loading"><div className="wn-skeleton" /><div className="wn-skeleton" /></div>
        : q.data.items.length === 0 ? <div className="wn-empty" data-testid="empty-admin-withdrawals"><h3>Nothing here</h3><p>No withdrawals match this filter.</p></div>
        : <div className="wn-inv-list" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', alignItems: 'start' }}>{q.data.items.map(w => <Card key={w.id} w={w} selfId={me.data?.id ?? ''} onNotice={setNotice} />)}</div>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
        <button className="wn-button wn-button-quiet" disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="button-prev-page">Previous</button>
        <span className="wn-helper">Page {q.data?.page ?? page} of {pages}</span>
        <button className="wn-button wn-button-quiet" disabled={page >= pages} onClick={() => setPage(p => p + 1)} data-testid="button-next-page">Next</button>
      </div>
    </section>
  );
}
