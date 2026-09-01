import type { ReceiptData } from '@shared/types/receipt';

/**
 * Abstracts the physical printer so the same PrinterService runs on Linux (file
 * preview, M3) and Windows (raw ESC/POS via the print spooler — see
 * windows-raw-transport.ts).
 */
export interface PrinterTransport {
  print(receipt: ReceiptData): Promise<void>;
  openCashDrawer(): Promise<void>;
}
