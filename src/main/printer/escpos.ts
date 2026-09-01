/**
 * Pure ESC/POS byte composition for the receipt printer (Epson TM-T88 family
 * and compatibles). No I/O, no Electron — unit-tested. The receipt text is
 * already rendered monospaced by composeReceipt; this wraps it in the control
 * codes the printer needs: initialise, print, feed clear of the tear bar, cut.
 */

const ESC = 0x1b;
const GS = 0x1d;

/** Initialise the printer (clears any stale state from a previous job). */
const INIT = Buffer.from([ESC, 0x40]); // ESC @

/** Feed a few lines so the printed text clears the tear bar before cutting. */
const FEED = Buffer.from('\n\n\n\n', 'latin1');

/** Partial cut, leaving a hinge so the receipt does not drop (GS V 66 0). */
const CUT = Buffer.from([GS, 0x56, 0x42, 0x00]);

/** Kick drawer 1 via the RJ-12 port: ESC p 0, 50ms on, 500ms off. */
export const DRAWER_KICK = Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]);

/**
 * A full print job for one receipt. Text is encoded latin1 (the printer's
 * default PC437-compatible page covers the ASCII the composer emits).
 */
export function receiptToEscPos(text: string): Buffer {
  return Buffer.concat([INIT, Buffer.from(text, 'latin1'), FEED, CUT]);
}
