/**
 * Windows printer transport: sends raw ESC/POS bytes to a named Windows
 * printer through the print spooler (winspool WritePrinter, invoked via a
 * small PowerShell helper). Chosen deliberately over printer libraries with
 * native Node bindings — this path needs nothing but the printer's own Windows
 * driver, works on Windows 7 SP1 (PowerShell 2 + .NET), and is identical on
 * 32-bit and 64-bit machines.
 *
 * The printer name is read from Settings at every print, so changing it in
 * the Settings screen takes effect immediately, no restart.
 */
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { app } from 'electron';
import type { ReceiptData } from '@shared/types/receipt';
import type { PrinterTransport } from './transport';
import { receiptToEscPos, DRAWER_KICK } from './escpos';
import { Errors } from '../errors';
import { log } from '../logger';

const PRINT_TIMEOUT_MS = 20_000;

/** Classic winspool RAW-print helper (the canonical Microsoft P/Invoke shape). */
const RAW_PRINT_PS1 = `param([string]$PrinterName,[string]$Path)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if(!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed (is the printer name exactly right?), code " + Marshal.GetLastWin32Error());
    try {
      DOCINFOA di = new DOCINFOA();
      di.pDocName = "Flowbreeds POS receipt";
      di.pDataType = "RAW";
      if(!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter failed, code " + Marshal.GetLastWin32Error());
      StartPagePrinter(h);
      IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
      Marshal.Copy(bytes, 0, p, bytes.Length);
      int written;
      bool ok = WritePrinter(h, p, bytes.Length, out written);
      Marshal.FreeCoTaskMem(p);
      EndPagePrinter(h);
      EndDocPrinter(h);
      if(!ok) throw new Exception("WritePrinter failed, code " + Marshal.GetLastWin32Error());
    } finally { ClosePrinter(h); }
  }
}
"@
[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($Path))
`;

export class WindowsRawPrinterTransport implements PrinterTransport {
  private scriptReady = false;

  constructor(private readonly getPrinterName: () => string | null) {}

  private dir(): string {
    return join(app.getPath('userData'), 'printer');
  }

  private scriptPath(): string {
    return join(this.dir(), 'raw-print.ps1');
  }

  private async ensureScript(): Promise<void> {
    if (this.scriptReady) return;
    await mkdir(this.dir(), { recursive: true });
    await writeFile(this.scriptPath(), RAW_PRINT_PS1, 'utf8');
    this.scriptReady = true;
  }

  private requirePrinterName(): string {
    const name = this.getPrinterName()?.trim();
    if (!name) {
      throw Errors.validation(
        'No receipt printer is set. In Settings → Hardware, type the printer name exactly as it appears in Windows "Devices and Printers".',
      );
    }
    return name;
  }

  private async sendRaw(bytes: Buffer, jobLabel: string): Promise<void> {
    const printerName = this.requirePrinterName();
    await this.ensureScript();
    const payloadPath = join(this.dir(), `job-${Date.now()}.bin`);
    await writeFile(payloadPath, bytes);
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            this.scriptPath(),
            '-PrinterName',
            printerName,
            '-Path',
            payloadPath,
          ],
          { timeout: PRINT_TIMEOUT_MS, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) {
              const detail = (stderr || err.message).split('\n')[0]?.trim();
              log.error(`[printer] ${jobLabel} failed on "${printerName}": ${stderr || err.message}`);
              reject(
                Errors.validation(
                  `Could not print to "${printerName}". Check the printer is on, has paper (Paper light off), and the name matches Windows exactly. (${detail})`,
                ),
              );
            } else {
              log.info(`[printer] ${jobLabel} sent to "${printerName}" (${bytes.length} bytes)`);
              resolve();
            }
          },
        );
      });
    } finally {
      await unlink(payloadPath).catch(() => undefined);
    }
  }

  async print(receipt: ReceiptData): Promise<void> {
    await this.sendRaw(receiptToEscPos(receipt.text), `receipt ${receipt.reference}`);
  }

  async openCashDrawer(): Promise<void> {
    await this.sendRaw(DRAWER_KICK, 'cash-drawer kick');
  }
}
