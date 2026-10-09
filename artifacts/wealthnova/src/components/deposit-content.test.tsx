import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DepositPaymentSettings, DepositRequest, DepositRequestInput } from '@workspace/api-client-react';
import { DepositContent } from './deposit-content';

type SubmitCallbacks = {
  onSuccess: (saved: DepositRequest) => void;
  onError: (error: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  settings: {} as DepositPaymentSettings,
  submit: vi.fn<(input: { data: DepositRequestInput }, callbacks: SubmitCallbacks) => void>(),
  upload: vi.fn(),
}));

// All payment responses are isolated fixtures; these tests make no API calls.
vi.mock('@workspace/api-client-react', () => ({
  getGetDepositPaymentSettingsQueryKey: () => ['deposit-settings'],
  getGetMyDepositRequestsQueryKey: () => ['deposit-requests'],
  useGetCurrentUser: () => ({ data: { role: 'MEMBER' } }),
  useGetDepositPaymentSettings: () => ({ data: mocks.settings }),
  useGetMyDepositRequests: () => ({ data: [] }),
  useSubmitDepositRequest: () => ({ mutate: mocks.submit, isPending: false }),
  useUploadDepositImage: () => ({ mutate: mocks.upload, isPending: false }),
  useUpdateDepositPaymentSettings: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderDeposit() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><DepositContent /></QueryClientProvider>);
  return { ...view, client };
}

function fillDeposit() {
  fireEvent.change(screen.getByLabelText('Amount sent (PHP)'), { target: { value: '500.00' } });
  fireEvent.change(screen.getByLabelText('GCash reference number'), { target: { value: 'TEST-123456' } });
  fireEvent.change(screen.getByLabelText('Receipt screenshot'), {
    target: { files: [new File(['fixture'], 'test-receipt.png', { type: 'image/png' })] },
  });
}

function saved(status: DepositRequest['status'], rejectionReason: string | null = null): DepositRequest {
  return {
    id: 'fixture-request', status, rejectionReason, amount: '500.00',
    transactionReference: 'TEST-123456', receiptUrl: '/api/deposit-images/fixture-receipt',
    accountName: 'Fixture', accountNumber: 'Fixture', createdAt: '2026-01-01T00:00:00Z',
    reviewedAt: null, approvedAt: null, verifiedAmount: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {
    configured: true, enabled: true, submissionsEnabled: true, minimumAmount: '350.00', version: 7,
    accountName: 'Fixture', accountNumber: 'Fixture', instructions: 'Fixture',
    qrImageId: null, qrImageUrl: null, accountDetailsConfirmed: true, blockingReasons: [],
  };
  mocks.upload.mockImplementation((_input, callbacks) => callbacks.onSuccess({ id: 'fixture-receipt' }));
});

afterEach(cleanup);

describe('deposit submission confirmation', () => {
  it('shows Pending Verification for a new pending request and refreshes request history', () => {
    const { client } = renderDeposit();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    mocks.submit.mockImplementation((_input, callbacks) => callbacks.onSuccess(saved('PENDING_VERIFICATION')));
    fillDeposit();
    fireEvent.click(screen.getByTestId('button-submit-deposit'));
    expect(screen.getByTestId('status-deposit-success').textContent)
      .toBe('Saved as Pending Verification. No wallet has been credited.');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['deposit-requests'] });
    expect((screen.getByLabelText('Amount sent (PHP)') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('text-receipt-state').textContent).not.toContain('test-receipt.png');
    expect(screen.queryByTestId('button-edit-deposit')).toBeNull();
    fireEvent.change(screen.getByLabelText('Amount sent (PHP)'), { target: { value: '600' } });
    expect(screen.queryByTestId('status-deposit-success')).toBeNull();
  });

  it.each(['PENDING_VERIFICATION', 'APPROVED', 'REJECTED'] as const)(
    'uses the saved %s status after a delayed network retry, preserving the locked payload',
    returnedStatus => {
      const view = renderDeposit();
      mocks.submit.mockImplementationOnce((_input, callbacks) => callbacks.onError(new TypeError('Network failure')));
      fillDeposit();
      fireEvent.click(screen.getByTestId('button-submit-deposit'));
      const original = mocks.submit.mock.calls[0][0].data;
      expect(original.idempotencyKey).toMatch(/^wn-/);
      expect(original).toMatchObject({
        amount: '500.00', transactionReference: 'TEST-123456', receiptImageId: 'fixture-receipt', settingsVersion: 7,
      });
      for (const label of ['Amount sent (PHP)', 'GCash reference number', 'Receipt screenshot']) {
        expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
      }
      expect(screen.getByTestId('error-deposit-submit').textContent).toContain('details are locked');

      // Settings may change while the server has already saved/reviewed this request.
      mocks.settings = { ...mocks.settings, enabled: false, version: 8 };
      view.rerender(<QueryClientProvider client={view.client}><DepositContent /></QueryClientProvider>);
      mocks.submit.mockImplementationOnce((_input, callbacks) =>
        callbacks.onSuccess(saved(returnedStatus, returnedStatus === 'REJECTED' ? 'Reference does not match the receipt.' : null)));
      expect(screen.getByTestId('button-submit-deposit').textContent).toBe('Retry submit');
      fireEvent.click(screen.getByTestId('button-submit-deposit'));
      expect(mocks.submit.mock.calls[1][0].data).toBe(original);
      expect(mocks.upload).toHaveBeenCalledTimes(1);
      const confirmation = screen.getByTestId('status-deposit-success').textContent;
      if (returnedStatus === 'PENDING_VERIFICATION') {
        expect(confirmation).toContain('Pending Verification');
        expect(confirmation).toContain('No wallet has been credited.');
      } else {
        expect(confirmation).not.toContain('Pending Verification');
        expect(confirmation).not.toContain('No wallet has been credited.');
        if (returnedStatus === 'APPROVED') {
          expect(confirmation).toContain('Approved. This is an existing approved request.');
          expect(confirmation).toContain('No additional wallet credit was created by retrying.');
        } else {
          expect(confirmation).toContain('Rejected.');
          expect(screen.getByTestId('text-deposit-submit-rejection-reason').textContent)
            .toBe('Reason: Reference does not match the receipt.');
        }
      }
      expect(screen.queryByTestId('error-deposit-submit')).toBeNull();
      expect((screen.getByTestId('button-submit-deposit') as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it('does not claim pending status when a rejected response has no reason', () => {
    renderDeposit();
    mocks.submit.mockImplementation((_input, callbacks) => callbacks.onSuccess(saved('REJECTED')));
    fillDeposit();
    fireEvent.click(screen.getByTestId('button-submit-deposit'));
    expect(screen.getByTestId('status-deposit-success').textContent).toBe('Rejected. This request was already rejected.');
    expect(screen.queryByTestId('text-deposit-submit-rejection-reason')).toBeNull();
  });

  it('renders the saved rejection reason as text, not HTML', () => {
    const { container } = renderDeposit();
    mocks.submit.mockImplementation((_input, callbacks) =>
      callbacks.onSuccess(saved('REJECTED', '<script>untrusted reason</script>')));
    fillDeposit();
    fireEvent.click(screen.getByTestId('button-submit-deposit'));
    expect(screen.getByTestId('text-deposit-submit-rejection-reason').textContent)
      .toContain('<script>untrusted reason</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('keeps fresh submissions disabled when deposits are unavailable', () => {
    mocks.settings.enabled = false;
    renderDeposit();
    const button = screen.getByTestId('button-submit-deposit') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('Deposits unavailable');
    fireEvent.click(button);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('clears the previous confirmation when uploading a new receipt', () => {
    renderDeposit();
    let callbacks: SubmitCallbacks | undefined;
    mocks.submit.mockImplementation((_input, options) => { callbacks = options; });
    fillDeposit();
    fireEvent.click(screen.getByTestId('button-submit-deposit'));
    act(() => callbacks!.onSuccess(saved('APPROVED')));
    expect(screen.getByTestId('status-deposit-success')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Receipt screenshot'), {
      target: { files: [new File(['fixture'], 'another.png', { type: 'image/png' })] },
    });
    expect(screen.queryByTestId('status-deposit-success')).toBeNull();
  });
});
