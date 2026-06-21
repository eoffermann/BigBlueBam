import { useState } from 'react';
import { FileText, Send, Ban, Copy, DollarSign, FileDown, UserCheck } from 'lucide-react';
import { useInvoice, useFinalizeInvoice, useSendInvoice, useVoidInvoice, useDuplicateInvoice, useRecordPayment } from '@/hooks/use-invoices';
import { useBamUsers, useRequestApproval } from '@/hooks/use-approvals';
import { formatDate, formatCents, statusBadgeClass, cn } from '@/lib/utils';
import { PresenceChipStrip } from '@bigbluebam/ui/presence-chip-strip';

function pdfHref(pdfUrl: string | null | undefined): string | null {
  if (!pdfUrl) return null;
  if (pdfUrl.startsWith('http://') || pdfUrl.startsWith('https://')) return pdfUrl;
  if (pdfUrl.startsWith('/')) return pdfUrl;
  return `/files/bigbluebam-uploads/${pdfUrl}`;
}

interface Props {
  invoiceId: string;
  onNavigate: (path: string) => void;
}

export function InvoiceDetailPage({ invoiceId, onNavigate }: Props) {
  const { data: invoice, isLoading } = useInvoice(invoiceId);
  const finalizeInvoice = useFinalizeInvoice();
  const sendInvoice = useSendInvoice();
  const voidInvoice = useVoidInvoice();
  const duplicateInvoice = useDuplicateInvoice();
  const recordPayment = useRecordPayment();

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer');

  const [showApprovalForm, setShowApprovalForm] = useState(false);
  const [approverId, setApproverId] = useState('');
  const [approvalNote, setApprovalNote] = useState('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalSent, setApprovalSent] = useState(false);
  const { data: bamUsers } = useBamUsers();
  const requestApproval = useRequestApproval();

  if (isLoading) return <div className="p-6 text-zinc-400">Loading...</div>;
  if (!invoice) return <div className="p-6 text-zinc-400">Invoice not found</div>;

  const handleRecordPayment = async () => {
    await recordPayment.mutateAsync({
      invoiceId: invoice.id,
      amount: paymentAmount,
      payment_method: paymentMethod,
    });
    setShowPaymentForm(false);
    setPaymentAmount(0);
  };

  const handleRequestApproval = async () => {
    if (!approverId) {
      setApprovalError('Pick an approver first.');
      return;
    }
    setApprovalError(null);
    try {
      await requestApproval.mutateAsync({
        approver_id: approverId,
        subject_type: 'bill.invoice',
        subject_id: invoice.id,
        body:
          approvalNote ||
          `Approval requested for invoice ${invoice.invoice_number} (${formatCents(invoice.total)}) to ${invoice.to_name}.`,
        url: `/bill/invoices/${invoice.id}`,
      });
      setApprovalSent(true);
      setShowApprovalForm(false);
      setApproverId('');
      setApprovalNote('');
      setTimeout(() => setApprovalSent(false), 4000);
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to send approval request');
    }
  };

  const pdf = pdfHref(invoice.pdf_url);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center h-12 w-12 rounded-xl bg-green-100 dark:bg-green-900/30 text-green-600">
            <FileText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
              {invoice.invoice_number}
            </h1>
            <p className="text-sm text-zinc-500">{invoice.to_name}</p>
          </div>
          <PresenceChipStrip
            url={`${window.location.origin}${window.location.pathname}`}
            surfaceApp="bill"
            surfaceId={invoice.id}
            surfaceLabel={invoice.invoice_number ?? invoice.id}
          />
          <span className={cn('px-3 py-1 rounded-full text-xs font-medium', statusBadgeClass(invoice.status))}>
            {invoice.status.replace('_', ' ')}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {invoice.status === 'draft' && (
            <>
              <button
                onClick={() => onNavigate(`/invoices/${invoice.id}/edit`)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
              >
                Edit
              </button>
              <button
                onClick={() => finalizeInvoice.mutate(invoiceId)}
                className="flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700"
              >
                <Send className="h-4 w-4" />
                Finalize
              </button>
            </>
          )}
          {(invoice.status === 'sent' || invoice.status === 'viewed') && (
            <button
              onClick={() => sendInvoice.mutate(invoiceId)}
              className="flex items-center gap-2 rounded-lg bg-blue-600 text-white px-4 py-2 text-sm font-medium hover:bg-blue-700"
            >
              <Send className="h-4 w-4" />
              Re-send
            </button>
          )}
          {invoice.status !== 'void' && invoice.status !== 'draft' && (
            <button
              onClick={() => voidInvoice.mutate(invoiceId)}
              className="flex items-center gap-2 rounded-lg border border-red-300 text-red-600 px-4 py-2 text-sm font-medium hover:bg-red-50"
            >
              <Ban className="h-4 w-4" />
              Void
            </button>
          )}
          <button
            onClick={async () => {
              const res = await duplicateInvoice.mutateAsync(invoiceId);
              onNavigate(`/invoices/${res.data.id}`);
            }}
            className="flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            <Copy className="h-4 w-4" />
            Duplicate
          </button>
          <button
            onClick={() => setShowApprovalForm((v) => !v)}
            className="flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
          >
            <UserCheck className="h-4 w-4" />
            Request approval
          </button>
          {pdf && (
            <a
              href={pdf}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800"
            >
              <FileDown className="h-4 w-4" />
              PDF
            </a>
          )}
        </div>
      </div>

      {approvalSent && (
        <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800 px-4 py-2 text-sm text-green-700 dark:text-green-300">
          Approval request sent.
        </div>
      )}

      {showApprovalForm && (
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 space-y-3 bg-zinc-50 dark:bg-zinc-800/30">
          <h3 className="text-sm font-semibold">Request approval</h3>
          <div>
            <label htmlFor="bill-detail-approver" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Approver
            </label>
            <select
              id="bill-detail-approver"
              value={approverId}
              onChange={(e) => setApproverId(e.target.value)}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            >
              <option value="">Select a user...</option>
              {(bamUsers?.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.display_name} ({u.email})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="bill-detail-note" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
              Message (optional)
            </label>
            <textarea
              id="bill-detail-note"
              value={approvalNote}
              onChange={(e) => setApprovalNote(e.target.value)}
              rows={2}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
            />
          </div>
          {approvalError && <p className="text-xs text-red-600">{approvalError}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowApprovalForm(false)}
              className="px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300"
            >
              Cancel
            </button>
            <button
              onClick={handleRequestApproval}
              disabled={requestApproval.isPending || !approverId}
              className="px-3 py-2 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {requestApproval.isPending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>
      )}

      {/* Invoice details grid */}
      <div className="grid grid-cols-2 gap-6">
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">From</h3>
          <p className="font-medium">{invoice.from_name || 'Not configured'}</p>
          <p className="text-sm text-zinc-500">{invoice.from_email}</p>
          <p className="text-sm text-zinc-500 whitespace-pre-line">{invoice.from_address}</p>
        </div>
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-500 uppercase tracking-wider">To</h3>
          <p className="font-medium">{invoice.to_name}</p>
          <p className="text-sm text-zinc-500">{invoice.to_email}</p>
          <p className="text-sm text-zinc-500 whitespace-pre-line">{invoice.to_address}</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Invoice Date</p>
          <p className="font-medium">{formatDate(invoice.invoice_date)}</p>
        </div>
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Due Date</p>
          <p className="font-medium">{formatDate(invoice.due_date)}</p>
        </div>
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Total</p>
          <p className="font-bold text-lg">{formatCents(invoice.total)}</p>
        </div>
        <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4">
          <p className="text-xs text-zinc-500 mb-1">Amount Due</p>
          <p className="font-bold text-lg text-green-600">{formatCents(invoice.total - invoice.amount_paid)}</p>
        </div>
      </div>

      {/* Line items */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Description</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Qty</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Unit Price</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.line_items?.map((li: any) => (
              <tr key={li.id} className="border-b border-zinc-100 dark:border-zinc-800">
                <td className="px-4 py-3">{li.description}</td>
                <td className="px-4 py-3 text-right">{li.quantity}</td>
                <td className="px-4 py-3 text-right">{formatCents(li.unit_price)}</td>
                <td className="px-4 py-3 text-right font-medium">{formatCents(li.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
              <td colSpan={3} className="text-right px-4 py-2 text-zinc-500">Subtotal</td>
              <td className="text-right px-4 py-2 font-medium">{formatCents(invoice.subtotal)}</td>
            </tr>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50">
              <td colSpan={3} className="text-right px-4 py-2 text-zinc-500">Tax ({invoice.tax_rate}%)</td>
              <td className="text-right px-4 py-2">{formatCents(invoice.tax_amount)}</td>
            </tr>
            {invoice.discount_amount > 0 && (
              <tr className="bg-zinc-50 dark:bg-zinc-800/50">
                <td colSpan={3} className="text-right px-4 py-2 text-zinc-500">Discount</td>
                <td className="text-right px-4 py-2 text-red-600">-{formatCents(invoice.discount_amount)}</td>
              </tr>
            )}
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 font-bold">
              <td colSpan={3} className="text-right px-4 py-3">Total</td>
              <td className="text-right px-4 py-3">{formatCents(invoice.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Payments */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Payments</h2>
          {invoice.status !== 'draft' && invoice.status !== 'void' && invoice.status !== 'paid' && (
            <button
              onClick={() => setShowPaymentForm(!showPaymentForm)}
              className="flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700"
            >
              <DollarSign className="h-4 w-4" />
              Record Payment
            </button>
          )}
        </div>

        {showPaymentForm && (
          <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Amount (cents)</label>
                <input
                  type="number"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(Number(e.target.value))}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">Method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
                >
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="check">Check</option>
                  <option value="cash">Cash</option>
                  <option value="stripe">Stripe</option>
                  <option value="paypal">PayPal</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <button
              onClick={handleRecordPayment}
              className="rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700"
            >
              Save Payment
            </button>
          </div>
        )}

        {invoice.payments?.length ? (
          <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b">
                  <th className="text-left px-4 py-2 text-zinc-500 font-medium">Date</th>
                  <th className="text-left px-4 py-2 text-zinc-500 font-medium">Method</th>
                  <th className="text-right px-4 py-2 text-zinc-500 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p: any) => (
                  <tr key={p.id} className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2">{formatDate(p.paid_at)}</td>
                    <td className="px-4 py-2 capitalize">{p.payment_method?.replace('_', ' ')}</td>
                    <td className="px-4 py-2 text-right font-medium text-green-600">{formatCents(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No payments recorded yet.</p>
        )}
      </div>

      {/* Inline PDF preview */}
      {pdf && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <FileDown className="h-4 w-4 text-zinc-400" />
            PDF preview
          </h2>
          <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden bg-zinc-50 dark:bg-zinc-900">
            <iframe
              title={`Invoice ${invoice.invoice_number} PDF`}
              src={pdf}
              className="w-full h-[720px] border-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
