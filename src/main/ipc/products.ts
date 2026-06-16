/** Product-management IPC handlers (M2). search/findByBarcode: any authenticated
 *  user (checkout); create/update/barcodes/history: manager or administrator. */
import { z } from 'zod';
import { registerHandler } from './registry';
import { getServices } from '../services';
import { authorize } from '../security/authorize';
import { Errors } from '../errors';

const tokenStr = z.string().min(1);

const barcodeInput = z.object({
  barcode: z.string().min(1).max(64),
  packLabel: z.string().max(64).nullish(),
});

const productInput = z.object({
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(60),
  unitPrice: z.number().int().min(0),
  unitOfMeasure: z.string().min(1).max(20),
  isWeightBased: z.boolean().optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  barcodes: z.array(barcodeInput).optional(),
});

const productPatch = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(60).optional(),
  unitPrice: z.number().int().min(0).optional(),
  unitOfMeasure: z.string().min(1).max(20).optional(),
  isWeightBased: z.boolean().optional(),
  lowStockThreshold: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

export function registerProductHandlers(): void {
  registerHandler('product:search', (req) => {
    const { token, query } = z.object({ token: tokenStr, query: z.string() }).parse(req);
    authorize(getServices().sessions, token);
    return getServices().products.search(query);
  });

  registerHandler('product:findByBarcode', (req) => {
    const { token, barcode } = z.object({ token: tokenStr, barcode: z.string().min(1) }).parse(req);
    authorize(getServices().sessions, token);
    return getServices().products.findByBarcode(barcode);
  });

  registerHandler('product:list', (req) => {
    const { token, includeInactive } = z
      .object({ token: tokenStr, includeInactive: z.boolean().optional() })
      .parse(req);
    authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().products.list(includeInactive ?? false);
  });

  registerHandler('product:get', (req) => {
    const { token, id } = z.object({ token: tokenStr, id: z.string().min(1) }).parse(req);
    authorize(getServices().sessions, token, 'manager', 'administrator');
    const product = getServices().products.get(id);
    if (!product) throw Errors.notFound('product');
    return product;
  });

  registerHandler('product:create', (req) => {
    const { token, input } = z.object({ token: tokenStr, input: productInput }).parse(req);
    const session = authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().products.create(input, session.userId);
  });

  registerHandler('product:update', (req) => {
    const { token, id, patch } = z
      .object({ token: tokenStr, id: z.string().min(1), patch: productPatch })
      .parse(req);
    const session = authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().products.update(id, patch, session.userId);
  });

  registerHandler('product:addBarcode', (req) => {
    const { token, productId, barcode, packLabel } = z
      .object({
        token: tokenStr,
        productId: z.string().min(1),
        barcode: z.string().min(1).max(64),
        packLabel: z.string().max(64).nullish(),
      })
      .parse(req);
    const session = authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().products.addBarcode(productId, { barcode, packLabel }, session.userId);
  });

  registerHandler('product:removeBarcode', (req) => {
    const { token, barcodeId } = z.object({ token: tokenStr, barcodeId: z.string().min(1) }).parse(req);
    const session = authorize(getServices().sessions, token, 'manager', 'administrator');
    getServices().products.removeBarcode(barcodeId, session.userId);
    return { ok: true as const };
  });

  registerHandler('product:priceHistory', (req) => {
    const { token, productId } = z.object({ token: tokenStr, productId: z.string().min(1) }).parse(req);
    authorize(getServices().sessions, token, 'manager', 'administrator');
    return getServices().products.priceHistory(productId);
  });
}
