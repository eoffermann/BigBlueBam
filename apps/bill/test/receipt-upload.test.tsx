// Issue #155: the Bill SPA can attach a receipt to an expense, from the expense
// list (per row) and from the New Expense form, through the existing multipart
// POST /bill/api/v1/expenses/:id/receipt route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@bigbluebam/ui/impersonation-banner', () => ({ impersonateHeader: () => ({}) }));
vi.mock('@/components/burn-gate-notice', () => ({ BurnGateNotice: () => null }));

import { ReceiptUploadButton, receiptFileProblem } from '@/components/receipt-upload';
import { ExpenseNewPage } from '@/pages/expense-new';

const EXPENSE_ID = '11111111-1111-1111-1111-111111111111';

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const pdf = () => new File(['%PDF-1.7'], 'taxi.pdf', { type: 'application/pdf' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReceiptUploadButton', () => {
  it('uploads the picked file as multipart to the expense receipt route', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { receipt_url: '/bill/api/v1/expenses/x/receipt', receipt_filename: 'taxi.pdf', receipt_size_bytes: 8 } }),
    );
    const onUploaded = vi.fn();
    wrap(<ReceiptUploadButton expenseId={EXPENSE_ID} onUploaded={onUploaded} />);
    expect(screen.getByRole('button', { name: /attach receipt/i })).toBeInTheDocument();

    fireEvent.change(screen.getByTestId(`receipt-input-${EXPENSE_ID}`), { target: { files: [pdf()] } });

    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/bill/api/v1/expenses/${EXPENSE_ID}/receipt`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const sent = (init.body as FormData).get('file') as File;
    expect(sent.name).toBe('taxi.pdf');
    // The browser must set the multipart boundary itself.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('says Replace receipt when one is already attached', () => {
    wrap(<ReceiptUploadButton expenseId={EXPENSE_ID} hasReceipt />);
    expect(screen.getByRole('button', { name: /replace receipt/i })).toBeInTheDocument();
  });

  it('refuses an unsupported file type without calling the API', async () => {
    wrap(<ReceiptUploadButton expenseId={EXPENSE_ID} />);
    const exe = new File(['MZ'], 'notes.exe', { type: 'application/octet-stream' });
    fireEvent.change(screen.getByTestId(`receipt-input-${EXPENSE_ID}`), { target: { files: [exe] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/photo .* or a PDF/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the API's message when the upload is refused", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(503, { error: { code: 'STORAGE_NOT_CONFIGURED', message: 'File storage is not configured on this server.' } }),
    );
    wrap(<ReceiptUploadButton expenseId={EXPENSE_ID} />);
    fireEvent.change(screen.getByTestId(`receipt-input-${EXPENSE_ID}`), { target: { files: [pdf()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('File storage is not configured on this server.');
  });
});

describe('receiptFileProblem', () => {
  it('accepts the API types and rejects files over 10 MB', () => {
    expect(receiptFileProblem(pdf())).toBeNull();
    expect(receiptFileProblem(new File(['x'], 'IMG_1.HEIC'))).toBeNull();
    const big = new File(['x'], 'big.png');
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    expect(receiptFileProblem(big)).toMatch(/10 MB/);
  });
});

describe('New Expense form', () => {
  it('creates the expense, then uploads the receipt to it, then navigates', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: EXPENSE_ID } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { receipt_url: 'x', receipt_filename: 'taxi.pdf', receipt_size_bytes: 8 } }));
    const onNavigate = vi.fn();
    wrap(<ExpenseNewPage onNavigate={onNavigate} />);

    fireEvent.change(screen.getByPlaceholderText(/what was this expense for/i), { target: { value: 'Taxi to client' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2500' } });
    fireEvent.change(screen.getByLabelText(/receipt \(optional\)/i), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole('button', { name: /submit expense/i }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/expenses'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).pathname).toBe('/bill/api/v1/expenses');
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(new URL(uploadUrl).pathname).toBe(`/bill/api/v1/expenses/${EXPENSE_ID}/receipt`);
    expect(uploadInit.body).toBeInstanceOf(FormData);
  });

  it('keeps the user on the form with a plain message when the receipt upload fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { data: { id: EXPENSE_ID } }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'File exceeds maximum size of 10 MB' } }));
    const onNavigate = vi.fn();
    wrap(<ExpenseNewPage onNavigate={onNavigate} />);
    fireEvent.change(screen.getByPlaceholderText(/what was this expense for/i), { target: { value: 'Taxi' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText(/receipt \(optional\)/i), { target: { files: [pdf()] } });
    fireEvent.click(screen.getByRole('button', { name: /submit expense/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/expense was saved, but the receipt was not/i);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('submits without a receipt exactly as before', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { data: { id: EXPENSE_ID } }));
    const onNavigate = vi.fn();
    wrap(<ExpenseNewPage onNavigate={onNavigate} />);
    fireEvent.change(screen.getByPlaceholderText(/what was this expense for/i), { target: { value: 'Lunch' } });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '900' } });
    fireEvent.click(screen.getByRole('button', { name: /submit expense/i }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/expenses'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
