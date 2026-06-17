/**
 * Dev/Linux printer transport: writes the composed receipt to a text file under
 * userData/receipts and logs a cash-drawer "kick". Verifies layout without
 * hardware. Swapped for an ESC/POS transport on Windows.
 */
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { app } from 'electron';
import type { ReceiptData } from '@shared/types/receipt';
import type { PrinterTransport } from './transport';
import { log } from '../logger';

export class FilePrinterTransport implements PrinterTransport {
  private dir(): string {
    return join(app.getPath('userData'), 'receipts');
  }

  async print(receipt: ReceiptData): Promise<void> {
    const dir = this.dir();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${receipt.reference}.txt`);
    await writeFile(file, receipt.text, 'utf8');
    log.info(`[printer] receipt written to ${file}`);
  }

  async openCashDrawer(): Promise<void> {
    log.info('[printer] cash drawer kick');
  }
}
