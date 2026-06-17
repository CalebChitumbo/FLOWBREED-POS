/**
 * PrinterService: composes nothing (receipts are pre-composed) — it dispatches a
 * ReceiptData to the active transport and kicks the drawer for cash. Holds the
 * last printed receipt for "reprint most recent" (FS reprint). Kept out of the
 * shared service container so tests never import Electron.
 */
import type { ReceiptData } from '@shared/types/receipt';
import type { PrinterTransport } from './transport';

export class PrinterService {
  private last: ReceiptData | null = null;

  constructor(private readonly transport: PrinterTransport) {}

  async printReceipt(receipt: ReceiptData, opts: { kickDrawer?: boolean } = {}): Promise<void> {
    this.last = receipt;
    await this.transport.print(receipt);
    if (opts.kickDrawer) await this.transport.openCashDrawer();
  }

  getLast(): ReceiptData | null {
    return this.last;
  }
}

let printer: PrinterService | null = null;

export function setPrinter(instance: PrinterService): void {
  printer = instance;
}

export function getPrinter(): PrinterService {
  if (!printer) throw new Error('Printer not initialised');
  return printer;
}
