/**
 * Pure receipt composer. Builds the structured ReceiptData plus a monospaced
 * text rendering for a 40-column thermal printer. No I/O — unit-testable.
 */
import { formatMoney } from '@shared/money';
import type { PaymentMethod } from '@shared/constants';
import type { ReceiptData, ReceiptLine } from '@shared/types/receipt';

const WIDTH = 40;

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  mobile_mtn: 'MTN Mobile Money',
  mobile_airtel: 'Airtel Money',
  card: 'Card',
};

function centre(text: string): string {
  if (text.length >= WIDTH) return text.slice(0, WIDTH);
  const pad = Math.floor((WIDTH - text.length) / 2);
  return ' '.repeat(pad) + text;
}

function row(left: string, right: string): string {
  const space = Math.max(1, WIDTH - left.length - right.length);
  return left + ' '.repeat(space) + right;
}

function divider(char = '-'): string {
  return char.repeat(WIDTH);
}

export interface ComposeReceiptArgs {
  businessName: string;
  address: string | null;
  contact: string | null;
  branchName: string;
  reference: string;
  datetime: string;
  cashier: string;
  type: 'sale' | 'refund';
  lines: ReceiptLine[];
  subtotal: number;
  discountTotal: number;
  grandTotal: number;
  paymentMethod: PaymentMethod;
  tendered: number | null;
  changeDue: number | null;
}

export function composeReceipt(args: ComposeReceiptArgs): ReceiptData {
  const out: string[] = [];
  out.push(centre(args.businessName));
  if (args.address) out.push(centre(args.address));
  if (args.contact) out.push(centre(args.contact));
  out.push(centre(args.branchName));
  out.push(divider('='));
  if (args.type === 'refund') {
    out.push(centre('** REFUND **'));
  }
  out.push(row('Receipt:', args.reference));
  out.push(row('Date:', new Date(args.datetime).toLocaleString()));
  out.push(row('Cashier:', args.cashier));
  out.push(divider());

  for (const line of args.lines) {
    const qty = line.isWeightBased ? `${line.quantity.toFixed(3)}kg` : `x${line.quantity}`;
    out.push(line.name.slice(0, WIDTH));
    out.push(row(`  ${qty} @ ${formatMoney(line.unitPrice)}`, formatMoney(line.lineTotal)));
  }

  out.push(divider());
  out.push(row('Subtotal', formatMoney(args.subtotal)));
  if (args.discountTotal > 0) out.push(row('Discount', `-${formatMoney(args.discountTotal)}`));
  out.push(row('TOTAL', formatMoney(args.grandTotal)));
  out.push(row('Payment', PAYMENT_LABELS[args.paymentMethod]));
  if (args.tendered !== null) out.push(row('Tendered', formatMoney(args.tendered)));
  if (args.changeDue !== null) out.push(row('Change', formatMoney(args.changeDue)));
  out.push(divider('='));
  out.push(centre('Thank you!'));

  return { ...args, text: out.join('\n') };
}
