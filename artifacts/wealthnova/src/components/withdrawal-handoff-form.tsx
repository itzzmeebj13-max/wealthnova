import { useState } from 'react';
import { useHandoffWithdrawal, type Withdrawal } from '@workspace/api-client-react';
import { errMsg, peso } from './withdrawal-content';

export function WithdrawalHandoffForm({ withdrawal, onDone, onCancel }: {
  withdrawal: Withdrawal; onDone: () => void; onCancel: () => void;
}) {
  const [snapshot] = useState(withdrawal);
  const [status, setStatus] = useState<'UNKNOWN' | 'NOT_SENT' | 'SENT'>('UNKNOWN');
  const [note, setNote] = useState('');
  const [stopped, setStopped] = useState(false);
  const [reference, setReference] = useState(snapshot.payoutReference ?? '');
  const [paid, setPaid] = useState('');
  const [error, setError] = useState('');
  const mutation = useHandoffWithdrawal({ request: { headers: { 'X-WealthNova-Request': '1' } } });
  const stale = withdrawal.updatedAt !== snapshot.updatedAt || withdrawal.processingById !== snapshot.processingById || withdrawal.status !== 'PROCESSING';
  const submit = () => {
    setError('');
    if (status === 'UNKNOWN') return setError('Reconcile the actual GCash status first. Unknown or pending transfers cannot be handed off.');
    if (!stopped) return setError('Stop the previous processor from sending this payout before accepting responsibility.');
    if (note.trim().length < 20) return setError('Document reconciliation and handoff coordination in at least 20 characters.');
    if (status === 'SENT' && (!/^\d{1,12}(\.\d{1,2})?$/.test(paid) || Number(paid) !== Number(snapshot.netAmount) || reference.trim().length < 6)) {
      return setError('Enter the verified payment reference and exact net paid amount.');
    }
    mutation.mutate({ withdrawalId: snapshot.id, data: {
      expectedProcessorId: snapshot.processingById!, expectedUpdatedAt: snapshot.updatedAt,
      payoutStatus: status, confirmedPreviousProcessorStopped: stopped, reconciliationNote: note.trim(),
      ...(status === 'SENT' ? { payoutReference: reference.trim(), paidAmount: paid } : {}),
    } }, { onSuccess: onDone, onError: e => setError(errMsg(e, 'Handoff failed. Reload and reconcile again before retrying.')) });
  };
  return <div className="wn-confirm" data-testid="form-withdrawal-handoff"><fieldset disabled={mutation.isPending || stale} style={{ border: 0, minWidth: 0, padding: 0 }}>
    <strong>Reconcile and take over review</strong>
    <p>This does not send money, complete the withdrawal, or release its reservation. You will become the assigned processor.</p>
    <p>Check the actual GCash transaction history for {snapshot.accountNumber} ({snapshot.accountName}), net {peso(snapshot.netAmount)}. Coordinate with the previous processor or the authorized payout account custodian to stop any further transfer. If you cannot establish payment status or stop their access, cancel and leave the funds reserved.</p>
    {stale && <div className="wn-feedback error" role="alert">This review changed. Cancel and reopen using the latest record.</div>}
    {error && <div className="wn-feedback error" role="alert">{error}</div>}
    <div className="wn-field"><label htmlFor={`hs-${snapshot.id}`}>Verified GCash payment status</label>
      <select id={`hs-${snapshot.id}`} className="wn-input" value={status} onChange={e => setStatus(e.target.value as typeof status)} data-testid="select-handoff-payment-status">
        <option value="UNKNOWN">Unknown / not reconciled — blocked</option>
        <option value="NOT_SENT" disabled={!!snapshot.payoutReference}>Not sent — verified no pending or successful transfer</option>
        <option value="SENT">Already sent — never resend</option>
      </select>
    </div>
    {status === 'SENT' && <>
      <p><strong>Do not send again.</strong> The verified reference will be retained. Rejection is blocked; record completion separately after handoff.</p>
      <div className="wn-field"><label htmlFor={`hr-${snapshot.id}`}>Actual payout reference</label><input id={`hr-${snapshot.id}`} className="wn-input" maxLength={64} value={reference} readOnly={!!snapshot.payoutReference} onChange={e => setReference(e.target.value)} data-testid="input-handoff-reference" /></div>
      <div className="wn-field"><label htmlFor={`hp-${snapshot.id}`}>Actual paid amount (PHP)</label><input id={`hp-${snapshot.id}`} className="wn-input" inputMode="decimal" value={paid} onChange={e => setPaid(e.target.value)} data-testid="input-handoff-paid-amount" /></div>
    </>}
    <div className="wn-field"><label htmlFor={`hn-${snapshot.id}`}>Reconciliation and coordination note (20–1000 characters)</label><textarea id={`hn-${snapshot.id}`} className="wn-input" style={{ height: 110, padding: 12 }} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} placeholder="Why unavailable; payment history checked; who stopped the previous processor; how duplicate payment was prevented." data-testid="input-handoff-note" /></div>
    <label style={{ display: 'flex', gap: 10, fontSize: 13, marginBottom: 14 }}><input type="checkbox" checked={stopped} onChange={e => setStopped(e.target.checked)} data-testid="checkbox-handoff-stopped" />I coordinated the handoff and verified the previous processor can no longer send this payout. I accept responsibility and will not resend an already-sent payment.</label>
    <button className="wn-button" disabled={status === 'UNKNOWN' || !stopped || mutation.isPending || stale} onClick={submit} data-testid="button-confirm-handoff">{mutation.isPending ? 'Recording handoff…' : 'Accept audited handoff'}</button>
    </fieldset>
    <button type="button" className="wn-button wn-button-quiet" disabled={mutation.isPending} onClick={onCancel}>Cancel</button>
  </div>;
}
