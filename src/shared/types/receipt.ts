import type { PaymentMethod } from '../constants';

export interface ReceiptLine {
  name: string;
  quantity: number;
  unitPrice: number; // minor units
  lineTotal: number; // minor units
  isWeightBased: boolean;
}

/** Everything needed to render/print a receipt (FS-08 layout). */
export interface ReceiptData {
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
  /** Monospaced plain-text rendering (used by the thermal printer + preview). */
  text: string;
}
