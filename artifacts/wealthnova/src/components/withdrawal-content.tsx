import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { LoaderCircle } from 'lucide-react';
import {
  getGetDashboardSummaryQueryKey,
  getGetMyWithdrawalsQueryKey,
  getGetWithdrawalQuoteQueryKey,
  getGetWithdrawalSummaryQueryKey,
  useAcknowledgeWithdrawalNotification,
  useGetMyWithdrawals,
  useGetWithdrawalQuote,
  useGetWithdrawalSummary,
  useSubmitWithdrawal,
} from '@workspace/api-client-react';
import type { WithdrawalInput } from '@workspace/api-client-react';
import {
  isValidPhilippineMobileNumber,
  normalizePhilippineMobileNumber,
  PHILIPPINE_MOBILE_VALIDATION_MESSAGE,
} from '@workspace/api-zod';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const STATUS: Record<string, string> = { PENDING: 'Pending review', PROCESSING: 'Processing', COMPLETED: 'Completed', REJECTED: 'Rejected' };

export function peso(v: string) {
  return `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function when(v: string | null) {
  return v ? new Date(v).toLocaleString() : '—';
}
export function errMsg(e: unknown, fb: string) {
  const err = e as { message?: string; data?: { error?: string } } | null;
  return err?.data?.error || err?.message || fb;
}

export function WithdrawalContent() {
  const client = useQueryClient();
  const summary = useGetWithdrawalSummary({ query: { queryKey: getGetWithdrawalSummaryQueryKey(), refetchInterval: 15000 } });
  const history = useGetMyWithdrawals({ query: { queryKey: getGetMyWithdrawalsQueryKey(), refetchInterval: 15000 } });
  const submit = useSubmitWithdrawal(REQ);
  const ack = useAcknowledgeWithdrawalNotification(REQ);
  const [amount, setAmount] = useState('');
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const frozen = useRef<WithdrawalInput | null>(null);
  const [retrying, setRetrying] = useState(false);

  const amountOk = AMOUNT_RE.test(amount) && Number(amount) > 0;
  useEffect(() => {
    const t = setTimeout(() => setDebounced(amountOk ? amount : ''), 400);
    return () => clearTimeout(t);
  }, [amount, amountOk]);
  const quote = useGetWithdrawalQuote({ amount: debounced }, { query: { enabled: !!debounced, refetchInterval: 15000, queryKey: getGetWithdrawalQuoteQueryKey({ amount: debounced }) } });

  const edit = (fn: () => void) => { frozen.current = null; setRetrying(false); setError(''); fn(); };
  const refresh = () => {
    void client.invalidateQueries({ queryKey: getGetWithdrawalSummaryQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMyWithdrawalsQueryKey() });
    void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    void client.invalidateQueries({ queryKey: ['/api/portfolio'] });
    void client.invalidateQueries({ queryKey: ['/api/investments'] });
  };

  const s = summary.data;
  const active = !!s?.activeWithdrawalId;
  const quoteReady = !!quote.data && quote.data.requestedAmount === Number(debounced).toFixed(2) || (!!quote.data && Number(quote.data.requestedAmount) === Number(debounced));
  const quoteCurrent = debounced === amount && quoteReady && !quote.isFetching;

  const send = () => {
    if (submit.isPending) return;
    setError(''); setNotice('');
    if (!frozen.current) {
      if (!amountOk) return setError('Enter an amount with up to 2 decimals.');
      if (!name.trim() || name.trim().length > 120) return setError('Enter the GCash account name (up to 120 characters).');
      if (!isValidPhilippineMobileNumber(number)) return setError(PHILIPPINE_MOBILE_VALIDATION_MESSAGE);
      if (!quoteCurrent) return setError('Wait for the server quote before submitting.');
      frozen.current = { amount, accountName: name.trim(), accountNumber: normalizePhilippineMobileNumber(number) ?? number, idempotencyKey: crypto.randomUUID() };
    }
    submit.mutate({ data: frozen.current }, {
      onSuccess: r => {
        const w = (r as { withdrawal?: { status?: string } }).withdrawal ?? (r as { status?: string });
        const st = w.status ? STATUS[w.status] ?? w.status : 'recorded';
        frozen.current = null; setRetrying(false);
        setAmount(''); setName(''); setNumber(''); setDebounced('');
        setNotice(`Request received. Current status: ${st}. Manual GCash payout is handled by an administrator; nothing is sent automatically.`);
        refresh();
      },
      onError: e => { setRetrying(true); setError(`${errMsg(e, 'Network problem.')} Your request was not confirmed. You can retry safely; the same request will be sent so it cannot be duplicated.`); },
    });
  };

  if (summary.isError) return <div className="wn-empty" role="alert" data-testid="error-withdrawal"><h3>We couldn’t load withdrawals</h3><p>{errMsg(summary.error, 'Please try again.')}</p><button className="wn-button wn-button-quiet" style={{ marginTop: 16 }} onClick={() => void summary.refetch()} data-testid="button-retry-withdrawal">Try again</button></div>;
  if (!s) return <div className="wn-loading" data-testid="loading-withdrawal"><div className="wn-skeleton" /><div className="wn-skeleton" /></div>;

  return (
    <div className="wn-grid wn-fade" data-testid="withdrawal-page">
      {s.notifications.length > 0 && <section className="wn-card wn-full wn-wd-notes" data-testid="panel-withdrawal-notifications">
        <div className="wn-panel-head"><h2>Notifications</h2></div>
        {s.notifications.map(n => <div className="wn-confirm wn-wd-note" key={n.id} data-testid={`notification-${n.id}`}>
          <p style={{ marginBottom: 6 }}>{n.message}</p><div className="wn-helper">{when(n.createdAt)}</div>
          <button className="wn-button wn-button-light" style={{ marginTop: 10 }} disabled={ack.isPending} data-testid={`button-ack-${n.id}`}
            onClick={() => ack.mutate({ notificationId: n.id }, { onSuccess: refresh })}>{ack.isPending && <LoaderCircle className="animate-spin" size={15} />}Mark as read</button>
        </div>)}
        {ack.isError && <div className="wn-feedback error" role="alert">{errMsg(ack.error, 'Could not mark as read.')}</div>}
      </section>}
      <section className="wn-card wn-hero-card wn-wd-balance" data-testid="card-withdrawal-balance">
        <div className="wn-hero-kicker">Available to withdraw</div>
        <h2 data-testid="data-withdrawal-available">{peso(s.availableBalance)}</h2>
        <p>Held in pending withdrawals: <strong data-testid="data-withdrawal-reserved">{peso(s.reservedBalance)}</strong></p>
      </section>
      <section className="wn-card wn-stat-card" data-testid="card-withdrawal-fee">
        <div><div className="wn-card-label">Withdrawal fee</div><div className="wn-stat">{s.feePercent}%</div></div>
        <p className="wn-stat-caption">Rounded to the nearest cent. The full amount you request is held when you submit; the net amount after fee is what is paid to GCash.</p>
      </section>
      <section className="wn-card wn-full" data-testid="panel-withdrawal-form">
        <div className="wn-panel-head"><h2>Request a GCash withdrawal</h2></div>
        {active ? <div className="wn-auth-warning" data-testid="text-withdrawal-active">You already have an outstanding withdrawal. Only one can be open at a time; a new request is available once it is completed or rejected.</div> : <>
          <p className="wn-helper" style={{ marginBottom: 14, fontSize: 12 }}>Payouts are sent manually by an administrator to the GCash account below. Check the name and number carefully.</p>
          {notice && <div className="wn-feedback" role="status" data-testid="status-withdrawal-notice">{notice}</div>}
          {error && <div className="wn-feedback error" role="alert" data-testid="error-withdrawal-submit">{error}</div>}
          <fieldset disabled={submit.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <div className="wn-field"><label htmlFor="wd-amount">Amount to withdraw (PHP)</label>
              <input id="wd-amount" className="wn-input" inputMode="decimal" autoComplete="off" value={amount} onChange={e => edit(() => setAmount(e.target.value))} data-testid="input-withdrawal-amount" /></div>
            {amount && !amountOk && <div className="wn-field-error" style={{ marginBottom: 12 }}>Use digits with up to 2 decimals.</div>}
            {debounced && <div className="wn-confirm wn-wd-quote" style={{ marginTop: 0, marginBottom: 17 }} data-testid="panel-withdrawal-quote">
              {quote.isError ? <div role="alert" className="wn-field-error">{errMsg(quote.error, 'Quote unavailable.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void quote.refetch()}>Retry</button></div>
                : !quote.data ? <div className="wn-skeleton" style={{ height: 60 }} />
                : <>
                  <div className="wn-summary-row" style={{ borderTop: 0 }}><span>Amount held</span><strong data-testid="data-quote-gross">{peso(quote.data.requestedAmount)}</strong></div>
                  <div className="wn-summary-row"><span>Fee ({quote.data.feePercent}%)</span><strong data-testid="data-quote-fee">{peso(quote.data.feeAmount)}</strong></div>
                  <div className="wn-summary-row"><span>Net payout to GCash</span><strong data-testid="data-quote-net">{peso(quote.data.netAmount)}</strong></div>
                </>}
            </div>}
            <div className="wn-field"><label htmlFor="wd-name">GCash account name</label>
              <input id="wd-name" className="wn-input" maxLength={120} autoComplete="off" value={name} onChange={e => edit(() => setName(e.target.value))} data-testid="input-withdrawal-name" /></div>
            <div className="wn-field"><label htmlFor="wd-number">GCash mobile number</label>
              <input id="wd-number" className="wn-input" inputMode="tel" maxLength={16} autoComplete="off" value={number} onChange={e => edit(() => setNumber(e.target.value))} data-testid="input-withdrawal-number" />
              {number && !isValidPhilippineMobileNumber(number) && <div className="wn-field-error">{PHILIPPINE_MOBILE_VALIDATION_MESSAGE}</div>}</div>
            <button type="button" className="wn-button" onClick={send} disabled={submit.isPending} data-testid="button-submit-withdrawal">
              {submit.isPending && <LoaderCircle className="animate-spin" size={16} />}{submit.isPending ? 'Submitting' : retrying ? 'Retry same request' : 'Submit withdrawal'}</button>
          </fieldset>
        </>}
        {active && notice && <div className="wn-feedback" role="status" style={{ marginTop: 14 }} data-testid="status-withdrawal-notice">{notice}</div>}
      </section>
      <section className="wn-card wn-full" data-testid="panel-withdrawal-history">
        <div className="wn-panel-head"><h2>Your withdrawals</h2></div>
        {history.isError ? <div className="wn-feedback error" role="alert">{errMsg(history.error, 'Could not load history.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void history.refetch()}>Retry</button></div>
          : !history.data ? <div className="wn-skeleton" />
          : history.data.length === 0 ? <div className="wn-empty" data-testid="empty-withdrawals"><h3>No withdrawals yet</h3><p>Requests you submit will appear here with their status.</p></div>
          : <div className="wn-inv-list">{history.data.map(w => <article className="wn-inv" key={w.id} data-testid={`card-withdrawal-${w.id}`}>
            <div className="wn-panel-head" style={{ marginBottom: 8 }}><h3>{peso(w.requestedAmount)}</h3><span className={`wn-status-pill wn-wd-${w.status.toLowerCase()}`}>{STATUS[w.status]}</span></div>
            <div className="wn-summary-row"><span>Fee ({w.feePercent}%)</span><strong>{peso(w.feeAmount)}</strong></div>
            <div className="wn-summary-row"><span>Net payout</span><strong>{peso(w.netAmount)}</strong></div>
            <div className="wn-summary-row"><span>GCash</span><strong>{w.accountName} · {w.accountNumber}</strong></div>
            <div className="wn-summary-row"><span>Submitted</span><strong>{when(w.createdAt)}</strong></div>
            {w.completedAt && <div className="wn-summary-row"><span>Completed</span><strong>{when(w.completedAt)}</strong></div>}
            {w.payoutReference && <div className="wn-summary-row"><span>Payout reference</span><strong>{w.payoutReference}</strong></div>}
            {w.rejectionReason && <div className="wn-summary-row"><span>Rejection reason</span><strong>{w.rejectionReason}</strong></div>}
            {w.status === 'REJECTED' && <p className="wn-helper" style={{ marginTop: 8 }}>The full held amount was returned to your balance.</p>}
          </article>)}</div>}
      </section>
    </div>
  );
}

export function WithdrawalAccountLink() {
  const q = useGetWithdrawalSummary({ query: { queryKey: getGetWithdrawalSummaryQueryKey(), refetchInterval: 15000 } });
  const n = q.data?.notifications.length ?? 0;
  return (
    <section className="wn-card wn-full" data-testid="panel-account-withdrawals">
      <div className="wn-panel-head"><h2>Withdrawals</h2></div>
      {n > 0 && <div className="wn-auth-warning" style={{ marginBottom: 14 }} role="status" data-testid="notice-account-withdrawal">You have {n} unread withdrawal {n === 1 ? 'notification' : 'notifications'}.</div>}
      <Link href="/withdrawal" className="wn-link" data-testid="link-withdrawal">Withdraw to GCash</Link>
    </section>
  );
}
