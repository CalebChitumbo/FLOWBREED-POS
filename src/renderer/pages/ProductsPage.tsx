import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { Product, PriceHistoryEntry } from '@shared/types/domain';
import type { CataloguePlanSummary, CatalogueImportSummary } from '@shared/ipc/contract';
import { PRODUCT_CATEGORIES, UNITS_OF_MEASURE } from '@shared/constants';
import { formatMoney, toMajor, toMinor } from '@shared/money';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

/** The built-in categories, plus any the catalogue or the user has introduced.
 *  A Mantine Select renders blank when its value is missing from `data`, and the
 *  imported HQ catalogue uses the business's own 17 categories. */
function categoryOptions(products: Product[]): { value: string; label: string }[] {
  const all = new Set<string>(PRODUCT_CATEGORIES);
  for (const p of products) if (p.category) all.add(p.category);
  return [...all].sort((a, b) => a.localeCompare(b)).map((c) => ({ value: c, label: c }));
}
const UNIT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({ value: u, label: u }));

export function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [formOpen, formCtl] = useDisclosure(false);
  const [barcodesFor, setBarcodesFor] = useState<Product | null>(null);
  const [historyFor, setHistoryFor] = useState<Product | null>(null);
  const [importOpen, importCtl] = useDisclosure(false);

  const load = useCallback(async () => {
    try {
      setProducts(await invoke('product:list', { token: requireToken(), includeInactive: true }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }, [products, filter]);

  function openCreate() {
    setEditing(null);
    formCtl.open();
  }
  function openEdit(p: Product) {
    setEditing(p);
    formCtl.open();
  }

  async function reloadProduct(id: string): Promise<Product | undefined> {
    const fresh = await invoke('product:get', { token: requireToken(), id });
    await load();
    return fresh;
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Products</Title>
        <Group>
          <TextInput
            placeholder="Filter by name or category"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            w={260}
          />
          <Button variant="default" onClick={importCtl.open}>
            Import HQ catalogue
          </Button>
          <Button onClick={openCreate}>Add product</Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Category</Table.Th>
            <Table.Th ta="right">Price</Table.Th>
            <Table.Th>Unit</Table.Th>
            <Table.Th>Barcodes</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {visible.map((p) => (
            <Table.Tr key={p.id}>
              <Table.Td fw={500}>
                {p.name}
                {p.isWeightBased && (
                  <Badge ml="xs" size="xs" variant="light" color="grape">
                    /kg
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>{p.category}</Table.Td>
              <Table.Td ta="right">{formatMoney(p.unitPrice)}</Table.Td>
              <Table.Td>{p.unitOfMeasure}</Table.Td>
              <Table.Td>
                <Button variant="subtle" size="compact-sm" onClick={() => setBarcodesFor(p)}>
                  {p.barcodes?.length ?? 0} codes
                </Button>
              </Table.Td>
              <Table.Td>
                <Badge color={p.active ? 'green' : 'gray'} variant="light">
                  {p.active ? 'Active' : 'Inactive'}
                </Badge>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Button size="compact-sm" variant="light" onClick={() => openEdit(p)}>
                    Edit
                  </Button>
                  <Button size="compact-sm" variant="subtle" onClick={() => setHistoryFor(p)}>
                    Price history
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <CatalogueImportModal
        opened={importOpen}
        onClose={importCtl.close}
        onImported={() => void load()}
      />
      <ProductFormModal
        opened={formOpen}
        product={editing}
        categories={categoryOptions(products)}
        onClose={formCtl.close}
        onSaved={() => {
          formCtl.close();
          void load();
        }}
      />
      <BarcodesModal
        product={barcodesFor}
        onClose={() => setBarcodesFor(null)}
        onChanged={async (id) => {
          const fresh = await reloadProduct(id);
          if (fresh) setBarcodesFor(fresh);
        }}
      />
      <PriceHistoryModal product={historyFor} onClose={() => setHistoryFor(null)} />
    </Stack>
  );
}

function ProductFormModal({
  opened,
  product,
  categories,
  onClose,
  onSaved,
}: {
  opened: boolean;
  product: Product | null;
  categories: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!product;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>(PRODUCT_CATEGORIES[0]);
  const [price, setPrice] = useState<number>(0); // major units (Kwacha)
  const [unit, setUnit] = useState<string>('each');
  const [weightBased, setWeightBased] = useState(false);
  const [lowStock, setLowStock] = useState<number>(0);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setError(null);
    setName(product?.name ?? '');
    setCategory(product?.category ?? PRODUCT_CATEGORIES[0]);
    setPrice(product ? toMajor(product.unitPrice) : 0);
    setUnit(product?.unitOfMeasure ?? 'each');
    setWeightBased(product?.isWeightBased ?? false);
    setLowStock(product?.lowStockThreshold ?? 0);
    setActive(product?.active ?? true);
  }, [opened, product]);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      if (isEdit && product) {
        await invoke('product:update', {
          token: requireToken(),
          id: product.id,
          patch: {
            name,
            category,
            unitPrice: toMinor(price),
            unitOfMeasure: unit,
            isWeightBased: weightBased,
            lowStockThreshold: Math.round(lowStock),
            active,
          },
        });
      } else {
        await invoke('product:create', {
          token: requireToken(),
          input: {
            name,
            category,
            unitPrice: toMinor(price),
            unitOfMeasure: unit,
            isWeightBased: weightBased,
            lowStockThreshold: Math.round(lowStock),
          },
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={isEdit ? 'Edit product' : 'Add product'} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <Select
          label="Category"
          data={categories}
          value={category}
          searchable
          onChange={(v) => v && setCategory(v)}
        />
        <Group grow>
          <NumberInput
            label={weightBased ? 'Price per kg' : 'Unit price'}
            prefix="K "
            decimalScale={2}
            fixedDecimalScale
            min={0}
            value={price}
            onChange={(v) => setPrice(typeof v === 'number' ? v : Number(v) || 0)}
          />
          <Select label="Unit of measure" data={UNIT_OPTIONS} value={unit} onChange={(v) => v && setUnit(v)} />
        </Group>
        <Group grow>
          <NumberInput
            label="Low-stock alert at"
            min={0}
            value={lowStock}
            onChange={(v) => setLowStock(typeof v === 'number' ? v : Number(v) || 0)}
          />
          <Switch
            label="Sold by weight"
            checked={weightBased}
            onChange={(e) => setWeightBased(e.currentTarget.checked)}
            mt="lg"
          />
        </Group>
        {isEdit && (
          <Switch label="Active" checked={active} onChange={(e) => setActive(e.currentTarget.checked)} />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            {isEdit ? 'Save' : 'Create'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function BarcodesModal({
  product,
  onClose,
  onChanged,
}: {
  product: Product | null;
  onClose: () => void;
  onChanged: (productId: string) => void | Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [packLabel, setPackLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!product) return;
    setError(null);
    try {
      await invoke('product:addBarcode', {
        token: requireToken(),
        productId: product.id,
        barcode: code,
        packLabel: packLabel || null,
      });
      setCode('');
      setPackLabel('');
      await onChanged(product.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(barcodeId: string) {
    if (!product) return;
    setError(null);
    try {
      await invoke('product:removeBarcode', { token: requireToken(), barcodeId });
      await onChanged(product.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal opened={!!product} onClose={onClose} title={`Barcodes — ${product?.name ?? ''}`} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        {(product?.barcodes ?? []).map((b) => (
          <Group key={b.id} justify="space-between">
            <Text>
              {b.barcode}{' '}
              {b.packLabel && (
                <Badge size="sm" variant="light">
                  {b.packLabel}
                </Badge>
              )}
            </Text>
            <Button size="compact-sm" color="red" variant="subtle" onClick={() => remove(b.id)}>
              Remove
            </Button>
          </Group>
        ))}
        {(product?.barcodes ?? []).length === 0 && <Text c="dimmed">No barcodes yet.</Text>}
        <Group align="flex-end">
          <TextInput
            label="New barcode"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <TextInput
            label="Pack label"
            placeholder="e.g. 6-pack"
            value={packLabel}
            onChange={(e) => setPackLabel(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button onClick={add} disabled={!code.trim()}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PriceHistoryModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const [entries, setEntries] = useState<PriceHistoryEntry[]>([]);
  useEffect(() => {
    if (!product) return;
    void invoke('product:priceHistory', { token: requireToken(), productId: product.id }).then(setEntries);
  }, [product]);

  return (
    <Modal opened={!!product} onClose={onClose} title={`Price history — ${product?.name ?? ''}`} centered>
      {entries.length === 0 ? (
        <Text c="dimmed">No price changes recorded.</Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Old</Table.Th>
              <Table.Th>New</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {entries.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td>{new Date(e.datetime).toLocaleString()}</Table.Td>
                <Table.Td>{formatMoney(e.oldPrice)}</Table.Td>
                <Table.Td>{formatMoney(e.newPrice)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  );
}

/**
 * Brings in the HQ opening catalogue carried over from the previous POS. Shows
 * what the import would do before it does anything, so a manager can decline.
 * Running it again is safe — products already here are left alone.
 */
function CatalogueImportModal({
  opened,
  onClose,
  onImported,
}: {
  opened: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [plan, setPlan] = useState<CataloguePlanSummary | null>(null);
  const [result, setResult] = useState<CatalogueImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setError(null);
    setResult(null);
    setPlan(null);
    invoke('catalogue:plan', { token: requireToken() })
      .then(setPlan)
      .catch((err: Error) => setError(err.message));
  }, [opened]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const summary = await invoke('catalogue:import', { token: requireToken() });
      setResult(summary);
      onImported();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pending = (plan?.toCreate ?? 0) + (plan?.toAddBarcodes ?? 0);

  return (
    <Modal opened={opened} onClose={onClose} title="Import HQ catalogue" size="lg">
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        {!plan && !error && <Text size="sm">Checking what needs importing…</Text>}

        {plan && (
          <>
            <Text size="sm" c="dimmed">
              {plan.source} — {plan.total} products. Each keeps the code it already
              had, so the labels on your shelves still scan. Stock is not imported:
              opening quantities come from a stock count.
            </Text>

            <Group>
              <Badge color="green" size="lg" variant="light">
                {plan.toCreate} to add
              </Badge>
              <Badge color="blue" size="lg" variant="light">
                {plan.toAddBarcodes} getting a barcode
              </Badge>
              <Badge color="gray" size="lg" variant="light">
                {plan.unchanged} already here
              </Badge>
            </Group>

            {plan.withoutBarcode.length > 0 && (
              <Alert color="yellow" variant="light" title="Products arriving without a barcode">
                <Text size="sm">
                  {plan.withoutBarcode.join(', ')} — the old system gave these no code of
                  their own. They import and can be sold by search; scan a barcode onto
                  each from the Barcodes button when you have one.
                </Text>
              </Alert>
            )}

            {plan.conflicts.length > 0 && (
              <Alert color="orange" variant="light" title="Barcodes already in use">
                <Text size="sm">
                  {plan.conflicts
                    .map((c) => `${c.barcode} is already on "${c.heldBy}"`)
                    .join('; ')}
                  . These are left as they are.
                </Text>
              </Alert>
            )}

            {result ? (
              <Alert color="green" variant="light" title="Import finished">
                <Text size="sm">
                  {result.created} product(s) added, {result.barcodesAdded} barcode(s)
                  attached, {result.unchanged} already in place.
                  {result.failed.length > 0 &&
                    ` ${result.failed.length} could not be imported: ${result.failed
                      .map((f) => `${f.name} (${f.reason})`)
                      .join('; ')}`}
                </Text>
              </Alert>
            ) : (
              <Group justify="flex-end">
                <Button variant="default" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={run} loading={busy} disabled={pending === 0}>
                  {pending === 0 ? 'Nothing left to import' : `Import ${pending} product(s)`}
                </Button>
              </Group>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
