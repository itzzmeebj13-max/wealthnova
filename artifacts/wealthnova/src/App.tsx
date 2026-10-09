import { type ReactNode, useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  ChevronRight,
  CircleHelp,
  Copy,
  CreditCard,
  Gift,
  HandCoins,
  Home as HomeIcon,
  KeyRound,
  Leaf,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  UserRound,
  Wallet,
  UsersRound,
} from 'lucide-react';
import {
  getGetCurrentUserQueryKey,
  useGetCurrentUser,
  useGetDashboardSummary,
  useGetMyReferrals,
  useGetPlans,
  useStartInvestment,
  getGetDashboardSummaryQueryKey,
  getGetPlansQueryKey,
  useLogin,
  useLogout,
  useRegister,
  useValidateReferralCode,
} from '@workspace/api-client-react';
import type { SessionUser } from '@workspace/api-client-react';
import {
  isValidPhilippineMobileNumber,
  normalizePhilippineMobileNumber,
  PHILIPPINE_MOBILE_VALIDATION_MESSAGE,
} from '@workspace/api-zod';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import logoPath from '@assets/file_00000000ec5c820bb3111b380eeb2b8a_1791465952512.png';
import { AdminDepositDashboard } from '@/components/admin-deposit-dashboard';
import { AdminWithdrawalDashboard } from '@/components/admin-withdrawal-dashboard';
import { WithdrawalAccountLink, WithdrawalContent } from '@/components/withdrawal-content';
import { DepositContent } from '@/components/deposit-content';
import { ErrorBoundary } from '@/components/error-boundary';
import { Form, FormField } from '@/components/ui/form';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: true } },
});

const navItems = [
  { href: '/', label: 'Home', icon: HomeIcon },
  { href: '/plans', label: 'Plans', icon: HandCoins },
  { href: '/deposit', label: 'Deposit', icon: CreditCard },
  { href: '/invite', label: 'Invite', icon: UsersRound },
  { href: '/account', label: 'Account', icon: UserRound },
];

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: string }).message;
    if (message) return message;
  }
  return fallback;
}

function Brand() {
  return (
    <div className="wn-brand" data-testid="brand-wealthnova">
      <img src={logoPath} alt="" className="wn-brand-logo" />
      <span>wealthnova</span>
    </div>
  );
}

function DesktopNav({ active }: { active: string }) {
  return (
    <nav className="wn-nav" aria-label="Main navigation">
      {navItems.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={active === href ? 'page' : undefined} data-testid={`link-nav-${label.toLowerCase()}`}>
          <Icon size={18} strokeWidth={1.8} /><span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function MobileNav({ active }: { active: string }) {
  return (
    <nav className="wn-mobile-nav" aria-label="Mobile navigation">
      {navItems.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} aria-current={active === href ? 'page' : undefined} data-testid={`link-mobile-${label.toLowerCase()}`}>
          <Icon strokeWidth={1.9} /><span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}

function Protected({ children, active, title }: { children: ReactNode; active: string; title: string }) {
  const [, setLocation] = useLocation();
  const currentUser = useGetCurrentUser();
  useEffect(() => {
    if (currentUser.isError) setLocation('/login');
  }, [currentUser.isError, setLocation]);

  if (currentUser.isLoading || (!currentUser.data && !currentUser.isError)) {
    return (
      <div className="wn-app wn-loading" style={{ padding: 28 }} data-testid="loading-session">
        <div className="wn-skeleton" /><div className="wn-skeleton" /><div className="wn-skeleton" />
      </div>
    );
  }
  if (currentUser.isError || !currentUser.data) return <div className="wn-app" />;
  const user = currentUser.data;
  const initials = user.mobileNumber.slice(-2);
  return (
    <div className="wn-app">
      <div className="wn-shell wn-fade">
        <aside className="wn-sidebar">
          <Brand />
          <DesktopNav active={active} />
          <div className="wn-sidebar-note" data-testid="text-sidebar-note">
            <ShieldCheck size={16} style={{ marginBottom: 7 }} />
            <div>Your account details, kept clear and close.</div>
          </div>
        </aside>
        <main className="wn-main">
          <header className="wn-topbar">
            <div className="wn-crumb" data-testid="text-page-section">Member portal&nbsp; / &nbsp;{title}</div>
            <div className="wn-user-chip" data-testid="text-user-mobile">
              <span className="wn-avatar">{initials}</span>
              <span>{user.mobileNumber}</span>
            </div>
          </header>
          {children}
        </main>
      </div>
      <MobileNav active={active} />
    </div>
  );
}

function PageHead({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <div className="wn-page-head">
      <div className="wn-eyebrow">{eyebrow}</div>
      <h1 className="wn-display">{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function QueryError({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) {
  return (
    <div className="wn-empty" role="alert" data-testid={testId}>
      <div className="wn-empty-mark"><CircleHelp size={21} /></div>
      <h3>We couldn’t load this just now</h3>
      <p>{message}</p>
      <button className="wn-button wn-button-quiet" onClick={onRetry} style={{ marginTop: 18 }} data-testid="button-retry">
        Try again <ArrowRight size={15} />
      </button>
    </div>
  );
}

function DashboardPage() {
  return <Protected active="/" title="Home"><DashboardContent /></Protected>;
}

const FUNDING_NOTE = 'Verified deposits are the only funding source. Submitted manual deposit requests do not credit funds; only verified deposits fund your wallet.';
const ACCOUNTING_NOTE = 'Daily plan figures are informational only. They are not guaranteed and are not credited automatically. Only verified earning credits count as earnings.';

function php(value: string) {
  return `₱${Number(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DashboardContent() {
  const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey(), refetchInterval: 15000 } });
  const referrals = useGetMyReferrals();
  const [, setLocation] = useLocation();
  const { data: user } = useGetCurrentUser();
  const head = <PageHead eyebrow="Your overview" title="A clearer view of your account." description="Balances shown here come only from verified ledger entries. Your membership and referral details are always here when you need them." />;
  if (summary.isError) return <>{head}<QueryError message={errorMessage(summary.error, 'Please try loading your account summary again.')} onRetry={() => void summary.refetch()} testId="error-dashboard" /></>;
  if (summary.isLoading || !summary.data) return <>{head}<div className="wn-loading" data-testid="loading-dashboard"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  const s = summary.data;
  const zeroFunds = Number(s.availableBalance) <= 0;
  return (
    <>
      {head}
      <div className="wn-grid wn-fade">
        <section className="wn-card wn-hero-card" data-testid="card-welcome">
          <img src={logoPath} alt="WealthNova" className="wn-logo-hero" data-testid="img-logo-home" />
          <div className="wn-hero-kicker">Available balance</div>
          <h2 data-testid="data-available-balance">{php(s.availableBalance)}</h2>
          <p data-testid="text-funding-limitation">{FUNDING_NOTE}</p>
          <div className="wn-hero-foot">Member since {new Date(s.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
        </section>
        <section className="wn-card wn-stat-card" data-testid="card-referral-count">
          <div><div className="wn-card-label">People you’ve invited</div>
            <div className="wn-stat" data-testid="data-referral-count">{s.referralCount}</div>
          </div>
          <Link href="/invite" className="wn-link" data-testid="link-dashboard-invite">Your invite details <ChevronRight size={15} /></Link>
        </section>
        <section className="wn-card wn-half" data-testid="card-total-invested">
          <div className="wn-card-label">Total invested</div>
          <div className="wn-stat" data-testid="data-total-invested">{php(s.totalInvested)}</div>
          <p className="wn-stat-caption">Sum of non-cancelled plan principals.</p>
        </section>
        <section className="wn-card wn-half" data-testid="card-total-earnings">
          <div className="wn-card-label">Verified earnings</div>
          <div className="wn-stat" data-testid="data-total-earnings">{php(s.totalEarnings)}</div>
          <p className="wn-stat-caption">Verified earning credits only.</p>
        </section>
        <section className="wn-card wn-full" data-testid="card-active-investments">
           <div className="wn-panel-head"><h2>Active investments <span data-testid="data-active-investment-count">({s.activeInvestments.length})</span></h2><Link href="/plans" className="wn-link" data-testid="link-view-plans">View plans <ChevronRight size={15} /></Link></div>
          {s.activeInvestments.length === 0 ?
            <div className="wn-empty" data-testid="empty-investments"><div className="wn-empty-mark"><Wallet size={21} /></div><h3>No active investments</h3><p>{zeroFunds ? 'Your verified available balance is zero. Pending deposit requests do not fund investments.' : 'Review plan terms to start one.'}</p></div> :
            <div className="wn-inv-list">
              {s.activeInvestments.map(inv => {
                const pct = inv.duration > 0 ? Math.min(100, Math.round((inv.daysCompleted / inv.duration) * 100)) : 0;
                return <article className="wn-inv" key={inv.id} data-testid={`card-investment-${inv.id}`}>
                  <div className="wn-panel-head" style={{ marginBottom: 12 }}><h3 data-testid={`data-investment-name-${inv.id}`}>{inv.planName}</h3><span className="wn-status-pill" data-testid={`status-investment-${inv.id}`}>{inv.status.toLowerCase()}</span></div>
                  <div className="wn-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
                  <div className="wn-summary-row"><span>Principal</span><strong data-testid={`data-investment-principal-${inv.id}`}>{php(inv.principalAmount)}</strong></div>
                  <div className="wn-summary-row"><span>Plan figure per day (informational)</span><strong data-testid={`data-investment-daily-${inv.id}`}>{php(inv.dailyAmount)}</strong></div>
                  <div className="wn-summary-row"><span>Days completed</span><strong data-testid={`data-investment-days-${inv.id}`}>{inv.daysCompleted} of {inv.duration}</strong></div>
                  <div className="wn-summary-row"><span>Days remaining</span><strong data-testid={`data-investment-remaining-${inv.id}`}>{inv.daysRemaining}</strong></div>
                  <div className="wn-summary-row"><span>Starts</span><strong data-testid={`data-investment-start-${inv.id}`}>{new Date(inv.startDate).toLocaleDateString()}</strong></div>
                  <div className="wn-summary-row"><span>Ends</span><strong data-testid={`data-investment-end-${inv.id}`}>{new Date(inv.endDate).toLocaleDateString()}</strong></div>
                  <div className="wn-summary-row"><span>Verified earnings credited</span><strong data-testid={`data-investment-accumulated-${inv.id}`}>{php(inv.accumulatedAmount)}</strong></div>
                </article>;
              })}
            </div>}
          <p className="wn-helper" style={{ marginTop: 14 }} data-testid="text-accounting-note">{ACCOUNTING_NOTE}</p>
        </section>
        <section className="wn-card wn-wide" data-testid="card-account-summary">
          <div className="wn-panel-head"><h2>Account at a glance</h2><BadgeCheck size={20} color="#547762" /></div>
          <div className="wn-summary-list">
            <div className="wn-summary-row"><span>Membership status</span><strong data-testid="status-account">{s.status.replaceAll('_', ' ')}</strong></div>
            <div className="wn-summary-row"><span>Account type</span><strong data-testid="data-role">{s.role === 'ADMIN' ? 'Administrator' : 'Member'}</strong></div>
            <div className="wn-summary-row"><span>Mobile number</span><strong data-testid="data-mobile">{user?.mobileNumber ?? '—'}</strong></div>
            <div className="wn-summary-row"><span>Member since</span><strong data-testid="data-member-since">{new Date(s.createdAt).toLocaleDateString()}</strong></div>
          </div>
        </section>
        <section className="wn-card wn-narrow" data-testid="card-referral-preview">
          <div className="wn-panel-head"><h2>Your circle</h2><Gift size={20} color="#987c4c" /></div>
          {referrals.isLoading ? <div className="wn-skeleton" /> : referrals.isError ?
            <div className="wn-auth-warning" data-testid="error-referral-preview">{errorMessage(referrals.error, 'Referral details are temporarily unavailable.')}</div> : referrals.data ?
              <div className="wn-callout">
                <div className="wn-callout-icon"><UsersRound size={18} /></div>
                <div><strong data-testid="data-referral-summary">{referrals.data.referralCount} invited</strong><p>Share your personal invite when someone is ready to join.</p></div>
              </div> : <div className="wn-auth-warning" data-testid="error-referral-preview">Referral details are temporarily unavailable.</div>}
          <button className="wn-button wn-button-quiet" onClick={() => setLocation('/invite')} style={{ marginTop: 18 }} data-testid="button-open-invites">View invite details <ArrowRight size={15} /></button>
        </section>
      </div>
    </>
  );
}

function PlansPage() {
  return <Protected active="/plans" title="Plans"><PlansContent /></Protected>;
}

function newKey() {
  return `wn-${crypto.randomUUID()}`;
}

function PlansContent() {
  const plans = useGetPlans();
  const summary = useGetDashboardSummary();
  const start = useStartInvestment();
  const client = useQueryClient();
  const keys = useRef<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const head = <PageHead eyebrow="Available to members" title="Plans, without the guesswork." description="Review fixed 25-day plan terms. The server sets every amount; nothing here is guaranteed." />;
  if (plans.isError) return <>{head}<QueryError message={errorMessage(plans.error, 'Plan information is temporarily unavailable.')} onRetry={() => void plans.refetch()} testId="error-plans" /></>;
  if (plans.isLoading || !plans.data) return <>{head}<div className="wn-loading" data-testid="loading-plans"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  const balance = summary.data?.availableBalance;
  const submit = (planId: string) => {
    if (start.isPending) return;
    setNotice(null);
    setActivePlan(planId);
    keys.current[planId] ??= newKey();
    start.mutate({ data: { planId, idempotencyKey: keys.current[planId] } }, {
      onSuccess: result => {
        delete keys.current[planId];
        setConfirming(null);
        setNotice({ kind: 'ok', text: result.replayed ? 'This investment was already started; no second charge was made.' : `${result.investment.planName} started. Available balance is now ${php(result.availableBalance)}.` });
        void client.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        void client.invalidateQueries({ queryKey: getGetPlansQueryKey() });
      },
      onError: error => {
        const status = (error as { status?: number } | null)?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) delete keys.current[planId];
        setNotice({ kind: 'error', text: errorMessage(error, 'We couldn’t start this plan. You can try again safely.') });
      },
    });
  };
  return <>
    {head}
    <div className="wn-auth-warning" style={{ marginBottom: 18 }} data-testid="text-funding-limitation"><strong>Only verified funds can be invested.</strong> {FUNDING_NOTE}</div>
    <div className="wn-summary-row" style={{ borderTop: 0, marginBottom: 6 }}><span>Your available balance</span><strong data-testid="data-plans-balance">{balance ? php(balance) : '—'}</strong></div>
    {notice && <div className={`wn-feedback${notice.kind === 'error' ? ' error' : ''}`} role={notice.kind === 'error' ? 'alert' : 'status'} data-testid={notice.kind === 'error' ? 'error-start-investment' : 'status-start-investment'}>{notice.text}</div>}
    {plans.data.length === 0 ? <div className="wn-card" data-testid="empty-plans"><div className="wn-empty"><div className="wn-empty-mark"><HandCoins size={21} /></div><h3>No plans are configured yet</h3><p>There aren’t any plans available to display right now.</p></div></div> :
      <div className="wn-grid wn-fade" data-testid="list-plans">
        {plans.data.map(plan => {
          const available = plan.status === 'AVAILABLE';
          const funded = balance !== undefined && Number(balance) >= Number(plan.principalAmount);
          const pending = start.isPending && activePlan === plan.id;
          return <article className="wn-card wn-plan-card" key={plan.id} data-testid={`card-plan-${plan.id}`}>
            <div className="wn-panel-head"><h2 data-testid={`data-plan-name-${plan.id}`}>{plan.name}</h2><span className="wn-status-pill" data-testid={`status-plan-${plan.id}`}>{plan.status.toLowerCase()}</span></div>
             <div className="wn-summary-row"><span>Investment amount</span><strong data-testid={`data-plan-principal-${plan.id}`}>{php(plan.principalAmount)}</strong></div>
             <div className="wn-summary-row"><span>Daily plan figure (informational)</span><strong data-testid={`data-plan-daily-${plan.id}`}>{php(plan.dailyAmount)}</strong></div>
            <div className="wn-summary-row"><span>Duration</span><strong data-testid={`data-plan-duration-${plan.id}`}>{plan.duration} days</strong></div>
            {confirming === plan.id ? <div className="wn-confirm" data-testid={`panel-confirm-${plan.id}`}>
              <p>Start {plan.name}? The server will move the principal from your verified available balance. Daily figures are not guaranteed or credited automatically.</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="wn-button" onClick={() => submit(plan.id)} disabled={pending} data-testid={`button-confirm-investment-${plan.id}`}>{pending && <LoaderCircle className="animate-spin" size={16} />}{pending ? 'Starting' : 'Confirm'}</button>
                <button className="wn-button wn-button-quiet" onClick={() => setConfirming(null)} disabled={pending} data-testid={`button-cancel-investment-${plan.id}`}>Cancel</button>
              </div>
            </div> : <>
              <button className="wn-button" style={{ marginTop: 16 }} onClick={() => { setNotice(null); setConfirming(plan.id); }} disabled={!available || !funded || start.isPending} data-testid={`button-start-investment-${plan.id}`}>Start Investment</button>
              {(!available || !funded) && <p className="wn-helper" style={{ marginTop: 10 }} data-testid={`text-start-disabled-${plan.id}`}>{!available ? 'This plan is currently unavailable.' : 'Your verified available balance does not cover this principal. Pending deposit requests do not credit your balance.'}</p>}
            </>}
          </article>;
        })}
      </div>}
    <p className="wn-helper" style={{ marginTop: 18 }} data-testid="text-accounting-note">{ACCOUNTING_NOTE}</p>
  </>;
}

function DepositPage() {
  return <Protected active="/deposit" title="Deposit"><DepositContent /></Protected>;
}

function AdminDepositsPage() {
  return <Protected active="/deposit" title="Review deposits"><AdminDepositDashboard /></Protected>;
}

function WithdrawalPage() {
  return <Protected active="/account" title="Withdraw"><PageHead eyebrow="Manual GCash payout" title="Withdraw to GCash." description="Requests are reviewed and paid manually by an administrator. A 5% fee applies, rounded to the nearest cent." /><WithdrawalContent /></Protected>;
}

function AdminWithdrawalsPage() {
  return <Protected active="/account" title="Review withdrawals"><AdminWithdrawalDashboard /></Protected>;
}

function InvitePage() {
  return <Protected active="/invite" title="Invite"><InviteContent /></Protected>;
}

function InviteContent() {
  const referrals = useGetMyReferrals();
  const [copyState, setCopyState] = useState('');
  const [copyError, setCopyError] = useState('');
  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState(`${label} copied`);
    } catch {
      setCopyError('Copy is unavailable in this browser. Select and copy the text instead.');
    }
  };
  if (referrals.isLoading) return <><PageHead eyebrow="Your personal invitation" title="Good things travel by word of mouth." description="Your personal code and link make it easy for someone you trust to join. The count below reflects your actual referrals." /><div className="wn-loading" data-testid="loading-invite"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  if (referrals.isError) return <><PageHead eyebrow="Your personal invitation" title="Good things travel by word of mouth." description="Your personal code and link make it easy for someone you trust to join. The count below reflects your actual referrals." /><QueryError message={errorMessage(referrals.error, 'Your referral information is temporarily unavailable.')} onRetry={() => void referrals.refetch()} testId="error-invite" /></>;
  if (!referrals.data) return <><PageHead eyebrow="Your personal invitation" title="Good things travel by word of mouth." description="Your personal code and link make it easy for someone you trust to join. The count below reflects your actual referrals." /><div className="wn-loading" data-testid="loading-invite"><div className="wn-skeleton" /></div></>;
  const referralLink = new URL(referrals.data.referralLink, window.location.origin).toString();
  return <>
    <PageHead eyebrow="Your personal invitation" title="Good things travel by word of mouth." description="Your personal code and link make it easy for someone you trust to join. The count below reflects your actual referrals." />
        <div className="wn-grid wn-fade">
          <section className="wn-card wn-wide" data-testid="panel-personal-invite">
            <div className="wn-panel-head"><h2>Your invite details</h2><Gift size={20} color="#987c4c" /></div>
            <div className="wn-codebox">
              <div><span>PERSONAL REFERRAL CODE</span><strong data-testid="data-referral-code">{referrals.data.referralCode}</strong></div>
              <button className="wn-button wn-button-light" onClick={() => void copy(referrals.data.referralCode, 'Code')} data-testid="button-copy-code"><Copy size={15} />{copyState === 'Code copied' ? 'Copied' : 'Copy code'}</button>
            </div>
            <div style={{ marginTop: 23 }}>
              <div className="wn-card-label" style={{ marginBottom: 9 }}>Your referral link</div>
              <div className="wn-codebox">
                <a className="wn-inline-link" href={referralLink} target="_blank" rel="noreferrer" data-testid="link-personal-referral">{referralLink}</a>
                <button className="wn-button wn-button-light" onClick={() => void copy(referralLink, 'Link')} data-testid="button-copy-link"><Copy size={15} />{copyState === 'Link copied' ? 'Copied' : 'Copy link'}</button>
              </div>
            </div>
            {copyState && <p role="status" className="wn-feedback" style={{ marginTop: 14, marginBottom: 0 }} data-testid="status-copy">{copyState}</p>}
            {copyError && <p role="status" className="wn-feedback error" style={{ marginTop: 14, marginBottom: 0 }} data-testid="error-copy">{copyError}</p>}
          </section>
          <section className="wn-card wn-narrow" data-testid="panel-referral-count">
            <div className="wn-card-label">Your referral count</div>
            <div className="wn-stat" data-testid="data-referral-count">{referrals.data.referralCount}</div>
            <p className="wn-stat-caption">People who joined through your invitation.</p>
            <div className="wn-callout" style={{ marginTop: 22 }}><div className="wn-callout-icon"><UsersRound size={18} /></div><p style={{ margin: 0 }}>This is a factual account summary, not a measure of earnings or rewards.</p></div>
          </section>
        </div>
  </>;
}

function AccountPage() {
  return <Protected active="/account" title="Account"><AccountContent /></Protected>;
}

function AccountContent() {
  const userQuery = useGetCurrentUser();
  const logout = useLogout();
  const queryClientInstance = useQueryClient();
  const [, setLocation] = useLocation();
  const signOut = () => logout.mutate(undefined, {
    onSuccess: () => {
      queryClientInstance.clear();
      setLocation('/login');
    },
  });
  if (userQuery.isLoading) return <><PageHead eyebrow="Your membership" title="Account details." description="A straightforward record of your membership with WealthNova." /><div className="wn-loading" data-testid="loading-account"><div className="wn-skeleton" /></div></>;
  if (userQuery.isError) return <><PageHead eyebrow="Your membership" title="Account details." description="A straightforward record of your membership with WealthNova." /><QueryError message={errorMessage(userQuery.error, 'Account details are temporarily unavailable.')} onRetry={() => void userQuery.refetch()} testId="error-account" /></>;
  if (!userQuery.data) return <><PageHead eyebrow="Your membership" title="Account details." description="A straightforward record of your membership with WealthNova." /><div className="wn-loading" data-testid="loading-account"><div className="wn-skeleton" /></div></>;
  const user = userQuery.data;
  return <>
    <PageHead eyebrow="Your membership" title="Account details." description="A straightforward record of your membership with WealthNova." />
        <div className="wn-grid wn-fade">
          <section className="wn-card wn-wide" data-testid="panel-account-profile">
            <div className="wn-panel-head"><h2>Profile</h2><UserRound size={20} color="#547762" /></div>
            <div className="wn-summary-list">
              <div className="wn-summary-row"><span>Mobile number</span><strong data-testid="profile-mobile">{user.mobileNumber}</strong></div>
              <div className="wn-summary-row"><span>Personal referral code</span><strong data-testid="profile-referral-code">{user.referralCode}</strong></div>
              <div className="wn-summary-row"><span>Member role</span><strong data-testid="profile-role">{user.role === 'ADMIN' ? 'Administrator' : 'Member'}</strong></div>
              <div className="wn-summary-row"><span>Membership status</span><strong data-testid="profile-status">{user.status.replaceAll('_', ' ')}</strong></div>
              <div className="wn-summary-row"><span>Joined</span><strong data-testid="profile-created">{new Date(user.createdAt).toLocaleDateString()}</strong></div>
              <div className="wn-summary-row"><span>Referred by</span><strong data-testid="profile-referred-by">{user.referredBy || 'Direct / not recorded'}</strong></div>
            </div>
            {logout.isError && <div className="wn-feedback error" role="alert" data-testid="error-signout">{errorMessage(logout.error, 'Sign out could not be completed. Please try again.')}</div>}
            <button className="wn-button" onClick={signOut} disabled={logout.isPending} style={{ marginTop: 24 }} data-testid="button-sign-out">
              {logout.isPending ? <LoaderCircle className="animate-spin" size={16} /> : <LogOut size={16} />}Sign out
            </button>
          </section>
          <WithdrawalAccountLink />
          {user.role === 'ADMIN' && <section className="wn-card wn-full" data-testid="panel-admin-withdrawals"><Link href="/admin/withdrawals" className="wn-link" data-testid="link-admin-withdrawals">Review withdrawals</Link></section>}
          <section className="wn-card wn-narrow" data-testid="panel-account-security">
            <div className="wn-panel-head"><h2>Account security</h2><LockKeyhole size={20} color="#547762" /></div>
            <div className="wn-callout"><div className="wn-callout-icon"><KeyRound size={18} /></div><div><strong>Private by design</strong><p>Your member area uses your signed-in session. Sign out when you’re finished on a shared device.</p></div></div>
          </section>
        </div>
  </>;
}

function AuthLayout({ mode, children }: { mode: 'login' | 'register'; children: ReactNode }) {
  return <div className="wn-form-shell wn-fade">
    <section className="wn-form-side">
      <Brand />
      <div><h1>{mode === 'register' ? 'A trusted way to begin.' : 'Welcome back to your corner.'}</h1><p>{mode === 'register' ? 'Join through someone you know. Your account starts with a personal invitation and a clear view of what comes next.' : 'Your member account and invite details are right where you left them.'}</p></div>
      <small>MEMBERSHIP, MADE PERSONAL</small>
    </section>
    <section className="wn-form-area">{children}</section>
  </div>;
}

const mobileNumberSchema = z.string().refine(
  isValidPhilippineMobileNumber,
  PHILIPPINE_MOBILE_VALIDATION_MESSAGE,
);
const loginSchema = z.object({
  mobileNumber: mobileNumberSchema,
  password: z.string().min(1, 'Enter your password.').max(128, 'Password must be 128 characters or fewer.'),
});
const registrationSchema = z.object({
  mobileNumber: mobileNumberSchema,
  password: z.string().min(12, 'Use at least 12 characters.').max(128, 'Password must be 128 characters or fewer.'),
  referralCode: z.string().min(3, 'Referral code must be at least 3 characters.').max(32, 'Referral code must be 32 characters or fewer.'),
});

function LoginPage() {
  const login = useLogin();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { mobileNumber: '', password: '' },
  });
  const submit = (values: z.infer<typeof loginSchema>) => {
    const mobileNumber = normalizePhilippineMobileNumber(values.mobileNumber);
    if (!mobileNumber) {
      form.setError('mobileNumber', { type: 'validate', message: PHILIPPINE_MOBILE_VALIDATION_MESSAGE });
      return;
    }
    login.mutate({ data: { mobileNumber, password: values.password } }, {
      onSuccess: (user: SessionUser) => {
        client.clear();
        client.setQueryData(getGetCurrentUserQueryKey(), user);
        setLocation('/');
      },
    });
  };
  return <AuthLayout mode="login">
    <div className="wn-form-card">
      <div className="wn-eyebrow">Member sign in</div>
      <h2>Welcome back</h2><p className="wn-form-intro">Sign in with the mobile number connected to your account.</p>
      {login.isError && <div className="wn-feedback error" role="alert" data-testid="error-login">{errorMessage(login.error, 'We couldn’t sign you in. Check your details and try again.')}</div>}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(submit)} data-testid="form-login">
          <FormField control={form.control} name="mobileNumber" render={({ field, fieldState }) => (
            <div className="wn-field"><label htmlFor="login-mobile">Mobile number</label><input {...field} id="login-mobile" className="wn-input" type="tel" autoComplete="tel" placeholder="09171234567" maxLength={16} required data-testid="input-login-mobile" /><span className="wn-helper">Use a Philippine number: 09XXXXXXXXX, +639XXXXXXXXX, or 639XXXXXXXXX.</span>{fieldState.error?.message && <span className="wn-field-error" role="alert" data-testid="error-login-mobile">{fieldState.error.message}</span>}</div>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <div className="wn-field"><label htmlFor="login-password">Password</label><input {...field} id="login-password" className="wn-input" type="password" autoComplete="current-password" required data-testid="input-login-password" /></div>
          )} />
          <button className="wn-button wn-button-full" type="submit" disabled={login.isPending} data-testid="button-login">
            {login.isPending ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowRight size={16} />}Sign in
          </button>
        </form>
      </Form>
      <div className="wn-form-bottom">New to WealthNova? <Link href="/register" data-testid="link-register">Create an account</Link></div>
    </div>
  </AuthLayout>;
}

function RegisterPage() {
  const register = useRegister();
  const validate = useValidateReferralCode();
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const form = useForm<z.infer<typeof registrationSchema>>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      mobileNumber: '',
      password: '',
      referralCode: new URLSearchParams(window.location.search).get('referralCode') ?? '',
    },
  });
  const referralCode = form.watch('referralCode');
  const [validation, setValidation] = useState<{ valid: boolean; message: string } | null>(null);
  const [formError, setFormError] = useState('');
  const latestCode = useRef(referralCode);
  latestCode.current = referralCode;
  useEffect(() => {
    const code = referralCode.trim();
    setValidation(null);
    if (code.length < 3 || code.length > 32) return;
    const timer = window.setTimeout(() => {
      validate.mutate({ data: { referralCode: code } }, {
        onSuccess: result => {
          if (latestCode.current.trim() === code) setValidation(result);
        },
        onError: () => {
          if (latestCode.current.trim() === code) setValidation({ valid: false, message: 'We couldn’t check this code right now. Please try again.' });
        },
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [referralCode]);
  const submit = (values: z.infer<typeof registrationSchema>) => {
    setFormError('');
    if (!validation?.valid || referralCode.trim().length < 3) {
      setFormError('Enter a valid referral code before creating your account.');
      return;
    }
    const mobileNumber = normalizePhilippineMobileNumber(values.mobileNumber);
    if (!mobileNumber) {
      form.setError('mobileNumber', { type: 'validate', message: PHILIPPINE_MOBILE_VALIDATION_MESSAGE });
      return;
    }
    register.mutate({ data: { mobileNumber, password: values.password, referralCode: values.referralCode.trim() } }, {
      onSuccess: (user: SessionUser) => {
        client.clear();
        client.setQueryData(getGetCurrentUserQueryKey(), user);
        setLocation('/');
      },
    });
  };
  return <AuthLayout mode="register">
    <div className="wn-form-card">
      <div className="wn-eyebrow">Join by invitation</div>
      <h2>Create your account</h2><p className="wn-form-intro">Use your mobile number and the referral code shared with you.</p>
      {formError && <div className="wn-feedback error" role="alert" data-testid="error-register-form">{formError}</div>}
      {register.isError && <div className="wn-feedback error" role="alert" data-testid="error-register">{errorMessage(register.error, 'We couldn’t create your account. Please try again.')}</div>}
      <Form {...form}>
        <form onSubmit={form.handleSubmit(submit)} data-testid="form-register">
          <FormField control={form.control} name="mobileNumber" render={({ field, fieldState }) => (
            <div className="wn-field"><label htmlFor="register-mobile">Mobile number</label><input {...field} id="register-mobile" className="wn-input" type="tel" autoComplete="tel" placeholder="09171234567" maxLength={16} required data-testid="input-register-mobile" /><span className="wn-helper">Use a Philippine number: 09XXXXXXXXX, +639XXXXXXXXX, or 639XXXXXXXXX.</span>{fieldState.error?.message && <span className="wn-field-error" role="alert" data-testid="error-register-mobile">{fieldState.error.message}</span>}</div>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <div className="wn-field"><label htmlFor="register-password">Password</label><input {...field} id="register-password" className="wn-input" type="password" autoComplete="new-password" minLength={12} maxLength={128} required data-testid="input-register-password" /><span className="wn-helper">Use at least 12 characters.</span></div>
          )} />
          <FormField control={form.control} name="referralCode" render={({ field }) => (
            <div className="wn-field"><label htmlFor="register-referral">Referral code <span aria-hidden="true">*</span></label><input {...field} id="register-referral" className="wn-input" type="text" autoComplete="off" minLength={3} maxLength={32} required aria-describedby="referral-validation" data-testid="input-register-referral" />
              <span id="referral-validation" className="wn-helper" data-testid="status-referral-validation">
                {referralCode.trim().length < 3 ? 'Enter the code shared with you. We’ll check it before you continue.' :
                  validate.isPending ? 'Checking referral code…' :
                    validation ? validation.message : 'Checking referral code…'}
              </span>
              <span className="wn-helper" data-testid="hint-bootstrap-referral">Initial setup code: <strong>NOVA-START</strong>. Use this code for the initial setup invitation.</span>
            </div>
          )} />
          <button className="wn-button wn-button-full" type="submit" disabled={register.isPending || !validation?.valid} data-testid="button-register">
            {register.isPending ? <LoaderCircle className="animate-spin" size={16} /> : <ArrowRight size={16} />}Create account
          </button>
        </form>
      </Form>
      <div className="wn-form-bottom">Already a member? <Link href="/login" data-testid="link-login">Sign in</Link></div>
    </div>
  </AuthLayout>;
}

function NotFound() {
  const [, setLocation] = useLocation();
  return <div className="wn-app" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 22 }}>
    <div className="wn-card" style={{ maxWidth: 440, textAlign: 'center' }} data-testid="page-not-found">
      <div className="wn-empty-mark"><CircleHelp size={21} /></div><h2 className="wn-display" style={{ fontSize: 27 }}>This page isn’t here.</h2>
      <p className="wn-stat-caption" style={{ lineHeight: 1.6 }}>The address may have changed. Head back to your account sign in.</p>
      <button className="wn-button" style={{ marginTop: 18 }} onClick={() => setLocation('/login')} data-testid="button-not-found-login">Go to sign in <ArrowRight size={15} /></button>
    </div>
  </div>;
}

function Router() {
  const [location] = useLocation();
  return (
    <ErrorBoundary resetKey={location}>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/plans" component={PlansPage} />
        <Route path="/deposit" component={DepositPage} />
        <Route path="/admin/deposits" component={AdminDepositsPage} />
        <Route path="/withdrawal" component={WithdrawalPage} />
        <Route path="/admin/withdrawals" component={AdminWithdrawalsPage} />
        <Route path="/invite" component={InvitePage} />
        <Route path="/account" component={AccountPage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/register" component={RegisterPage} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  </QueryClientProvider>;
}

export default App;
