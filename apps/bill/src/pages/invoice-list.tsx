import { useState } from 'react';
import { Plus, Filter, FileDown } from 'lucide-react';
import { useInvoices, useFinalizeInvoice } from '@/hooks/use-invoices';
import { useOverdue } from '@/hooks/use-reports';
import { useRequestApproval, useBamUsers } from '@/hooks/use-approvals';
import { formatDate, formatCents, statusBadgeClass, cn } from '@/lib/utils';

// Read an initial status filter from the URL (e.g. the dashboard Overdue tile
// deep-links to /bill/invoices?status=overdue).
function initialStatusFilter(): string {
  try {
    const s = new URLSearchParams(window.location.search).get('status');
    return s ?? '';
  } catch {
    return '';
  }
}

function pdfHref(pdfUrl: string | null | undefined): string | null {
  if (!pdfUrl) return null;
  // Backend stores either a relative MinIO key or a full URL. Translate
  // bare keys into the nginx-proxied /files/... path so the browser can
  // fetch them with the user's session cookies.
  if (pdfUrl.startsWith('http://') || pdfUrl.startsWith('https://')) return pdfUrl;
  if (pdfUrl.startsWith('/')) return pdfUrl;
  return `/files/bigbluebam-uploads/${pdfUrl}`;
}

interface Props {
  onNavigate: (path: string) => void;
}

export function InvoiceListPage({ onNavigate }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>(initialStatusFilter);
  const isOverdueFilter = statusFilter === 'overdue';
  // "overdue" is computed server-side (unpaid, finalized, past-due) rather than
  // a stored status — route it to the /reports/overdue set. Every other filter
  // is a real stored status and goes through the normal invoice list query.
  const invoiceQuery = useInvoices(
    statusFilter && !isOverdueFilter ? { status: statusFilter } : undefined,
  );
  const overdueQuery = useOverdue();
  const invoices = isOverdueFilter ? overdueQuery.data : invoiceQuery.data;
  const isLoading = isOverdueFilter ? overdueQuery.isLoading : invoiceQuery.isLoading;
  const finalizeInvoice = useFinalizeInvoice();
  const requestApproval = useRequestApproval();
  const { data: bamUsers } = useBamUsers();
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approverId, setApproverId] = useState<string>('');
  const [approvalNote, setApprovalNote] = useState<string>('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalSuccess, setApprovalSuccess] = useState<string | null>(null);

  const statuses = ['', 'draft', 'sent', 'viewed', 'paid', 'partially_paid', 'overdue', 'void'];

  const approvingInvoice = invoices?.find((inv: any) => inv.id === approvingId);

  const handleSubmitApproval = async () => {
    if (!approvingInvoice || !approverId) {
      setApprovalError('Pick an approver first.');
      return;
    }
    setApprovalError(null);
    try {
      await requestApproval.mutateAsync({
        approver_id: approverId,
        subject_type: 'bill.invoice',
        subject_id: approvingInvoice.id,
        body:
          approvalNote ||
          `Approval requested for invoice ${approvingInvoice.invoice_number} (${formatCents(approvingInvoice.total)}) to ${approvingInvoice.to_name}.`,
        url: `/bill/invoices/${approvingInvoice.id}`,
      });
      setApprovalSuccess(`Approval sent for ${approvingInvoice.invoice_number}.`);
      setApprovingId(null);
      setApproverId('');
      setApprovalNote('');
      setTimeout(() => setApprovalSuccess(null), 4000);
    } catch (e) {
      setApprovalError(e instanceof Error ? e.message : 'Failed to send approval request');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Invoices</h1>
          <p className="text-sm text-zinc-500 mt-1">Manage and track all your invoices</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate('/invoices/from-time')}
            className="flex items-center gap-2 rounded-lg border border-zinc-300 dark:border-zinc-600 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
          >
            From Time Entries
          </button>
          <button
            onClick={() => onNavigate('/invoices/new')}
            className="flex items-center gap-2 rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            New Invoice
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-zinc-400" />
          {statuses.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                statusFilter === s
                  ? 'bg-green-600 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700',
              )}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {approvalSuccess && (
        <div className="rounded-lg border border-green-300 bg-green-50 dark:bg-green-950/20 dark:border-green-800 px-4 py-2 text-sm text-green-700 dark:text-green-300">
          {approvalSuccess}
        </div>
      )}

      {/* Table */}
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-zinc-50 dark:bg-zinc-800/50 border-b border-zinc-200 dark:border-zinc-700">
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Number</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Client</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Date</th>
              <th className="text-left px-4 py-3 font-medium text-zinc-500">Due</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Total</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Due</th>
              <th className="text-center px-4 py-3 font-medium text-zinc-500">Status</th>
              <th className="text-right px-4 py-3 font-medium text-zinc-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-zinc-400">Loading invoices...</td>
              </tr>
            ) : !invoices?.length ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-zinc-400">No invoices yet. Create your first one.</td>
              </tr>
            ) : (
              invoices.map((inv: any) => {
                const pdf = pdfHref(inv.pdf_url);
                return (
                  <tr
                    key={inv.id}
                    className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
                  >
                    <td
                      className="px-4 py-3 font-mono text-xs cursor-pointer"
                      onClick={() => onNavigate(`/invoices/${inv.id}`)}
                    >
                      {inv.invoice_number}
                    </td>
                    <td
                      className="px-4 py-3 font-medium cursor-pointer"
                      onClick={() => onNavigate(`/invoices/${inv.id}`)}
                    >
                      {inv.to_name || '--'}
                    </td>
                    <td className="px-4 py-3 text-zinc-500">{formatDate(inv.invoice_date)}</td>
                    <td className="px-4 py-3 text-zinc-500">{formatDate(inv.due_date)}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCents(inv.total)}</td>
                    <td className="px-4 py-3 text-right font-medium">{formatCents(inv.total - inv.amount_paid)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', statusBadgeClass(inv.status))}>
                        {inv.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {pdf && (
                          <a
                            href={pdf}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <FileDown className="h-3 w-3" />
                            PDF
                          </a>
                        )}
                        {inv.status === 'draft' && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              finalizeInvoice.mutate(inv.id);
                            }}
                            disabled={finalizeInvoice.isPending}
                            className="px-2 py-1 rounded-md bg-green-600 text-white text-xs hover:bg-green-700 disabled:opacity-50"
                          >
                            Finalize
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setApprovingId(inv.id);
                            setApproverId('');
                            setApprovalNote('');
                            setApprovalError(null);
                          }}
                          className="px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        >
                          Request approval
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {approvingInvoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setApprovingId(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div>
              <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                Request approval for {approvingInvoice.invoice_number}
              </h3>
              <p className="text-xs text-zinc-500 mt-1">
                Sends a Banter DM to the approver via Bolt.
              </p>
            </div>
            <div>
              <label
                htmlFor="bill-approval-approver"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                Approver
              </label>
              <select
                id="bill-approval-approver"
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
              <label
                htmlFor="bill-approval-note"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1"
              >
                Message (optional)
              </label>
              <textarea
                id="bill-approval-note"
                value={approvalNote}
                onChange={(e) => setApprovalNote(e.target.value)}
                rows={3}
                placeholder={`Please review invoice ${approvingInvoice.invoice_number}.`}
                className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm"
              />
            </div>
            {approvalError && <p className="text-xs text-red-600">{approvalError}</p>}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setApprovingId(null)}
                className="px-3 py-2 text-sm font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitApproval}
                disabled={requestApproval.isPending || !approverId}
                className="px-3 py-2 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
              >
                {requestApproval.isPending ? 'Sending...' : 'Send request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
