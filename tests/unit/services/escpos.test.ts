import { describe, it, expect } from 'vitest';
import { receiptToEscPos, DRAWER_KICK } from '../../../src/main/printer/escpos';

describe('ESC/POS composition', () => {
  it('wraps the receipt text in init, feed and cut codes', () => {
    const text = 'HELLO\nTOTAL K10.00';
    const job = receiptToEscPos(text);
    // Initialise first (ESC @)
    expect(job[0]).toBe(0x1b);
    expect(job[1]).toBe(0x40);
    // The text is embedded verbatim
    expect(job.toString('latin1')).toContain(text);
    // Ends with a partial cut (GS V 66 0)
    expect([...job.subarray(job.length - 4)]).toEqual([0x1d, 0x56, 0x42, 0x00]);
    // With blank feed lines before the cut so text clears the tear bar
    expect(job.toString('latin1')).toContain('\n\n\n\n');
  });

  it('defines the drawer kick as ESC p on pin 0', () => {
    expect([...DRAWER_KICK.subarray(0, 3)]).toEqual([0x1b, 0x70, 0x00]);
    expect(DRAWER_KICK.length).toBe(5);
  });
});
