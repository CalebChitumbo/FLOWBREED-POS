import type { StockMovementType } from '../constants';

export interface CategoryTotal {
  category: string;
  total: number; // minor units
}

export interface ProductSales {
  productId: string;
  name: string;
  quantity: number;
  total: number; // minor units
}

/** Daily / date-range sales report (FR-01, FR-02). All money in minor units. */
export interface SalesReport {
  start: string;
  end: string;
  totalRevenue: number; // net of refunds
  transactionCount: number;
  byCategory: CategoryTotal[];
  topProducts: ProductSales[];
}

export interface StockMovementView {
  id: string;
  productId: string;
  productName: string;
  type: StockMovementType;
  quantity: number;
  reason: string | null;
  userName: string;
  datetime: string;
}

export interface TransactionFilter {
  start?: string;
  end?: string;
  type?: 'sale' | 'refund';
  query?: string;
  limit?: number;
}
