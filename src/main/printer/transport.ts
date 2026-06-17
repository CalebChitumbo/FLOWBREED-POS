import type { ReceiptData } from '@shared/types/receipt';

/**
 * Abstracts the physical printer so the same PrinterService runs on Linux (file
 * preview, M3) and Windows (ESC/POS via node-thermal-printer, wired in M8/M10).
 */
export interface PrinterTransport {
  print(receipt: ReceiptData): Promise<void>;
  openCashDrawer(): Promise<void>;
}
