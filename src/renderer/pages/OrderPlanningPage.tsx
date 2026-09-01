/**
 * Order Planning (M11).
 *
 * Two tabs:
 *  - **Order plans** — build a shopping list by typing a code + quantity; the
 *    plan totals what the order will cost, tracks the cash taken, what was
 *    really paid and the change to hand back, then freezes as a permanent record.
 *  - **Price list** — the preset cost of everything the shop buys, each under a
 *    short code so planning is typing, not remembering.
 *
 * Money is minor units across IPC; only these inputs work in Kwacha.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Modal,
  NumberInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import type { Product, OrderCatalogueItem, OrderCostHistoryEntry, OrderPlan, OrderPlanItem } from '@shared/types/domain';
import type { OrderPlanStatus } from '@shared/constants';
import { ORDER_UNITS } from '@shared/constants';
import { formatMoney, toMajor, toMinor } from '@shared/money';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

// ------------------------------------------------------------------ helpers

const STATUS_COLOR: Record<OrderPlanStatus, string> = {
  draft: 'blue',
  shopping: 'yellow',
  closed: 'green',
  cancelled: 'gray',
};

const STATUS_LABEL: Record<OrderPlanStatus, string> = {
  draft: 'Draft',
  shopping: 'Shopping',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

function isEditable(plan: OrderPlan): boolean {
  return plan.status === 'draft' || plan.status === 'shopping';
}

/** What a line has really cost: its actual total, or the plan when none recorded. */
function effectiveTotal(line: OrderPlanItem): number {
  return line.actualLineTotal ?? line.lineTotal;
}

function spentSoFar(plan: OrderPlan): number {
  return (plan.items ?? []).reduce((sum, line) => sum + effectiveTotal(line), 0);
}

/** Mantine NumberInput hands back a string mid-typing; keep NaN out of the maths. */
function numOrBlank(value: string | number): number | '' {
  if (value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n : '';
}

function qtyString(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '');
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const UNIT_OPTIONS = ORDER_UNITS.map((u) => ({ value: u, label: u }));

// ================================================================== the page

export function OrderPlanningPage() {
  const [tab, setTab] = useState<string | null>('plans');

  return (
    <Stack>
      <Title order={2}>Order Planning</Title>
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="plans">Order plans</Tabs.Tab>
          <Tabs.Tab value="pricelist">Price list</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="plans" pt="md">
          <PlansTab />
        </Tabs.Panel>
        <Tabs.Panel value="pricelist" pt="md">
          <PriceListTab />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

// ============================================================== plans: list

function PlansTab() {
  const [plans, setPlans] = useState<OrderPlan[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPlans(await invoke('order:planList', { token: requireToken() }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (openId) {
    return (
      <PlanDetail
        key={openId}
        planId={openId}
        onBack={() => {
          setOpenId(null);
          void load();
        }}
        onOpenOther={(id) => setOpenId(id)}
      />
    );
  }

  return (
    <Stack>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          Every order you have planned, with what it was budgeted at and what it actually cost.
        </Text>
        <Button onClick={() => setCreating(true)}>New order plan</Button>
      </Group>

      {plans.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="xs">
            <Text fw={600}>No order plans yet</Text>
            <Text c="dimmed" size="sm" ta="center">
              Put your buying prices on the <strong>Price list</strong> tab first, then start a plan and type
              codes and quantities to see what the order will cost.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Reference</Table.Th>
              <Table.Th>Plan</Table.Th>
              <Table.Th>Date</Table.Th>
              <Table.Th>Status</Table.Th>
              <Table.Th ta="right">Items</Table.Th>
              <Table.Th ta="right">Planned</Table.Th>
              <Table.Th ta="right">Cash taken</Table.Th>
              <Table.Th ta="right">Spent</Table.Th>
              <Table.Th ta="right">Change</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {plans.map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>
                  <Text ff="monospace" size="sm">
                    {p.reference}
                  </Text>
                </Table.Td>
                <Table.Td fw={500}>{p.title}</Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="light" color={STATUS_COLOR[p.status]}>
                    {STATUS_LABEL[p.status]}
                  </Badge>
                </Table.Td>
                <Table.Td ta="right">{p.itemCount ?? 0}</Table.Td>
                <Table.Td ta="right">{formatMoney(p.plannedTotal)}</Table.Td>
                <Table.Td ta="right">{p.budget == null ? '—' : formatMoney(p.budget)}</Table.Td>
                <Table.Td ta="right">{p.actualTotal == null ? '—' : formatMoney(p.actualTotal)}</Table.Td>
                <Table.Td ta="right">
                  <ChangeText value={p.changeReturned} />
                </Table.Td>
                <Table.Td>
                  <Button size="compact-sm" variant="light" onClick={() => setOpenId(p.id)}>
                    Open
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <NewPlanModal
        opened={creating}
        onClose={() => setCreating(false)}
        onCreated={(plan) => {
          setCreating(false);
          setOpenId(plan.id);
        }}
      />
    </Stack>
  );
}

function ChangeText({ value }: { value: number | null }) {
  if (value == null) return <Text span>—</Text>;
  if (value < 0)
    return (
      <Text span c="red" fw={600}>
        {formatMoney(-value)} over
      </Text>
    );
  return (
    <Text span c="green" fw={600}>
      {formatMoney(value)}
    </Text>
  );
}

function NewPlanModal({
  opened,
  onClose,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: (plan: OrderPlan) => void;
}) {
  const [title, setTitle] = useState('');
  const [budget, setBudget] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (opened) {
      const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      setTitle(`Order — ${today}`);
      setBudget('');
      setNotes('');
      setError(null);
    }
  }, [opened]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const plan = await invoke('order:planCreate', {
        token: requireToken(),
        input: {
          title,
          budget: budget === '' ? null : toMinor(budget),
          notes: notes || null,
        },
      });
      onCreated(plan);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New order plan" centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <TextInput
          label="What is this order for?"
          placeholder="e.g. Friday market run"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          autoFocus
        />
        <NumberInput
          label="Cash you are taking (optional)"
          description="Set it now or when you close the plan. Change is worked out against this."
          prefix="K "
          min={0}
          decimalScale={2}
          thousandSeparator=","
          value={budget}
          onChange={(v) => setBudget(numOrBlank(v))}
        />
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!title.trim()}>
            Start planning
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ============================================================ plans: detail

function PlanDetail({
  planId,
  onBack,
  onOpenOther,
}: {
  planId: string;
  onBack: () => void;
  onOpenOther: (id: string) => void;
}) {
  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [catalogue, setCatalogue] = useState<OrderCatalogueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setPlan(await invoke('order:planGet', { token: requireToken(), id: planId }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [planId]);

  useEffect(() => {
    void load();
    invoke('order:catalogueList', { token: requireToken() })
      .then(setCatalogue)
      .catch(() => undefined);
  }, [load]);

  /** Every mutation returns the whole plan, so the view stays in step with MAIN. */
  const run = useCallback(async (action: () => Promise<OrderPlan>) => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await action());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  if (!plan) {
    return (
      <Stack>
        <Button variant="subtle" onClick={onBack} w="fit-content">
          ← All order plans
        </Button>
        {error ? <Alert color="red" variant="light">{error}</Alert> : <Text c="dimmed">Loading…</Text>}
      </Stack>
    );
  }

  const lines = plan.items ?? [];
  const editable = isEditable(plan);
  const spent = spentSoFar(plan);
  const shownSpent = plan.actualTotal ?? spent;
  const remaining = plan.budget == null ? null : plan.budget - shownSpent;

  async function setStatus(status: 'draft' | 'shopping' | 'cancelled') {
    await run(() => invoke('order:planSetStatus', { token: requireToken(), id: planId, status }));
  }

  async function duplicate() {
    setBusy(true);
    setError(null);
    try {
      const copy = await invoke('order:planDuplicate', { token: requireToken(), id: planId });
      onOpenOther(copy.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const rows: (string | number)[][] = lines.map((l) => [
      l.code,
      l.name,
      qtyString(l.quantity),
      l.unitOfOrder,
      toMajor(l.unitCost),
      toMajor(l.lineTotal),
      l.actualQuantity == null ? '' : qtyString(l.actualQuantity),
      l.actualUnitCost == null ? '' : toMajor(l.actualUnitCost),
      l.actualLineTotal == null ? '' : toMajor(l.actualLineTotal),
      l.notes ?? '',
    ]);
    rows.push(['', 'PLANNED TOTAL', '', '', '', toMajor(plan!.plannedTotal), '', '', '', '']);
    if (plan!.budget != null) rows.push(['', 'CASH TAKEN', '', '', '', toMajor(plan!.budget), '', '', '', '']);
    rows.push(['', 'SPENT', '', '', '', '', '', '', toMajor(shownSpent), '']);
    downloadCsv(
      `${plan!.reference}-shopping-list.csv`,
      toCsv(
        ['Code', 'Item', 'Qty', 'Unit', 'Unit cost (K)', 'Planned (K)', 'Actual qty', 'Actual cost (K)', 'Actual total (K)', 'Notes'],
        rows,
      ),
    );
  }

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={2}>
          <Button variant="subtle" onClick={onBack} w="fit-content" px={0}>
            ← All order plans
          </Button>
          <Group gap="sm">
            <Title order={3}>{plan.title}</Title>
            <Badge variant="light" color={STATUS_COLOR[plan.status]}>
              {STATUS_LABEL[plan.status]}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed" ff="monospace">
            {plan.reference}
            {plan.createdByName ? ` · ${plan.createdByName}` : ''} ·{' '}
            {new Date(plan.createdAt).toLocaleString()}
          </Text>
        </Stack>

        <Group gap="xs">
          <Button size="compact-sm" variant="default" onClick={exportCsv} disabled={lines.length === 0}>
            Export list
          </Button>
          <Button size="compact-sm" variant="default" onClick={duplicate} loading={busy}>
            Duplicate
          </Button>
          {editable && (
            <>
              <Button size="compact-sm" variant="default" onClick={() => setEditing(true)}>
                Edit details
              </Button>
              {plan.status === 'draft' ? (
                <Button size="compact-sm" variant="light" onClick={() => void setStatus('shopping')}>
                  Start shopping
                </Button>
              ) : (
                <Button size="compact-sm" variant="subtle" onClick={() => void setStatus('draft')}>
                  Back to draft
                </Button>
              )}
              <Button size="compact-sm" onClick={() => setClosing(true)} disabled={lines.length === 0}>
                Close &amp; reconcile
              </Button>
              <Button size="compact-sm" variant="subtle" color="red" onClick={() => void setStatus('cancelled')}>
                Cancel plan
              </Button>
            </>
          )}
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!editable && (
        <Alert color={plan.status === 'closed' ? 'green' : 'gray'} variant="light">
          This plan is {STATUS_LABEL[plan.status].toLowerCase()} and kept as a permanent record — it can no
          longer be changed. Use <strong>Duplicate</strong> to start a new plan from it.
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <SummaryCard label="Planned spend" value={formatMoney(plan.plannedTotal)} />
        <SummaryCard label="Cash taken" value={plan.budget == null ? 'Not set' : formatMoney(plan.budget)} />
        <SummaryCard label={plan.status === 'closed' ? 'Spent' : 'Spend so far'} value={formatMoney(shownSpent)} />
        <SummaryCard
          label={remaining != null && remaining < 0 ? 'Over budget by' : 'Change to return'}
          value={remaining == null ? '—' : formatMoney(Math.abs(remaining))}
          color={remaining == null ? undefined : remaining < 0 ? 'red' : 'green'}
        />
      </SimpleGrid>

      {editable && <AddLineForm catalogue={catalogue} busy={busy} run={run} planId={planId} />}

      <LinesTable
        plan={plan}
        editable={editable}
        run={run}
        onRefresh={() => void load()}
      />

      {plan.notes && (
        <Card withBorder radius="md" p="sm">
          <Text size="sm" c="dimmed">
            Notes
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {plan.notes}
          </Text>
        </Card>
      )}

      <EditPlanModal
        plan={editing ? plan : null}
        onClose={() => setEditing(false)}
        onSaved={(updated) => {
          setEditing(false);
          setPlan(updated);
        }}
      />
      <ClosePlanModal
        plan={closing ? plan : null}
        computedSpend={spent}
        onClose={() => setClosing(false)}
        onClosed={(updated) => {
          setClosing(false);
          setPlan(updated);
        }}
      />
    </Stack>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl" c={color}>
        {value}
      </Text>
    </Card>
  );
}

/** The heart of the tab: type a code, type a quantity, get a costed line. */
function AddLineForm({
  catalogue,
  busy,
  run,
  planId,
}: {
  catalogue: OrderCatalogueItem[];
  busy: boolean;
  run: (action: () => Promise<OrderPlan>) => Promise<boolean>;
  planId: string;
}) {
  const [code, setCode] = useState('');
  const [qty, setQty] = useState<number | ''>(1);
  const [oneOff, setOneOff] = useState(false);
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<string>('each');
  const [cost, setCost] = useState<number | ''>('');
  const codeRef = useRef<HTMLInputElement>(null);

  const match = useMemo(() => {
    const q = code.trim().toUpperCase();
    return q ? (catalogue.find((c) => c.code.toUpperCase() === q) ?? null) : null;
  }, [code, catalogue]);

  const quantity = qty === '' ? 0 : qty;
  const preview = match && quantity > 0 ? Math.round(quantity * match.unitCost) : null;
  const canAdd = quantity > 0 && (oneOff ? name.trim() !== '' && cost !== '' : code.trim() !== '');

  async function add() {
    if (!canAdd) return;
    const ok = await run(() =>
      invoke('order:planAddLine', {
        token: requireToken(),
        planId,
        input: oneOff
          ? {
              adHoc: true,
              code: code.trim() || undefined,
              name: name.trim(),
              unitOfOrder: unit,
              quantity,
              unitCost: toMinor(cost === '' ? 0 : cost),
            }
          : { code: code.trim(), quantity },
      }),
    );
    if (ok) {
      setCode('');
      setQty(1);
      setName('');
      setCost('');
      codeRef.current?.focus();
    }
  }

  function onEnter(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void add();
    }
  }

  return (
    <Card withBorder radius="md" p="sm">
      <Stack gap="xs">
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput
            ref={codeRef}
            label={oneOff ? 'Code / label' : 'Item code'}
            placeholder="e.g. BF01"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
            onKeyDown={onEnter}
            w={150}
            autoFocus
          />
          {!oneOff && (
            <Select
              label="…or pick from the list"
              placeholder="Search items"
              searchable
              clearable
              value={match?.id ?? null}
              onChange={(id) => setCode(catalogue.find((c) => c.id === id)?.code ?? '')}
              data={catalogue.map((c) => ({
                value: c.id,
                label: `${c.code} — ${c.name} (${formatMoney(c.unitCost)}/${c.unitOfOrder})`,
              }))}
              w={340}
            />
          )}
          {oneOff && (
            <>
              <TextInput
                label="Item"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                onKeyDown={onEnter}
                w={200}
              />
              <Select label="Unit" data={UNIT_OPTIONS} value={unit} onChange={(v) => setUnit(v ?? 'each')} w={110} />
              <NumberInput
                label="Cost per unit"
                prefix="K "
                min={0}
                decimalScale={2}
                value={cost}
                onChange={(v) => setCost(numOrBlank(v))}
                onKeyDown={onEnter}
                w={150}
              />
            </>
          )}
          <NumberInput
            label="Quantity"
            min={0}
            step={1}
            decimalScale={3}
            value={qty}
            onChange={(v) => setQty(numOrBlank(v))}
            onKeyDown={onEnter}
            w={120}
          />
          <Button onClick={add} loading={busy} disabled={!canAdd}>
            Add to order
          </Button>
          <Switch
            label="Not on the price list"
            checked={oneOff}
            onChange={(e) => setOneOff(e.currentTarget.checked)}
            ml="auto"
          />
        </Group>

        {!oneOff && code.trim() !== '' && (
          <Text size="sm" c={match ? 'dimmed' : 'red'}>
            {match
              ? `${match.name} — ${formatMoney(match.unitCost)} per ${match.unitOfOrder}${
                  preview != null ? ` · ${qtyString(quantity)} ${match.unitOfOrder} = ${formatMoney(preview)}` : ''
                }`
              : `No item with code "${code.trim()}". Add it on the Price list tab, or switch on “Not on the price list”.`}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

function LinesTable({
  plan,
  editable,
  run,
  onRefresh,
}: {
  plan: OrderPlan;
  editable: boolean;
  run: (action: () => Promise<OrderPlan>) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const lines = plan.items ?? [];
  const [editLine, setEditLine] = useState<OrderPlanItem | null>(null);
  const showActuals = plan.status !== 'draft';

  if (lines.length === 0) {
    return (
      <Card withBorder radius="md" p="xl">
        <Text c="dimmed" ta="center">
          Nothing on this order yet — type an item code and a quantity above.
        </Text>
      </Card>
    );
  }

  return (
    <>
      <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Code</Table.Th>
            <Table.Th>Item</Table.Th>
            <Table.Th ta="right">Qty</Table.Th>
            <Table.Th ta="right">Unit cost</Table.Th>
            <Table.Th ta="right">Planned</Table.Th>
            {showActuals && <Table.Th ta="right">Actually bought</Table.Th>}
            {showActuals && <Table.Th ta="right">Actually paid</Table.Th>}
            {editable && <Table.Th />}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {lines.map((line) => {
            const differs = line.actualLineTotal != null && line.actualLineTotal !== line.lineTotal;
            return (
              <Table.Tr key={line.id}>
                <Table.Td>
                  <Text ff="monospace" size="sm">
                    {line.code}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text fw={500}>{line.name}</Text>
                  {line.notes && (
                    <Text size="xs" c="dimmed">
                      {line.notes}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">
                  {qtyString(line.quantity)} {line.unitOfOrder}
                </Table.Td>
                <Table.Td ta="right">{formatMoney(line.unitCost)}</Table.Td>
                <Table.Td ta="right">{formatMoney(line.lineTotal)}</Table.Td>
                {showActuals && (
                  <Table.Td ta="right">
                    <Text c={line.actualQuantity == null ? 'dimmed' : undefined}>
                      {line.actualQuantity == null
                        ? 'as planned'
                        : `${qtyString(line.actualQuantity)} ${line.unitOfOrder}`}
                    </Text>
                  </Table.Td>
                )}
                {showActuals && (
                  <Table.Td ta="right">
                    <Text fw={differs ? 700 : undefined} c={differs ? 'orange' : undefined}>
                      {formatMoney(effectiveTotal(line))}
                    </Text>
                  </Table.Td>
                )}
                {editable && (
                  <Table.Td>
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="light" onClick={() => setEditLine(line)}>
                        {showActuals ? 'Record' : 'Edit'}
                      </Button>
                      <Tooltip label="Remove from the order">
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="red"
                          onClick={() =>
                            void run(() =>
                              invoke('order:planRemoveLine', { token: requireToken(), lineId: line.id }),
                            )
                          }
                        >
                          ×
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                )}
              </Table.Tr>
            );
          })}
        </Table.Tbody>
        <Table.Tfoot>
          <Table.Tr>
            <Table.Th colSpan={4} ta="right">
              Totals
            </Table.Th>
            <Table.Th ta="right">{formatMoney(plan.plannedTotal)}</Table.Th>
            {showActuals && <Table.Th />}
            {showActuals && <Table.Th ta="right">{formatMoney(plan.actualTotal ?? spentSoFar(plan))}</Table.Th>}
            {editable && <Table.Th />}
          </Table.Tr>
        </Table.Tfoot>
      </Table>

      <EditLineModal
        line={editLine}
        showActuals={showActuals}
        onClose={() => setEditLine(null)}
        onSaved={() => {
          setEditLine(null);
          onRefresh();
        }}
      />
    </>
  );
}

function EditLineModal({
  line,
  showActuals,
  onClose,
  onSaved,
}: {
  line: OrderPlanItem | null;
  showActuals: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [qty, setQty] = useState<number | ''>('');
  const [cost, setCost] = useState<number | ''>('');
  const [actualQty, setActualQty] = useState<number | ''>('');
  const [actualCost, setActualCost] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (line) {
      setQty(line.quantity);
      setCost(toMajor(line.unitCost));
      setActualQty(line.actualQuantity ?? '');
      setActualCost(line.actualUnitCost == null ? '' : toMajor(line.actualUnitCost));
      setNotes(line.notes ?? '');
      setError(null);
    }
  }, [line]);

  async function submit() {
    if (!line) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('order:planUpdateLine', {
        token: requireToken(),
        lineId: line.id,
        patch: {
          quantity: qty === '' ? undefined : qty,
          unitCost: cost === '' ? undefined : toMinor(cost),
          actualQuantity: actualQty === '' ? null : actualQty,
          actualUnitCost: actualCost === '' ? null : toMinor(actualCost),
          notes: notes || null,
        },
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const plannedTotal = qty === '' || cost === '' ? 0 : Math.round(qty * toMinor(cost));
  const effQty = actualQty === '' ? (qty === '' ? 0 : qty) : actualQty;
  const effCost = actualCost === '' ? (cost === '' ? 0 : cost) : actualCost;
  const actualTotal = Math.round(effQty * toMinor(effCost));

  return (
    <Modal opened={!!line} onClose={onClose} title={line ? `${line.code} — ${line.name}` : ''} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group grow>
          <NumberInput
            label="Quantity"
            min={0}
            decimalScale={3}
            value={qty}
            onChange={(v) => setQty(numOrBlank(v))}
            autoFocus={!showActuals}
          />
          <NumberInput
            label="Cost per unit"
            prefix="K "
            min={0}
            decimalScale={2}
            value={cost}
            onChange={(v) => setCost(numOrBlank(v))}
          />
        </Group>
        <Text size="sm" c="dimmed">
          Planned: {formatMoney(plannedTotal)}
        </Text>

        {showActuals && (
          <>
            <Text fw={600} size="sm" mt="xs">
              What actually happened
            </Text>
            <Text size="xs" c="dimmed">
              Leave blank if it went exactly as planned. Enter 0 quantity if you did not buy it.
            </Text>
            <Group grow>
              <NumberInput
                label="Quantity bought"
                placeholder="as planned"
                min={0}
                decimalScale={3}
                value={actualQty}
                onChange={(v) => setActualQty(numOrBlank(v))}
                autoFocus
              />
              <NumberInput
                label="Price paid per unit"
                placeholder="as planned"
                prefix="K "
                min={0}
                decimalScale={2}
                value={actualCost}
                onChange={(v) => setActualCost(numOrBlank(v))}
              />
            </Group>
            <Text size="sm" c="dimmed">
              This line costs: {formatMoney(actualTotal)}
            </Text>
          </>
        )}

        <TextInput label="Note (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function EditPlanModal({
  plan,
  onClose,
  onSaved,
}: {
  plan: OrderPlan | null;
  onClose: () => void;
  onSaved: (plan: OrderPlan) => void;
}) {
  const [title, setTitle] = useState('');
  const [budget, setBudget] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      setTitle(plan.title);
      setBudget(plan.budget == null ? '' : toMajor(plan.budget));
      setNotes(plan.notes ?? '');
      setError(null);
    }
  }, [plan]);

  async function submit() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await invoke('order:planUpdate', {
          token: requireToken(),
          id: plan.id,
          patch: { title, budget: budget === '' ? null : toMinor(budget), notes: notes || null },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={!!plan} onClose={onClose} title="Order plan details" centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <TextInput label="Name" value={title} onChange={(e) => setTitle(e.currentTarget.value)} autoFocus />
        <NumberInput
          label="Cash taken"
          prefix="K "
          min={0}
          decimalScale={2}
          thousandSeparator=","
          value={budget}
          onChange={(v) => setBudget(numOrBlank(v))}
        />
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!title.trim()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ClosePlanModal({
  plan,
  computedSpend,
  onClose,
  onClosed,
}: {
  plan: OrderPlan | null;
  computedSpend: number;
  onClose: () => void;
  onClosed: (plan: OrderPlan) => void;
}) {
  const [budget, setBudget] = useState<number | ''>('');
  const [spent, setSpent] = useState<number | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (plan) {
      setBudget(plan.budget == null ? '' : toMajor(plan.budget));
      setSpent(toMajor(computedSpend));
      setNotes(plan.notes ?? '');
      setError(null);
    }
  }, [plan, computedSpend]);

  async function submit() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      onClosed(
        await invoke('order:planClose', {
          token: requireToken(),
          id: plan.id,
          input: {
            budget: budget === '' ? null : toMinor(budget),
            actualTotal: spent === '' ? undefined : toMinor(spent),
            notes: notes || null,
          },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const change = budget === '' || spent === '' ? null : toMinor(budget) - toMinor(spent);

  return (
    <Modal opened={!!plan} onClose={onClose} title="Close & reconcile the order" centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Text size="sm" c="dimmed">
          This freezes the order as a permanent record. Check the figures — they cannot be changed afterwards.
        </Text>
        <NumberInput
          label="Cash taken"
          prefix="K "
          min={0}
          decimalScale={2}
          thousandSeparator=","
          value={budget}
          onChange={(v) => setBudget(numOrBlank(v))}
        />
        <NumberInput
          label="Total actually spent"
          description="Worked out from the lines — adjust it to match your receipts if it differs."
          prefix="K "
          min={0}
          decimalScale={2}
          thousandSeparator=","
          value={spent}
          onChange={(v) => setSpent(numOrBlank(v))}
        />
        <Card withBorder radius="md" p="sm">
          <Group justify="space-between">
            <Text fw={600}>{change != null && change < 0 ? 'Short by' : 'Change to return'}</Text>
            <Text fw={700} c={change == null ? undefined : change < 0 ? 'red' : 'green'}>
              {change == null ? '—' : formatMoney(Math.abs(change))}
            </Text>
          </Group>
        </Card>
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Not yet
          </Button>
          <Button color="green" onClick={submit} loading={busy}>
            Close the order
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ========================================================== the price list

function PriceListTab() {
  const [items, setItems] = useState<OrderCatalogueItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [filter, setFilter] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<OrderCatalogueItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [historyFor, setHistoryFor] = useState<OrderCatalogueItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await invoke('order:catalogueList', { token: requireToken(), includeInactive: showInactive }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    invoke('product:list', { token: requireToken() })
      .then(setProducts)
      .catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.code.toLowerCase().includes(q) ||
        i.name.toLowerCase().includes(q) ||
        (i.supplier ?? '').toLowerCase().includes(q),
    );
  }, [items, filter]);

  return (
    <Stack>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Group justify="space-between">
        <Text c="dimmed" size="sm">
          What each item costs to buy. Give every item a short code — that is what you type when planning.
        </Text>
        <Group>
          <TextInput
            placeholder="Filter by code, item or supplier"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <Switch
            label="Show retired"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.currentTarget.checked)}
          />
          <Button onClick={() => setAdding(true)}>Add item</Button>
        </Group>
      </Group>

      {visible.length === 0 ? (
        <Card withBorder radius="md" p="xl">
          <Stack align="center" gap="xs">
            <Text fw={600}>No items on the order price list</Text>
            <Text c="dimmed" size="sm" ta="center">
              Add what you buy and what it costs — e.g. code <strong>BF01</strong>, “Beef carcass”, K85.00 per
              kg — and planning an order becomes typing codes and quantities.
            </Text>
          </Stack>
        </Card>
      ) : (
        <Table striped highlightOnHover withTableBorder verticalSpacing="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Code</Table.Th>
              <Table.Th>Item</Table.Th>
              <Table.Th>Supplier</Table.Th>
              <Table.Th ta="right">Order cost</Table.Th>
              <Table.Th>Per</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((i) => (
              <Table.Tr key={i.id} opacity={i.active ? 1 : 0.55}>
                <Table.Td>
                  <Text ff="monospace" fw={600}>
                    {i.code}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Text fw={500}>{i.name}</Text>
                    {!i.active && (
                      <Badge size="xs" variant="light" color="gray">
                        retired
                      </Badge>
                    )}
                  </Group>
                  {i.notes && (
                    <Text size="xs" c="dimmed">
                      {i.notes}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{i.supplier ?? '—'}</Table.Td>
                <Table.Td ta="right" fw={600}>
                  {formatMoney(i.unitCost)}
                </Table.Td>
                <Table.Td>{i.unitOfOrder}</Table.Td>
                <Table.Td>
                  <Group gap="xs" justify="flex-end" wrap="nowrap">
                    <Button size="compact-xs" variant="light" onClick={() => setEditing(i)}>
                      Edit
                    </Button>
                    <Button size="compact-xs" variant="subtle" onClick={() => setHistoryFor(i)}>
                      Cost history
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <CatalogueModal
        item={editing}
        opened={adding || !!editing}
        products={products}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSaved={() => {
          setAdding(false);
          setEditing(null);
          void load();
        }}
      />
      <CostHistoryModal item={historyFor} onClose={() => setHistoryFor(null)} />
    </Stack>
  );
}

function CatalogueModal({
  item,
  opened,
  products,
  onClose,
  onSaved,
}: {
  item: OrderCatalogueItem | null;
  opened: boolean;
  products: Product[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [supplier, setSupplier] = useState('');
  const [unit, setUnit] = useState<string>('each');
  const [cost, setCost] = useState<number | ''>('');
  const [productId, setProductId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setCode(item?.code ?? '');
    setName(item?.name ?? '');
    setSupplier(item?.supplier ?? '');
    setUnit(item?.unitOfOrder ?? 'each');
    setCost(item ? toMajor(item.unitCost) : '');
    setProductId(item?.productId ?? null);
    setNotes(item?.notes ?? '');
    setActive(item?.active ?? true);
    setError(null);
  }, [opened, item]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const unitCost = toMinor(cost === '' ? 0 : cost);
      if (item) {
        await invoke('order:catalogueUpdate', {
          token: requireToken(),
          id: item.id,
          patch: {
            code,
            name,
            supplier: supplier || null,
            unitOfOrder: unit,
            unitCost,
            productId,
            notes: notes || null,
            active,
          },
        });
      } else {
        await invoke('order:catalogueCreate', {
          token: requireToken(),
          input: {
            code,
            name,
            supplier: supplier || null,
            unitOfOrder: unit,
            unitCost,
            productId,
            notes: notes || null,
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
    <Modal opened={opened} onClose={onClose} title={item ? `Edit ${item.code}` : 'Add an item to the order list'} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Group grow>
          <TextInput
            label="Code"
            description="What you will type"
            placeholder="BF01"
            value={code}
            onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
            autoFocus
          />
          <TextInput
            label="Item"
            placeholder="Beef carcass"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </Group>
        <Group grow>
          <NumberInput
            label="Order cost"
            description="What you pay the supplier"
            prefix="K "
            min={0}
            decimalScale={2}
            thousandSeparator=","
            value={cost}
            onChange={(v) => setCost(numOrBlank(v))}
          />
          <Select label="Per" data={UNIT_OPTIONS} value={unit} onChange={(v) => setUnit(v ?? 'each')} />
        </Group>
        <TextInput
          label="Supplier (optional)"
          value={supplier}
          onChange={(e) => setSupplier(e.currentTarget.value)}
        />
        <Select
          label="Shop product this stocks (optional)"
          placeholder="Not linked"
          searchable
          clearable
          value={productId}
          onChange={setProductId}
          data={products.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Textarea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        {item && (
          <Switch
            label="On the order list"
            description="Retire an item instead of deleting it — past plans keep their history."
            checked={active}
            onChange={(e) => setActive(e.currentTarget.checked)}
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!code.trim() || !name.trim() || cost === ''}>
            {item ? 'Save' : 'Add item'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CostHistoryModal({ item, onClose }: { item: OrderCatalogueItem | null; onClose: () => void }) {
  const [rows, setRows] = useState<OrderCostHistoryEntry[]>([]);

  useEffect(() => {
    if (!item) return;
    setRows([]);
    invoke('order:costHistory', { token: requireToken(), catalogueId: item.id })
      .then(setRows)
      .catch(() => undefined);
  }, [item]);

  return (
    <Modal opened={!!item} onClose={onClose} title={item ? `Cost history — ${item.code}` : ''} centered>
      {rows.length === 0 ? (
        <Text c="dimmed">The cost has not changed since this item was added.</Text>
      ) : (
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th ta="right">Was</Table.Th>
              <Table.Th ta="right">Became</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>{new Date(r.datetime).toLocaleString()}</Table.Td>
                <Table.Td ta="right">{formatMoney(r.oldCost)}</Table.Td>
                <Table.Td ta="right" fw={600} c={r.newCost > r.oldCost ? 'red' : 'green'}>
                  {formatMoney(r.newCost)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Modal>
  );
}
