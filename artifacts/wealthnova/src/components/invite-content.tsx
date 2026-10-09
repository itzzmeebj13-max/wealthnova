import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, Gift, UsersRound } from 'lucide-react';
import {
  getGetMyCommissionsQueryKey,
  getGetMyReferralsQueryKey,
  getGetReferralNotificationsQueryKey,
  useAcknowledgeReferralNotification,
  useGetMyCommissions,
  useGetMyReferrals,
  useGetReferralNotifications,
} from '@workspace/api-client-react';
import { errMsg, peso, when } from '@/components/withdrawal-content';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const FILTERS = [['ALL', 'All'], ['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['PAID', 'Paid']] as const;
type Filter = (typeof FILTERS)[number][0];

const STATUS_COPY: Record<string, string> = {
  PENDING: 'Recorded. No wallet funds yet.',
  APPROVED: 'Approved and reserved. Not yet in your wallet.',
  REJECTED: 'Not paid. Reserve released.',
  PAID: 'Transferred into your wallet.',
};

function Head() {
  return <div className="wn-page-head"><div className="wn-eyebrow">Your personal invitation</div><h1 className="wn-display">Good things travel by word of mouth.</h1><p>Your code and link let someone you trust join. Commission records appear below only after a referred member buys a plan.</p></div>;
}

function Notifications() {
  const client = useQueryClient();
  const q = useGetReferralNotifications({ query: { queryKey: getGetReferralNotificationsQueryKey(), refetchInterval: 15000 } });
  const ack = useAcknowledgeReferralNotification(REQ);
  const [err, setErr] = useState('');
  if (q.isError) return <section className="wn-card wn-full" data-testid="error-referral-notifications">
    <div className="wn-feedback error" role="alert">{errMsg(q.error, 'Could not load referral notifications.')}
      <button className="wn-link" onClick={() => void q.refetch()}>Retry</button>
    </div>
  </section>;
  if (!q.data || q.data.length === 0) return null;
  return <section className="wn-card wn-full" data-testid="panel-referral-notifications">
    <div className="wn-panel-head"><h2>Updates</h2></div>
    {err && <div className="wn-feedback error" role="alert">{err}</div>}
    {q.data.map(n => <div className="wn-summary-row" key={n.id} data-testid={`notification-${n.id}`}>
      <span style={{ textAlign: 'left' }}>{n.message}<br /><small>{when(n.createdAt)}</small></span>
      <button className="wn-button wn-button-quiet" disabled={ack.isPending} onClick={() => { setErr(''); ack.mutate({ notificationId: n.id }, { onSuccess: () => void client.invalidateQueries({ queryKey: getGetReferralNotificationsQueryKey() }), onError: e => setErr(errMsg(e, 'Could not mark as read.')) }); }} data-testid={`button-ack-${n.id}`}>Mark read</button>
    </div>)}
  </section>;
}

function History() {
  const [status, setStatus] = useState<Filter>('ALL');
  const [page, setPage] = useState(1);
  const params = { status, page };
  const q = useGetMyCommissions(params, { query: { queryKey: getGetMyCommissionsQueryKey(params), refetchInterval: 15000 } });
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / q.data.pageSize)) : 1;
  return <section className="wn-card wn-full" data-testid="panel-commission-history">
    <div className="wn-panel-head"><h2>Commission history</h2></div>
    <p className="wn-helper" style={{ marginBottom: 12 }}>Source references are internal investment ledger references, not GCash payout confirmations. Each row keeps the rate saved when it was created; later rate changes apply only to future plan purchases.</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }} role="group" aria-label="Filter by status">
      {FILTERS.map(([v, l]) => <button key={v} className={`wn-button ${status === v ? '' : 'wn-button-quiet'}`} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }} data-testid={`filter-commission-${v.toLowerCase()}`}>{l}</button>)}
    </div>
    {q.isError ? <div className="wn-feedback error" role="alert" data-testid="error-commissions">{errMsg(q.error, 'Could not load commissions.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>
      : !q.data ? <div className="wn-loading"><div className="wn-skeleton" /></div>
      : q.data.items.length === 0 ? <div className="wn-empty" data-testid="empty-commissions"><div className="wn-empty-mark"><Gift size={21} /></div><h3>No commissions here</h3><p>Nothing matches this filter yet.</p></div>
      : <div className="wn-inv-list" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', alignItems: 'start' }}>
        {q.data.items.map(c => <article className="wn-inv" key={c.id} data-testid={`card-commission-${c.id}`}>
          <div className="wn-panel-head" style={{ marginBottom: 8 }}><h3>{peso(c.amount)}</h3><span className="wn-status-pill">{c.status.toLowerCase()}</span></div>
          <div className="wn-summary-row"><span>Tier</span><strong>Level {c.tier}</strong></div>
          <div className="wn-summary-row"><span>Rate saved</span><strong>{c.ratePercent}%</strong></div>
          <div className="wn-summary-row"><span>On purchase of</span><strong>{peso(c.basisAmount)}</strong></div>
          <div className="wn-summary-row"><span>Source reference</span><strong style={{ wordBreak: 'break-all' }}>{c.sourceTransactionReference}</strong></div>
          <div className="wn-summary-row"><span>Created</span><strong>{when(c.createdAt)}</strong></div>
          {c.approvedAt && <div className="wn-summary-row"><span>Approved</span><strong>{when(c.approvedAt)}</strong></div>}
          {c.paidAt && <div className="wn-summary-row"><span>Paid to wallet</span><strong>{when(c.paidAt)}</strong></div>}
          {c.rejectionReason && <div className="wn-summary-row"><span>Reason</span><strong>{c.rejectionReason}</strong></div>}
          <p className="wn-helper" style={{ marginTop: 8 }}>{STATUS_COPY[c.status]}</p>
        </article>)}
      </div>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 16 }}>
      <button className="wn-button wn-button-quiet" disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="button-commission-prev"><ChevronLeft size={15} />Previous</button>
      <span className="wn-helper">Page {q.data?.page ?? page} of {pages}</span>
      <button className="wn-button wn-button-quiet" disabled={page >= pages} onClick={() => setPage(p => p + 1)} data-testid="button-commission-next">Next<ChevronRight size={15} /></button>
    </div>
  </section>;
}

export function InviteContent() {
  const referrals = useGetMyReferrals({ query: { queryKey: getGetMyReferralsQueryKey(), refetchInterval: 15000 } });
  const [copyState, setCopyState] = useState('');
  const [copyError, setCopyError] = useState('');
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setCopyError(''); setCopyState(`${label} copied`); }
    catch { setCopyError('Copy is unavailable in this browser. Select and copy the text instead.'); }
  };
  if (referrals.isError) return <><Head /><div className="wn-empty" role="alert" data-testid="error-invite"><h3>We couldn’t load this just now</h3><p>{errMsg(referrals.error, 'Your referral information is temporarily unavailable.')}</p><button className="wn-button wn-button-quiet" style={{ marginTop: 18 }} onClick={() => void referrals.refetch()} data-testid="button-retry">Try again</button></div></>;
  if (!referrals.data) return <><Head /><div className="wn-loading" data-testid="loading-invite"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  const r = referrals.data;
  const link = new URL(r.referralLink, window.location.origin).toString();
  const tiers = [[1, r.tier1Count], [2, r.tier2Count], [3, r.tier3Count]] as const;
  return <>
    <Head />
    <div className="wn-grid wn-fade wn-referral-content">
      <section className="wn-card wn-wide" data-testid="panel-personal-invite">
        <div className="wn-panel-head"><h2>Your invite details</h2><Gift size={20} color="#987c4c" /></div>
        <div className="wn-codebox">
          <div><span>PERSONAL REFERRAL CODE</span><strong data-testid="data-referral-code">{r.referralCode}</strong></div>
          <button className="wn-button wn-button-light" onClick={() => void copy(r.referralCode, 'Code')} data-testid="button-copy-code"><Copy size={15} />{copyState === 'Code copied' ? 'Copied' : 'Copy code'}</button>
        </div>
        <div style={{ marginTop: 23 }}>
          <div className="wn-card-label" style={{ marginBottom: 9 }}>Your referral link</div>
          <div className="wn-codebox">
            <a className="wn-inline-link" href={link} target="_blank" rel="noreferrer" data-testid="link-personal-referral">{link}</a>
            <button className="wn-button wn-button-light" onClick={() => void copy(link, 'Link')} data-testid="button-copy-link"><Copy size={15} />{copyState === 'Link copied' ? 'Copied' : 'Copy Referral Link'}</button>
          </div>
        </div>
        {copyState && <p role="status" className="wn-feedback" style={{ marginTop: 14, marginBottom: 0 }} data-testid="status-copy">{copyState}</p>}
        {copyError && <p role="status" className="wn-feedback error" style={{ marginTop: 14, marginBottom: 0 }} data-testid="error-copy">{copyError}</p>}
      </section>
      <section className="wn-card wn-narrow" data-testid="panel-referral-count">
        <div className="wn-card-label">Direct referrals</div>
        <div className="wn-stat" data-testid="data-referral-count">{r.referralCount}</div>
        <p className="wn-stat-caption">{r.totalInvitedUsers} people across all three levels.</p>
        <div className="wn-callout" style={{ marginTop: 22 }}><div className="wn-callout-icon"><UsersRound size={18} /></div><p style={{ margin: 0 }}>A factual count. It is not a promise of earnings.</p></div>
      </section>
      <section className="wn-card wn-half" data-testid="panel-referral-tiers">
        <div className="wn-panel-head"><h2>Your three levels</h2></div>
        {tiers.map(([t, n]) => {
          const rate = r.rates.find(x => x.tier === t);
          return <div className="wn-summary-row" key={t}><span>Level {t} · {n} {n === 1 ? 'person' : 'people'}</span><strong>{rate ? `${rate.percent}% current rate` : 'Rate unavailable'}</strong></div>;
        })}
        <p className="wn-helper" style={{ marginTop: 10 }}>Current rates apply to future plan purchases only. Commissions already recorded keep the rate saved on them.</p>
      </section>
      <section className="wn-card wn-half" data-testid="panel-commission-totals">
        <div className="wn-panel-head"><h2>Commission totals</h2></div>
        <div className="wn-summary-row"><span>Total commissions recorded</span><strong data-testid="total-commissions">{peso(r.commissionTotals.total)}</strong></div>
        <p className="wn-helper">Total includes all statuses, including rejected records. Only paid wallet credits are spendable.</p>
        <div className="wn-summary-row"><span>Pending (no wallet funds)</span><strong data-testid="total-pending">{peso(r.commissionTotals.pending)}</strong></div>
        <div className="wn-summary-row"><span>Approved (reserved)</span><strong data-testid="total-approved">{peso(r.commissionTotals.approved)}</strong></div>
        <div className="wn-summary-row"><span>Rejected</span><strong data-testid="total-rejected">{peso(r.commissionTotals.rejected)}</strong></div>
        <div className="wn-summary-row"><span>Paid into wallet</span><strong data-testid="total-paid">{peso(r.commissionTotals.paid)}</strong></div>
      </section>
      <Notifications />
      <History />
    </div>
  </>;
}
