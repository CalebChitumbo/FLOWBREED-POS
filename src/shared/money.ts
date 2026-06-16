/**
 * Money helpers. All amounts are INTEGER minor units (ngwee). Convert at the UI
 * edge only; never do arithmetic in floating-point major units.
 */
import { CURRENCY } from './constants';

/** Major units (Kwacha) -> minor units (ngwee), rounded to the nearest ngwee. */
export function toMinor(major: number): number {
  return Math.round(major * CURRENCY.minorPerMajor);
}

/** Minor units (ngwee) -> major units (Kwacha) as a number. */
export function toMajor(minor: number): number {
  return minor / CURRENCY.minorPerMajor;
}

/** Format minor units for display, e.g. 850000 -> "K8,500.00". */
export function formatMoney(minor: number): string {
  const major = toMajor(minor);
  return `${CURRENCY.symbol}${major.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
