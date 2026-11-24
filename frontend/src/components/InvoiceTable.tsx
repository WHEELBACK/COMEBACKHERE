import React from 'react';

import { Invoice } from '../types';
import { formatAmount, formatDate } from '../utils/format';
import { InvoiceStatusBadge } from './InvoiceStatusBadge';

type InvoiceTableProps = {
  invoices: Invoice[];
  onSelect?: (invoice: Invoice) => void;
};

const cellBase = 'px-4 py-3 whitespace-nowrap align-middle';

const InvoiceTable: React.FC<InvoiceTableProps> = ({ invoices, onSelect }) => {
  return (
    <div className="w-full overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <table className="min-w-full table-auto border-collapse text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className={`${cellBase} min-w-[8rem]`} scope="col">
              Invoice
            </th>
            <th className={`${cellBase} min-w-[10rem]`} scope="col">
              Merchant
            </th>
            <th className={`${cellBase} min-w-[7rem]`} scope="col">
              Amount
            </th>
            <th className={`${cellBase} min-w-[9rem]`} scope="col">
              Status
            </th>
            <th className={`${cellBase} min-w-[8rem]`} scope="col">
              Created
            </th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr
              key={invoice.id}
              className="border-b border-gray-100 hover:bg-gray-50"
              onClick={onSelect ? () => onSelect(invoice) : undefined}
            >
              <td className={`${cellBase} min-w-[8rem] font-medium text-gray-900`}>
                {invoice.id}
              </td>
              <td className={`${cellBase} min-w-[10rem] text-gray-700`}>
                {invoice.merchantName}
              </td>
              <td className={`${cellBase} min-w-[7rem] tabular-nums text-gray-900`}>
                {formatAmount(invoice.amount, invoice.currency)}
              </td>
              <td className={`${cellBase} min-w-[9rem]`}>
                <div className="flex items-center">
                  <InvoiceStatusBadge status={invoice.status} />
                </div>
              </td>
              <td className={`${cellBase} min-w-[8rem] text-gray-700`}>
                {formatDate(invoice.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default InvoiceTable;
