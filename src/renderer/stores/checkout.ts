import { create } from 'zustand';
import type { Product } from '@shared/types/domain';

export interface CartLine {
  product: Product;
  quantity: number;
}

export interface HeldCart {
  id: string;
  lines: CartLine[];
  at: string;
}

interface CheckoutState {
  lines: CartLine[];
  held: HeldCart[];
  discount: number; // transaction-level, minor units
  authorisedBy: string | null;
  addLine: (product: Product, quantity: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  removeLine: (productId: string) => void;
  setDiscount: (amount: number, authorisedBy: string | null) => void;
  clear: () => void;
  hold: () => void;
  resume: (id: string) => void;
  subtotal: () => number;
  grandTotal: () => number;
}

const lineTotal = (l: CartLine): number => Math.round(l.quantity * l.product.unitPrice);

export const useCheckoutStore = create<CheckoutState>((set, get) => ({
  lines: [],
  held: [],
  discount: 0,
  authorisedBy: null,

  addLine(product, quantity) {
    set((state) => {
      // Non-weight items merge by product; weight items get their own line.
      if (!product.isWeightBased) {
        const existing = state.lines.find((l) => l.product.id === product.id);
        if (existing) {
          return {
            lines: state.lines.map((l) =>
              l.product.id === product.id ? { ...l, quantity: l.quantity + quantity } : l,
            ),
          };
        }
      }
      return { lines: [...state.lines, { product, quantity }] };
    });
  },

  setQuantity(productId, quantity) {
    set((state) => ({
      lines: state.lines.map((l) => (l.product.id === productId ? { ...l, quantity } : l)),
    }));
  },

  removeLine(productId) {
    set((state) => ({ lines: state.lines.filter((l) => l.product.id !== productId) }));
  },

  setDiscount(amount, authorisedBy) {
    set({ discount: Math.max(0, Math.round(amount)), authorisedBy });
  },

  clear() {
    set({ lines: [], discount: 0, authorisedBy: null });
  },

  hold() {
    const { lines, held } = get();
    if (lines.length === 0) return;
    set({
      held: [...held, { id: crypto.randomUUID(), lines, at: new Date().toISOString() }],
      lines: [],
      discount: 0,
      authorisedBy: null,
    });
  },

  resume(id) {
    const { held, lines } = get();
    const target = held.find((h) => h.id === id);
    if (!target) return;
    // If there's an active cart, hold it first so nothing is lost.
    const remaining = held.filter((h) => h.id !== id);
    const nextHeld =
      lines.length > 0
        ? [...remaining, { id: crypto.randomUUID(), lines, at: new Date().toISOString() }]
        : remaining;
    set({ lines: target.lines, held: nextHeld, discount: 0, authorisedBy: null });
  },

  subtotal() {
    return get().lines.reduce((s, l) => s + lineTotal(l), 0);
  },

  grandTotal() {
    return Math.max(0, get().subtotal() - get().discount);
  },
}));

export { lineTotal };
