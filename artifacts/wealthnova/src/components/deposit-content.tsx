import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { CreditCard, LoaderCircle, ShieldCheck } from 'lucide-react';
import {
  getGetDepositPaymentSettingsQueryKey,
  getGetMyDepositRequestsQueryKey,
  useGetCurrentUser,
  useGetDepositPaymentSettings,
  useGetMyDepositRequests,
  useSubmitDepositRequest,
  useUpdateDepositPaymentSettings,
  useUploadDepositImage,
} from '@workspace/api-client-react';
import type { DepositPaymentSettings, DepositRequest, DepositRequestInput } from '@workspace/api-client-react';
import { isValidPhilippineMobileNumber, PHILIPPINE_MOBILE_VALIDATION_MESSAGE } from '@workspace/api-zod';

const REQ = { request: { headers: { 'X-WealthNova-Request': '1' } } };
const MAX = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const UNAVAILABLE = 'GCash payment details are currently unavailable.';

function msg(e: unknown, fb: string) {
  const err = e as { message?: string; data?: { error?: string } } | null;
  return err?.data?.error || err?.message || fb;
}
function status(e: unknown) {
  return (e as { status?: number } | null)?.status;
}
function checkFile(f: File) {
  if (!TYPES.includes(f.type)) return 'Use a JPEG, PNG or WebP image.';
  if (f.size > MAX) return 'Image must be 5 MB or smaller.';
  return '';
}
function peso(v: string) {
  return `₱${Number(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DepositContent() {
  const settings = useGetDepositPaymentSettings({ query: { queryKey: getGetDepositPaymentSettingsQueryKey(), refetchInterval: 15000 } });
  const me = useGetCurrentUser();
  const head = (
    <div className="wn-page-head">
      <div className="wn-eyebrow">Manual GCash deposit</div>
      <h1 className="wn-display">Manual GCash deposits.</h1>
      <p>Submitting a request only records your payment details for review. Nothing is credited to your wallet until a deposit is verified.</p>
    </div>
  );
  if (settings.isError) {
    return <>{head}<div className="wn-empty" role="alert" data-testid="error-deposit"><h3>We couldn’t load deposit details</h3><p>{msg(settings.error, 'Please try again.')}</p><button className="wn-button wn-button-quiet" style={{ marginTop: 16 }} onClick={() => void settings.refetch()} data-testid="button-retry">Try again</button></div></>;
  }
  if (!settings.data) return <>{head}<div className="wn-loading" data-testid="loading-deposit"><div className="wn-skeleton" /><div className="wn-skeleton" /></div></>;
  const s = settings.data;
  return (
    <>
      {head}
      <div className="wn-grid wn-fade">
        <PaymentDetails s={s} />
        <DepositForm s={s} />
        <RequestList />
        {me.data?.role === 'ADMIN' && <AdminSettings s={s} refetch={() => settings.refetch()} />}
      </div>
    </>
  );
}

type S = DepositPaymentSettings;

export function AdminPaymentSettingsContent() {
  const me = useGetCurrentUser();
  const admin = me.data?.role === 'ADMIN';
  const settings = useGetDepositPaymentSettings({
    query: { enabled: admin, queryKey: getGetDepositPaymentSettingsQueryKey(), refetchInterval: 15000 },
  });
  if (me.isLoading) return <div className="wn-skeleton" />;
  if (!admin) return <div className="wn-feedback error" role="alert">Administrator access is required.</div>;
  if (settings.isError) return <div className="wn-feedback error" role="alert">{msg(settings.error, 'Payment settings could not be loaded.')} <button className="wn-link" onClick={() => void settings.refetch()}>Retry</button></div>;
  if (!settings.data) return <div className="wn-skeleton" />;
  return <div className="wn-grid"><AdminSettings s={settings.data} refetch={() => settings.refetch()} /></div>;
}

function PaymentDetails({ s }: { s: S }) {
  const hasQr = !!s.qrImageUrl;
  return (
    <section className="wn-card wn-wide" data-testid="panel-payment-details" style={{ gridColumn: 'span 12' }}>
      <div className="wn-panel-head"><h2>Pay via GCash</h2><CreditCard size={20} color="#547762" /></div>
      {!hasQr ? <p data-testid="text-gcash-unavailable">{UNAVAILABLE}</p> : (
        <div style={{ display: 'grid', gap: 16, justifyItems: 'center' }}>
          <img src={s.qrImageUrl!} alt="GCash QR code" data-testid="img-gcash-qr" style={{ width: 'min(100%,260px)', borderRadius: 16, border: '1px solid #e2d6bb', background: '#fff' }} />
          <div style={{ width: '100%' }}>
            <div className="wn-summary-row"><span>Account name</span><strong data-testid="text-account-name">{s.accountName || 'Not configured'}</strong></div>
            <div className="wn-summary-row"><span>Account number</span><strong data-testid="text-account-number">{s.accountNumber || 'Not configured'}</strong></div>
            <div className="wn-summary-row"><span>Minimum amount</span><strong data-testid="text-minimum-amount">{peso(s.minimumAmount)}</strong></div>
            {s.instructions && <p data-testid="text-instructions" style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, color: '#4e665b', margin: '8px 0 0' }}>{s.instructions}</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function DepositForm({ s }: { s: S }) {
  const client = useQueryClient();
  const upload = useUploadDepositImage(REQ);
  const submit = useSubmitDepositRequest(REQ);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [receiptId, setReceiptId] = useState('');
  const [receiptName, setReceiptName] = useState('');
  const [fileKey, setFileKey] = useState(0);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Pick<DepositRequest, 'status' | 'rejectionReason'> | null>(null);
  const keyRef = useRef<string | null>(null);
  const pendingRef = useRef<DepositRequestInput | null>(null);
  const open = s.enabled;
  const frozen = locked || submit.isPending;

  const pick = (f: File | undefined) => {
    if (!f) return;
    setError(''); setDone(null);
    const bad = checkFile(f);
    if (bad) { setError(bad); setFileKey(k => k + 1); return; }
    setReceiptId(''); setReceiptName('');
    upload.mutate({ data: { purpose: 'RECEIPT', file: f } }, {
      onSuccess: img => { setReceiptId(img.id); setReceiptName(f.name); },
      onError: e => { setError(msg(e, 'Receipt upload failed.')); setFileKey(k => k + 1); },
    });
  };
  const go = () => {
    setError(''); setDone(null);
    if (!pendingRef.current) {
      if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) return setError('Enter a valid amount, up to 2 decimals.');
      if (Number(amount) < Number(s.minimumAmount)) return setError(`Minimum amount is ${peso(s.minimumAmount)}.`);
      const ref = reference.trim();
      if (!/^[A-Z0-9]{6,64}$/i.test(ref.replace(/[\s-]/g, ''))) return setError('Reference must contain 6–64 letters or digits.');
      if (!receiptId) return setError('Upload your receipt image first.');
      keyRef.current ??= `wn-${crypto.randomUUID()}`;
      pendingRef.current = { amount, transactionReference: ref, receiptImageId: receiptId, idempotencyKey: keyRef.current, settingsVersion: s.version };
    }
    setLocked(true);
    submit.mutate({ data: pendingRef.current }, {
      onSuccess: saved => {
        keyRef.current = null; pendingRef.current = null; setLocked(false);
        setAmount(''); setReference(''); setReceiptId(''); setReceiptName(''); setFileKey(k => k + 1);
        setDone({ status: saved.status, rejectionReason: saved.rejectionReason });
        void client.invalidateQueries({ queryKey: getGetMyDepositRequestsQueryKey() });
      },
      onError: e => {
        const st = status(e);
        if (typeof st === 'number' && st >= 400 && st < 500) { keyRef.current = null; pendingRef.current = null; setLocked(false); void client.invalidateQueries({ queryKey: getGetDepositPaymentSettingsQueryKey() }); }
        setError(msg(e, 'We couldn’t submit this. Retrying is safe.') + (keyRef.current ? ' You can retry; details are locked so it can’t be duplicated.' : ''));
      },
    });
  };
  const clearKey = () => { keyRef.current = null; pendingRef.current = null; setLocked(false); setError(''); };

  return (
    <section className="wn-card" style={{ gridColumn: 'span 12' }} data-testid="panel-deposit-form">
      <div className="wn-panel-head"><h2>Submit your payment</h2><ShieldCheck size={20} color="#547762" /></div>
      {done && <div className={`wn-feedback${done.status === 'REJECTED' ? ' error' : ''}`} role="status" data-testid="status-deposit-success">
        {done.status === 'PENDING_VERIFICATION' && 'Saved as Pending Verification. No wallet has been credited.'}
        {done.status === 'APPROVED' && 'Approved. This is an existing approved request. No additional wallet credit was created by retrying.'}
        {done.status === 'REJECTED' && <>Rejected. This request was already rejected.{done.rejectionReason && <div style={{ whiteSpace: 'pre-wrap' }} data-testid="text-deposit-submit-rejection-reason">Reason: {done.rejectionReason}</div>}</>}
      </div>}
      {error && <div className="wn-feedback error" role="alert" data-testid="error-deposit-submit">{error}</div>}
      <div className="wn-field"><label htmlFor="dep-amount">Amount sent (PHP)</label>
        <input id="dep-amount" className="wn-input" inputMode="decimal" placeholder="0.00" value={amount} disabled={!open || frozen} onChange={e => { setAmount(e.target.value); setDone(null); }} data-testid="input-deposit-amount" /></div>
      <div className="wn-field"><label htmlFor="dep-ref">GCash reference number</label>
        <input id="dep-ref" className="wn-input" maxLength={64} value={reference} disabled={!open || frozen} onChange={e => { setReference(e.target.value); setDone(null); }} data-testid="input-deposit-reference" /></div>
      <div className="wn-field"><label htmlFor="dep-receipt">Receipt screenshot</label>
        <input key={fileKey} id="dep-receipt" type="file" accept="image/jpeg,image/png,image/webp" className="wn-input" style={{ height: 'auto', padding: 10 }} disabled={!open || frozen || upload.isPending} onChange={e => pick(e.target.files?.[0])} data-testid="input-deposit-receipt" />
        <span className="wn-helper" data-testid="text-receipt-state">{upload.isPending ? 'Uploading…' : receiptName ? `Uploaded: ${receiptName}` : 'JPEG, PNG or WebP, up to 5 MB.'}</span></div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button className="wn-button wn-button-full" style={{ flex: 1 }} onClick={go} disabled={(!open && !locked) || submit.isPending || upload.isPending} data-testid="button-submit-deposit">
          {submit.isPending && <LoaderCircle className="animate-spin" size={16} />}{!open && !locked ? 'Deposits unavailable' : locked && !submit.isPending ? 'Retry submit' : 'Submit Deposit Request'}</button>
        {locked && !submit.isPending && <button className="wn-button wn-button-quiet" onClick={clearKey} data-testid="button-edit-deposit">Edit details</button>}
      </div>
    </section>
  );
}

function RequestList() {
  const q = useGetMyDepositRequests({ query: { queryKey: getGetMyDepositRequestsQueryKey(), refetchInterval: 15000 } });
  return (
    <section className="wn-card" style={{ gridColumn: 'span 12' }} data-testid="list-deposit-requests">
      <div className="wn-panel-head"><h2>Your requests</h2></div>
      {q.isError ? <div className="wn-feedback error" role="alert">{msg(q.error, 'Could not load requests.')} <button className="wn-link" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => void q.refetch()}>Retry</button></div>
        : !q.data ? <div className="wn-skeleton" />
        : q.data.length === 0 ? <div className="wn-empty" data-testid="empty-deposit-requests"><h3>No requests yet</h3><p>Submitted payment details will appear here.</p></div>
        : q.data.map(r => (
          <article key={r.id} className="wn-inv" style={{ marginBottom: 12 }} data-testid={`row-deposit-${r.id}`}>
            <div className="wn-panel-head" style={{ marginBottom: 8 }}><h3><span className="wn-helper" style={{ display: 'block' }}>Requested amount</span>{peso(r.amount)}</h3><span className="wn-status-pill" data-testid={`status-deposit-${r.id}`}>{r.status === 'APPROVED' ? 'Approved' : r.status === 'REJECTED' ? 'Rejected' : 'Pending Verification'}</span></div>
            <div className="wn-summary-row"><span>Reference</span><strong>{r.transactionReference}</strong></div>
            <div className="wn-summary-row"><span>Submitted</span><strong>{new Date(r.createdAt).toLocaleString()}</strong></div>
            {r.status === 'REJECTED' && r.rejectionReason && <div className="wn-summary-row"><span>Reason</span><strong data-testid={`text-rejection-reason-${r.id}`}>{r.rejectionReason}</strong></div>}
            {r.status === 'APPROVED' && r.verifiedAmount && <div className="wn-summary-row"><span>Credited amount</span><strong>{peso(r.verifiedAmount)}{r.approvedAt ? ` on ${new Date(r.approvedAt).toLocaleDateString()}` : ''}</strong></div>}
            <div className="wn-summary-row"><span>Receipt</span><a className="wn-link" href={r.receiptUrl} target="_blank" rel="noreferrer">View receipt</a></div>
          </article>))}
    </section>
  );
}

function AdminSettings({ s, refetch }: { s: S; refetch: () => Promise<{ data?: S }> }) {
  const client = useQueryClient();
  const upload = useUploadDepositImage(REQ);
  const update = useUpdateDepositPaymentSettings(REQ);
  const init = useRef(false);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [instr, setInstr] = useState('');
  const [min, setMin] = useState('');
  const [qrId, setQrId] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const unconfirm = () => { setConfirmed(false); setOn(false); };
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [conflict, setConflict] = useState(false);
  const [fk, setFk] = useState(0);
  const [version, setVersion] = useState(s.version);
  const load = (d: S) => { setName(d.accountName); setNumber(d.accountNumber); setInstr(d.instructions); setMin(d.minimumAmount); setQrId(d.qrImageId); setQrUrl(d.qrImageUrl); setOn(d.submissionsEnabled); setConfirmed(Boolean(d.accountDetailsConfirmed)); setVersion(d.version); };
  useEffect(() => { if (!init.current) { init.current = true; load(s); } }, [s]);

  const pickQr = (f: File | undefined) => {
    if (!f) return;
    setErr(''); setOk('');
    const bad = checkFile(f);
    if (bad) { setErr(bad); setFk(k => k + 1); return; }
    upload.mutate({ data: { purpose: 'QR', file: f } }, {
      onSuccess: img => { setQrId(img.id); setQrUrl(img.url); unconfirm(); setFk(k => k + 1); },
      onError: e => { setErr(msg(e, 'QR upload failed.')); setFk(k => k + 1); },
    });
  };
  const complete = Boolean(name.trim() && isValidPhilippineMobileNumber(number.trim()) && instr.trim() && qrId && /^\d{1,12}(\.\d{1,2})?$/.test(min) && Number(min) >= 350);
  const save = () => {
    setErr(''); setOk(''); setConflict(false);
    if (on && !name.trim()) return setErr('Account name is required.');
    if (number.trim() && !isValidPhilippineMobileNumber(number.trim())) return setErr(PHILIPPINE_MOBILE_VALIDATION_MESSAGE);
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(min) || Number(min) < 350) return setErr('Minimum deposit must be at least ₱350.');
    if (on && !complete) return setErr('Complete all details and a QR image before enabling submissions.');
    if (on && !confirmed) return setErr('Independently confirm the receiving QR code and GCash account details before enabling.');
    update.mutate({ data: { accountName: name.trim(), accountNumber: number.trim(), instructions: instr, minimumAmount: min, qrImageId: qrId, submissionsEnabled: on, accountDetailsConfirmed: confirmed, expectedVersion: version } }, {
      onSuccess: saved => { load(saved); setOk('Settings saved.'); client.setQueryData(getGetDepositPaymentSettingsQueryKey(), saved); void client.invalidateQueries({ queryKey: getGetDepositPaymentSettingsQueryKey() }); },
      onError: e => { if (status(e) === 409) setConflict(true); setErr(msg(e, 'Could not save settings.')); },
    });
  };
  const reload = async () => { const r = await refetch(); if (r.data) load(r.data); setConflict(false); setErr(''); setOk('Reloaded latest saved settings.'); };

  return (
    <section className="wn-card" style={{ gridColumn: 'span 12' }} data-testid="admin-settings">
      <div className="wn-panel-head"><h2>Admin: payment settings</h2><Link href="/admin/deposits" className="wn-link" data-testid="link-review-deposits">Review deposits</Link><span className="wn-status-pill">v{version}</span></div>
      <div className="wn-confirm" style={{ marginBottom: 16 }} data-testid="admin-deposit-setup">
        <strong>Saved deposit status: {s.enabled ? 'Enabled' : 'Unavailable'}</strong>
        {!!s.blockingReasons?.length && <ul style={{ paddingLeft: 20, margin: '8px 0' }}>{s.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        <p className="wn-helper">Enter the real recipient details and instructions, confirm they match the QR, then enable submissions and save. Changes apply only after saving.</p>
      </div>
      {err && <div className="wn-feedback error" role="alert" data-testid="error-admin-settings">{err}</div>}
      {conflict && <button className="wn-button wn-button-quiet" style={{ marginBottom: 14 }} onClick={() => void reload()} data-testid="button-reload-settings">Discard my edits and reload latest</button>}
      {ok && <div className="wn-feedback" role="status" data-testid="status-admin-settings">{ok}</div>}
      <fieldset disabled={update.isPending || upload.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="wn-field"><label htmlFor="a-name">GCash account name</label><input id="a-name" className="wn-input" maxLength={120} value={name} onChange={e => { setName(e.target.value); unconfirm(); }} data-testid="input-admin-account-name" /></div>
      <div className="wn-field"><label htmlFor="a-num">GCash mobile number</label><input id="a-num" className="wn-input" inputMode="tel" maxLength={32} value={number} onChange={e => { setNumber(e.target.value); unconfirm(); }} data-testid="input-admin-account-number" /></div>
      <div className="wn-field"><label htmlFor="a-min">Minimum amount (PHP)</label><input id="a-min" className="wn-input" inputMode="decimal" value={min} onChange={e => setMin(e.target.value)} data-testid="input-admin-minimum" /></div>
      <div className="wn-field"><label htmlFor="a-ins">Instructions</label><textarea id="a-ins" className="wn-input" style={{ height: 110, padding: 12 }} maxLength={3000} value={instr} onChange={e => { setInstr(e.target.value); unconfirm(); }} data-testid="input-admin-instructions" /></div>
      <div className="wn-field"><label htmlFor="a-qr">QR image</label>
        {qrUrl && <img src={qrUrl} alt="QR preview" style={{ width: 160, borderRadius: 12, border: '1px solid #e2d6bb' }} data-testid="img-admin-qr" />}
        <input key={fk} id="a-qr" type="file" accept="image/jpeg,image/png,image/webp" className="wn-input" style={{ height: 'auto', padding: 10 }} disabled={upload.isPending} onChange={e => pickQr(e.target.files?.[0])} data-testid="input-admin-qr-file" />
        <span className="wn-helper">{upload.isPending ? 'Uploading…' : 'Uploading does not change live settings until you save.'}</span>
        {qrId && <button className="wn-button wn-button-quiet" style={{ justifySelf: 'start' }} onClick={() => { setQrId(null); setQrUrl(null); unconfirm(); }} data-testid="button-remove-qr">Remove QR</button>}
      </div>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, marginBottom: 14 }}>
        <input type="checkbox" checked={confirmed} disabled={!complete && !confirmed} onChange={e => { setConfirmed(e.target.checked); if (!e.target.checked) setOn(false); }} data-testid="toggle-account-details-confirmed" style={{ width: 20, height: 20, flexShrink: 0 }} />
        I independently confirmed that this QR code, account name, and number belong to the intended receiving GCash account.
      </label>
      <label style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, fontWeight: 700, marginBottom: 18 }}>
        <input type="checkbox" checked={on} disabled={(!complete || !confirmed) && !on} onChange={e => setOn(e.target.checked)} data-testid="toggle-submissions-enabled" style={{ width: 20, height: 20 }} />
        Accept deposit requests
      </label>
      <button className="wn-button" onClick={save} disabled={update.isPending || upload.isPending} data-testid="button-save-settings">
        {update.isPending && <LoaderCircle className="animate-spin" size={16} />}Save settings</button>
      </fieldset>
    </section>
  );
}
