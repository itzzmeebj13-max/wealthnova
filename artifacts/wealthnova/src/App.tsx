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
  UsersRound,
} from 'lucide-react';
import {
  getGetCurrentUserQueryKey,
  useGetCurrentUser,
  useGetDashboardSummary,
  useGetMyReferrals,
  useGetPlans,
  useGetDepositStatus,
  useLogin,
  useLogout,
  useRegister,
  useValidateReferralCode,
} from '@workspace/api-client-react';
import type { SessionUser } from '@workspace/api-client-react';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Form, FormField } from '@/components/ui/form';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
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
      <span className="wn-brand-mark"><Leaf size={19} strokeWidth={2.4} /></span>
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

function DashboardContent() {
  const summary = useGetDashboardSummary();
  const referrals = useGetMyReferrals();
  const [, setLocation] = useLocation();
  const { data: user } = useGetCurrentUser();
  if (summary.isLoading) return <><PageHead eyebrow="Your overview" title="A clearer view of your account." description="The essentials, at a glance. Your membership and referral details are always here when you need them." /><div className="wn-loading" data-testid="loading-dashboard"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  if (summary.isError) return <><PageHead eyebrow="Your overview" title="A clearer view of your account." description="The essentials, at a glance. Your membership and referral details are always here when you need them." /><QueryError message={errorMessage(summary.error, 'Please try loading your account summary again.')} onRetry={() => void summary.refetch()} testId="error-dashboard" /></>;
  if (!summary.data) return <><PageHead eyebrow="Your overview" title="A clearer view of your account." description="The essentials, at a glance. Your membership and referral details are always here when you need them." /><div className="wn-loading" data-testid="loading-dashboard"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  return (
    <>
      <PageHead eyebrow="Your overview" title="A clearer view of your account." description="The essentials, at a glance. Your membership and referral details are always here when you need them." />
      <div className="wn-grid wn-fade">
            <section className="wn-card wn-hero-card" data-testid="card-welcome">
              <div className="wn-hero-kicker">Member since {new Date(summary.data.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
              <h2>Good to have you here.</h2>
              <p>Your WealthNova account is ready. Find your referral details and current member services below.</p>
              <div className="wn-hero-foot">A MORE PERSONAL FINANCE PORTAL</div>
            </section>
            <section className="wn-card wn-stat-card" data-testid="card-referral-count">
              <div><div className="wn-card-label">People you’ve invited</div>
                <div className="wn-stat" data-testid="data-referral-count">{summary.data.referralCount}</div>
              </div>
              <Link href="/invite" className="wn-link" data-testid="link-dashboard-invite">Your invite details <ChevronRight size={15} /></Link>
            </section>
            <section className="wn-card wn-wide" data-testid="card-account-summary">
              <div className="wn-panel-head"><h2>Account at a glance</h2><BadgeCheck size={20} color="#547762" /></div>
              <div className="wn-summary-list">
                <div className="wn-summary-row"><span>Membership status</span><strong data-testid="status-account">{summary.data.status.replaceAll('_', ' ')}</strong></div>
                <div className="wn-summary-row"><span>Account type</span><strong data-testid="data-role">{summary.data.role === 'ADMIN' ? 'Administrator' : 'Member'}</strong></div>
                <div className="wn-summary-row"><span>Mobile number</span><strong data-testid="data-mobile">{user?.mobileNumber ?? '—'}</strong></div>
                <div className="wn-summary-row"><span>Member since</span><strong data-testid="data-member-since">{new Date(summary.data.createdAt).toLocaleDateString()}</strong></div>
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

function PlansContent() {
  const plans = useGetPlans();
  if (plans.isLoading) return <><PageHead eyebrow="Available to members" title="Plans, without the guesswork." description="Review the options currently configured for your account. Availability and details come directly from WealthNova." /><div className="wn-loading" data-testid="loading-plans"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  if (plans.isError) return <><PageHead eyebrow="Available to members" title="Plans, without the guesswork." description="Review the options currently configured for your account. Availability and details come directly from WealthNova." /><QueryError message={errorMessage(plans.error, 'Plan information is temporarily unavailable.')} onRetry={() => void plans.refetch()} testId="error-plans" /></>;
  if (!plans.data) return <><PageHead eyebrow="Available to members" title="Plans, without the guesswork." description="Review the options currently configured for your account. Availability and details come directly from WealthNova." /><div className="wn-loading" data-testid="loading-plans"><div className="wn-skeleton" /></div></>;
  return <>
    <PageHead eyebrow="Available to members" title="Plans, without the guesswork." description="Review the options currently configured for your account. Availability and details come directly from WealthNova." />
    {plans.data.length === 0 ? <div className="wn-card" data-testid="empty-plans"><div className="wn-empty"><div className="wn-empty-mark"><HandCoins size={21} /></div><h3>No plans are configured yet</h3><p>There aren’t any plans available to display right now. Check back here for current options.</p></div></div> :
          <div className="wn-grid wn-fade" data-testid="list-plans">
            {plans.data.map(plan => <article className="wn-card wn-plan-card" key={plan.id} data-testid={`card-plan-${plan.id}`}>
              <div className="wn-panel-head"><h2 data-testid={`data-plan-name-${plan.id}`}>{plan.name}</h2><span className="wn-status-pill" data-testid={`status-plan-${plan.id}`}>{plan.status.toLowerCase()}</span></div>
              <p data-testid={`data-plan-description-${plan.id}`}>{plan.description}</p>
              <div className="wn-plan-meta"><span>Minimum amount</span><strong data-testid={`data-plan-minimum-${plan.id}`}>{plan.currency} {plan.minimumAmount.toLocaleString()}</strong></div>
            </article>)}
          </div>}
  </>;
}

function DepositPage() {
  return <Protected active="/deposit" title="Deposit"><DepositContent /></Protected>;
}

function DepositContent() {
  const availability = useGetDepositStatus();
  if (availability.isLoading) return <><PageHead eyebrow="Provider availability" title="Deposit, when it’s ready." description="We’ll show the real payment-provider status here. No payment is accepted or confirmed on this page." /><div className="wn-loading" data-testid="loading-deposit"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  if (availability.isError) return <><PageHead eyebrow="Provider availability" title="Deposit, when it’s ready." description="We’ll show the real payment-provider status here. No payment is accepted or confirmed on this page." /><QueryError message={errorMessage(availability.error, 'Provider availability is temporarily unavailable.')} onRetry={() => void availability.refetch()} testId="error-deposit" /></>;
  if (!availability.data) return <><PageHead eyebrow="Provider availability" title="Deposit, when it’s ready." description="We’ll show the real payment-provider status here. No payment is accepted or confirmed on this page." /><div className="wn-loading" data-testid="loading-deposit"><div className="wn-skeleton" /></div></>;
  return <>
    <PageHead eyebrow="Provider availability" title="Deposit, when it’s ready." description="We’ll show the real payment-provider status here. No payment is accepted or confirmed on this page." />
        <div className="wn-card wn-fade" style={{ maxWidth: 790 }} data-testid="panel-deposit-status">
          <div className="wn-panel-head"><h2>Current provider status</h2><CreditCard size={20} color="#547762" /></div>
          <div className={`wn-callout`} style={{ background: availability.data.enabled ? '#e7efe7' : '#f0eadc' }}>
            <div className="wn-callout-icon"><Activity size={18} /></div>
            <div>
              <strong data-testid="status-deposit-provider">{availability.data.enabled ? 'Provider available' : 'Provider unavailable'}</strong>
              <p data-testid="data-deposit-message">{availability.data.message}</p>
            </div>
          </div>
          <div className="wn-summary-row" style={{ marginTop: 22 }}>
            <span>Deposit actions</span><strong data-testid="status-deposit-action">{availability.data.enabled ? 'Not available in this portal' : 'Unavailable'}</strong>
          </div>
          <p className="wn-helper" style={{ marginTop: 14 }}>This status is informational only. No payment has been started, received, or confirmed.</p>
        </div>
  </>;
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
      queryClientInstance.removeQueries({ queryKey: getGetCurrentUserQueryKey() });
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

const mobileNumberSchema = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'Enter a mobile number with country code, such as +14155550123.');
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
    const { mobileNumber, password } = values;
    login.mutate({ data: { mobileNumber, password } }, {
      onSuccess: (user: SessionUser) => {
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
          <FormField control={form.control} name="mobileNumber" render={({ field }) => (
            <div className="wn-field"><label htmlFor="login-mobile">Mobile number</label><input {...field} id="login-mobile" className="wn-input" type="tel" autoComplete="tel" placeholder="+14155550123" required pattern="^\+[1-9][0-9]{7,14}$" data-testid="input-login-mobile" /><span className="wn-helper">Include your country code, for example +14155550123.</span></div>
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
    register.mutate({ data: { mobileNumber: values.mobileNumber, password: values.password, referralCode: values.referralCode.trim() } }, {
      onSuccess: (user: SessionUser) => {
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
          <FormField control={form.control} name="mobileNumber" render={({ field }) => (
            <div className="wn-field"><label htmlFor="register-mobile">Mobile number</label><input {...field} id="register-mobile" className="wn-input" type="tel" autoComplete="tel" placeholder="+14155550123" required pattern="^\+[1-9][0-9]{7,14}$" data-testid="input-register-mobile" /><span className="wn-helper">Include your country code: + followed by 8–15 digits.</span></div>
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
