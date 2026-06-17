import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { Product, TillSession, Transaction } from '@shared/types/domain';
import type { ReceiptData } from '@shared/types/receipt';
import type { PaymentMethod } from '@shared/constants';
import { formatMoney, toMajor, toMinor } from '@shared/money';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';
import { useCheckoutStore, lineTotal } from '../stores/checkout';
import { ManagerAuthModal } from '../components/ManagerAuthModal';

export function CheckoutPage() {
  const [session, setSession] = useState<TillSession | null | undefined>(undefined);

  const loadSession = useCallback(async () => {
    setSession(await invoke('session:current', { token: requireToken() }));
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  if (session === undefined) {
    return (
      <Center mih="60vh">
        <Text c="dimmed">Loading…</Text>
      </Center>
    );
  }
  if (session === null) return <SessionGate onOpened={loadSession} />;
  return <Register session={session} onClosed={() => setSession(null)} />;
}

function SessionGate({ onOpened }: { onOpened: () => void }) {
  const [float, setFloat] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setError(null);
    setBusy(true);
    try {
      await invoke('session:open', { token: requireToken(), openingFloat: toMinor(float) });
      onOpened();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Center mih="60vh">
      <Card withBorder shadow="sm" radius="md" p="xl" w={420}>
        <Stack>
          <Title order={3}>Start your shift</Title>
          <Text c="dimmed" size="sm">
            Enter the opening cash float to open your till session.
          </Text>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <NumberInput
            label="Opening float"
            prefix="K "
            decimalScale={2}
            min={0}
            value={float}
            onChange={(v) => setFloat(typeof v === 'number' ? v : Number(v) || 0)}
          />
          <Button onClick={open} loading={busy} size="md">
            Open till session
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}

function Register({ session, onClosed }: { session: TillSession; onClosed: () => void }) {
  const { lines, held, discount, authorisedBy, addLine, setQuantity, removeLine, setDiscount, clear, hold, resume } =
    useCheckoutStore();
  const subtotal = useCheckoutStore((s) => s.subtotal());
  const grandTotal = useCheckoutStore((s) => s.grandTotal());

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [weightProduct, setWeightProduct] = useState<Product | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [heldOpen, setHeldOpen] = useState(false);
  const [closeSummary, setCloseSummary] = useState<TillSession | null>(null);
  const [lastSale, setLastSale] = useState<{ transaction: Transaction; receipt: ReceiptData } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const focusSearch = () => searchRef.current?.focus();

  function addProduct(product: Product) {
    if (product.isWeightBased) {
      setWeightProduct(product);
    } else {
      addLine(product, 1);
      setQuery('');
      setResults([]);
      focusSearch();
    }
  }

  // Live search as the cashier types (manual lookup).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const found = await invoke('product:search', { token: requireToken(), query: q });
        if (!cancelled) setResults(found);
      } catch {
        /* ignore search errors */
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  // Enter = treat the field as a scanned barcode first (scanner sends value + CR).
  async function onSearchEnter() {
    const value = query.trim();
    if (!value) return;
    setError(null);
    try {
      const product = await invoke('product:findByBarcode', { token: requireToken(), barcode: value });
      if (product) {
        addProduct(product);
        return;
      }
      // Not a barcode: if exactly one search match, add it.
      if (results.length === 1) addProduct(results[0]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function closeSession() {
    try {
      const closed = await invoke('session:close', { token: requireToken() });
      setCloseSummary(closed);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Checkout</Title>
        <Group gap="xs">
          <Badge variant="light" color="teal">
            Float {formatMoney(session.openingFloat)}
          </Badge>
          <Button variant="subtle" onClick={() => setHeldOpen(true)}>
            Held ({held.length})
          </Button>
          <Button variant="light" color="orange" onClick={closeSession}>
            Close session
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Group align="flex-start" grow>
        <Stack style={{ flex: 2 }}>
          <TextInput
            ref={searchRef}
            size="md"
            placeholder="Scan a barcode or type a product name…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSearchEnter();
            }}
            autoFocus
          />
          {results.length > 0 && (
            <Paper withBorder p="xs" radius="md">
              <Stack gap={4}>
                {results.map((p) => (
                  <Group key={p.id} justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      {p.name}{' '}
                      <Text span c="dimmed" size="xs">
                        {p.category}
                      </Text>
                    </Text>
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm">{formatMoney(p.unitPrice)}</Text>
                      <Button size="compact-xs" onClick={() => addProduct(p)}>
                        Add
                      </Button>
                    </Group>
                  </Group>
                ))}
              </Stack>
            </Paper>
          )}

          <Table withTableBorder verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Item</Table.Th>
                <Table.Th w={120}>Qty</Table.Th>
                <Table.Th ta="right">Line</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lines.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed" ta="center" py="md">
                      No items yet — scan or search to begin.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {lines.map((l) => (
                <Table.Tr key={l.product.id}>
                  <Table.Td>
                    {l.product.name}
                    <Text span c="dimmed" size="xs">
                      {' '}
                      @ {formatMoney(l.product.unitPrice)}
                      {l.product.isWeightBased ? '/kg' : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      size="xs"
                      min={0}
                      step={l.product.isWeightBased ? 0.1 : 1}
                      decimalScale={l.product.isWeightBased ? 3 : 0}
                      value={l.quantity}
                      onChange={(v) => setQuantity(l.product.id, typeof v === 'number' ? v : Number(v) || 0)}
                    />
                  </Table.Td>
                  <Table.Td ta="right">{formatMoney(lineTotal(l))}</Table.Td>
                  <Table.Td>
                    <Button size="compact-xs" color="red" variant="subtle" onClick={() => removeLine(l.product.id)}>
                      Remove
                    </Button>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>

        <Card withBorder radius="md" p="lg" style={{ flex: 1, alignSelf: 'flex-start' }}>
          <Stack>
            <Group justify="space-between">
              <Text c="dimmed">Subtotal</Text>
              <Text>{formatMoney(subtotal)}</Text>
            </Group>
            {discount > 0 && (
              <Group justify="space-between">
                <Text c="dimmed">Discount</Text>
                <Text c="red">-{formatMoney(discount)}</Text>
              </Group>
            )}
            <Divider />
            <Group justify="space-between">
              <Title order={3}>Total</Title>
              <Title order={3}>{formatMoney(grandTotal)}</Title>
            </Group>
            <Group grow>
              <Button variant="default" onClick={hold} disabled={lines.length === 0}>
                Hold
              </Button>
              <Button
                variant="light"
                onClick={() => setDiscountOpen(true)}
                disabled={lines.length === 0}
              >
                {discount > 0 ? 'Edit discount' : 'Discount'}
              </Button>
            </Group>
            <Button size="lg" onClick={() => setPayOpen(true)} disabled={lines.length === 0}>
              Pay {formatMoney(grandTotal)}
            </Button>
            <Button variant="subtle" color="gray" onClick={clear} disabled={lines.length === 0}>
              Void sale
            </Button>
          </Stack>
        </Card>
      </Group>

      <WeightModal
        product={weightProduct}
        onClose={() => setWeightProduct(null)}
        onConfirm={(kg) => {
          if (weightProduct) addLine(weightProduct, kg);
          setWeightProduct(null);
          setQuery('');
          setResults([]);
          focusSearch();
        }}
      />

      <PaymentModal
        opened={payOpen}
        total={grandTotal}
        onClose={() => setPayOpen(false)}
        onConfirm={async (method, tendered) => {
          try {
            const result = await invoke('sale:create', {
              token: requireToken(),
              input: {
                items: lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
                paymentMethod: method,
                tendered: tendered ?? undefined,
                transactionDiscount: discount || undefined,
                authorisedBy: authorisedBy ?? undefined,
              },
            });
            setPayOpen(false);
            clear();
            setLastSale(result);
            // Save-before-print: the sale is already persisted; printing is best-effort.
            void invoke('print:receipt', { token: requireToken(), transactionId: result.transaction.id }).catch(
              () => undefined,
            );
          } catch (err) {
            setError((err as Error).message);
            setPayOpen(false);
          }
        }}
      />

      <DiscountModal
        opened={discountOpen}
        max={subtotal}
        onClose={() => setDiscountOpen(false)}
        onApply={(amount, managerId) => {
          setDiscount(amount, managerId);
          setDiscountOpen(false);
        }}
        onClear={() => {
          setDiscount(0, null);
          setDiscountOpen(false);
        }}
      />

      <ReceiptModal sale={lastSale} onClose={() => setLastSale(null)} />

      <Modal opened={heldOpen} onClose={() => setHeldOpen(false)} title="Held sales" centered>
        <Stack>
          {held.length === 0 && <Text c="dimmed">No held sales.</Text>}
          {held.map((h) => (
            <Group key={h.id} justify="space-between">
              <Text size="sm">
                {h.lines.length} items · {new Date(h.at).toLocaleTimeString()}
              </Text>
              <Button
                size="compact-sm"
                onClick={() => {
                  resume(h.id);
                  setHeldOpen(false);
                }}
              >
                Resume
              </Button>
            </Group>
          ))}
        </Stack>
      </Modal>

      <SessionSummaryModal
        session={closeSummary}
        onClose={() => {
          setCloseSummary(null);
          onClosed();
        }}
      />
    </Stack>
  );
}

function WeightModal({
  product,
  onClose,
  onConfirm,
}: {
  product: Product | null;
  onClose: () => void;
  onConfirm: (kg: number) => void;
}) {
  const [kg, setKg] = useState<number>(1);
  useEffect(() => {
    if (product) setKg(1);
  }, [product]);
  return (
    <Modal opened={!!product} onClose={onClose} title={`Weigh — ${product?.name ?? ''}`} centered>
      <Stack>
        <Text c="dimmed">{product ? `${formatMoney(product.unitPrice)} per kg` : ''}</Text>
        <NumberInput
          label="Weight (kg)"
          min={0}
          step={0.1}
          decimalScale={3}
          value={kg}
          onChange={(v) => setKg(typeof v === 'number' ? v : Number(v) || 0)}
          autoFocus
        />
        <Text fw={600}>Line total: {product ? formatMoney(Math.round(kg * product.unitPrice)) : ''}</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(kg)} disabled={kg <= 0}>
            Add
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PaymentModal({
  opened,
  total,
  onClose,
  onConfirm,
}: {
  opened: boolean;
  total: number;
  onClose: () => void;
  onConfirm: (method: PaymentMethod, tendered: number | null) => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [tendered, setTendered] = useState<number>(0);

  useEffect(() => {
    if (opened) {
      setMethod('cash');
      setTendered(toMajor(total));
    }
  }, [opened, total]);

  const tenderedMinor = toMinor(tendered);
  const change = tenderedMinor - total;
  const cashShort = method === 'cash' && tenderedMinor < total;

  return (
    <Modal opened={opened} onClose={onClose} title="Payment" centered>
      <Stack>
        <Group justify="space-between">
          <Text c="dimmed">Amount due</Text>
          <Title order={3}>{formatMoney(total)}</Title>
        </Group>
        <SegmentedControl
          fullWidth
          value={method}
          onChange={(v) => setMethod(v as PaymentMethod)}
          data={[
            { label: 'Cash', value: 'cash' },
            { label: 'MTN', value: 'mobile_mtn' },
            { label: 'Airtel', value: 'mobile_airtel' },
            { label: 'Card', value: 'card' },
          ]}
        />
        {method === 'cash' && (
          <>
            <NumberInput
              label="Cash tendered"
              prefix="K "
              decimalScale={2}
              min={0}
              value={tendered}
              onChange={(v) => setTendered(typeof v === 'number' ? v : Number(v) || 0)}
              autoFocus
            />
            <Group justify="space-between">
              <Text c="dimmed">Change</Text>
              <Text fw={600} c={change < 0 ? 'red' : undefined}>
                {formatMoney(Math.max(0, change))}
              </Text>
            </Group>
          </>
        )}
        <Button
          size="lg"
          disabled={cashShort}
          onClick={() => onConfirm(method, method === 'cash' ? tenderedMinor : null)}
        >
          Complete sale
        </Button>
      </Stack>
    </Modal>
  );
}

function DiscountModal({
  opened,
  max,
  onClose,
  onApply,
  onClear,
}: {
  opened: boolean;
  max: number;
  onClose: () => void;
  onApply: (amountMinor: number, managerId: string) => void;
  onClear: () => void;
}) {
  const [amount, setAmount] = useState<number>(0);
  const [authOpen, setAuthOpen] = useState(false);

  useEffect(() => {
    if (opened) setAmount(0);
  }, [opened]);

  const amountMinor = toMinor(amount);
  const tooBig = amountMinor > max;

  return (
    <>
      <Modal opened={opened && !authOpen} onClose={onClose} title="Apply discount" centered>
        <Stack>
          <Text c="dimmed" size="sm">
            Discounts require manager authorisation.
          </Text>
          <NumberInput
            label="Discount amount"
            prefix="K "
            decimalScale={2}
            min={0}
            value={amount}
            onChange={(v) => setAmount(typeof v === 'number' ? v : Number(v) || 0)}
            error={tooBig ? 'Discount exceeds the subtotal.' : undefined}
            autoFocus
          />
          <Group justify="space-between">
            <Button variant="subtle" color="red" onClick={onClear}>
              Remove discount
            </Button>
            <Button disabled={amountMinor <= 0 || tooBig} onClick={() => setAuthOpen(true)}>
              Continue
            </Button>
          </Group>
        </Stack>
      </Modal>
      <ManagerAuthModal
        opened={authOpen}
        title="Authorise discount"
        reason={`Approve a ${formatMoney(amountMinor)} discount.`}
        onClose={() => setAuthOpen(false)}
        onAuthorized={(managerId) => {
          setAuthOpen(false);
          onApply(amountMinor, managerId);
        }}
      />
    </>
  );
}

function ReceiptModal({
  sale,
  onClose,
}: {
  sale: { transaction: Transaction; receipt: ReceiptData } | null;
  onClose: () => void;
}) {
  async function reprint() {
    if (!sale) return;
    await invoke('print:receipt', { token: requireToken(), transactionId: sale.transaction.id }).catch(
      () => undefined,
    );
  }
  return (
    <Modal opened={!!sale} onClose={onClose} title="Sale complete" centered size="sm">
      {sale && (
        <Stack>
          {sale.transaction.changeDue ? (
            <Alert color="green" variant="light">
              Change due: <b>{formatMoney(sale.transaction.changeDue)}</b>
            </Alert>
          ) : null}
          <Paper withBorder p="sm" bg="gray.0">
            <Text component="pre" ff="monospace" fz="xs" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {sale.receipt.text}
            </Text>
          </Paper>
          <Group justify="space-between">
            <Button variant="default" onClick={reprint}>
              Reprint
            </Button>
            <Button onClick={onClose}>New sale</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function SessionSummaryModal({ session, onClose }: { session: TillSession | null; onClose: () => void }) {
  const t = session?.totals;
  const expectedCash = (session?.openingFloat ?? 0) + (t?.totalCash ?? 0);
  return (
    <Modal opened={!!session} onClose={onClose} title="Session summary" centered>
      {session && t && (
        <Stack>
          <Row label="Transactions" value={String(t.txnCount)} />
          <Row label="Net sales" value={formatMoney(t.totalSales)} />
          <Divider />
          <Row label="Cash" value={formatMoney(t.totalCash)} />
          <Row label="Card" value={formatMoney(t.totalCard)} />
          <Row label="Mobile money" value={formatMoney(t.totalMobile)} />
          <Row label="Discounts" value={formatMoney(t.discountTotal)} />
          <Divider />
          <Row label="Opening float" value={formatMoney(session.openingFloat)} />
          <Group justify="space-between">
            <Text fw={700}>Expected cash in drawer</Text>
            <Text fw={700}>{formatMoney(expectedCash)}</Text>
          </Group>
          <Button onClick={onClose} mt="sm">
            Done
          </Button>
        </Stack>
      )}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between">
      <Text c="dimmed">{label}</Text>
      <Text>{value}</Text>
    </Group>
  );
}
