import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import type { InventoryLevelView } from '@shared/types/domain';
import { invoke } from '../api/client';
import { requireToken } from '../stores/auth';

export function InventoryPage() {
  const [levels, setLevels] = useState<InventoryLevelView[]>([]);
  const [filter, setFilter] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stockInFor, setStockInFor] = useState<InventoryLevelView | null>(null);
  const [adjustFor, setAdjustFor] = useState<InventoryLevelView | null>(null);

  const load = useCallback(async () => {
    try {
      setLevels(await invoke('inventory:levels', { token: requireToken() }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return levels.filter(
      (l) => (!lowOnly || l.isLow) && (!q || l.name.toLowerCase().includes(q) || l.category.toLowerCase().includes(q)),
    );
  }, [levels, filter, lowOnly]);

  const lowCount = levels.filter((l) => l.isLow).length;

  return (
    <Stack>
      <Group justify="space-between">
        <Group>
          <Title order={2}>Inventory</Title>
          {lowCount > 0 && (
            <Badge color="red" variant="filled">
              {lowCount} low on stock
            </Badge>
          )}
        </Group>
        <Group>
          <TextInput
            placeholder="Filter products"
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <Switch label="Low stock only" checked={lowOnly} onChange={(e) => setLowOnly(e.currentTarget.checked)} />
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
            <Table.Th>Product</Table.Th>
            <Table.Th>Category</Table.Th>
            <Table.Th ta="right">In stock</Table.Th>
            <Table.Th ta="right">Low at</Table.Th>
            <Table.Th>Last movement</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {visible.map((l) => (
            <Table.Tr key={l.productId} bg={l.isLow ? 'red.0' : undefined}>
              <Table.Td fw={500}>{l.name}</Table.Td>
              <Table.Td>{l.category}</Table.Td>
              <Table.Td ta="right">
                <Text span fw={600} c={l.isLow ? 'red' : undefined}>
                  {l.quantity} {l.unitOfMeasure}
                </Text>
              </Table.Td>
              <Table.Td ta="right">{l.lowStockThreshold || '—'}</Table.Td>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {l.lastMovement ? new Date(l.lastMovement).toLocaleString() : 'None'}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group gap="xs">
                  <Button size="compact-sm" variant="light" onClick={() => setStockInFor(l)}>
                    Stock in
                  </Button>
                  <Button size="compact-sm" variant="subtle" onClick={() => setAdjustFor(l)}>
                    Adjust
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <StockInModal
        item={stockInFor}
        onClose={() => setStockInFor(null)}
        onDone={() => {
          setStockInFor(null);
          void load();
        }}
      />
      <AdjustModal
        item={adjustFor}
        onClose={() => setAdjustFor(null)}
        onDone={() => {
          setAdjustFor(null);
          void load();
        }}
      />
    </Stack>
  );
}

function StockInModal({
  item,
  onClose,
  onDone,
}: {
  item: InventoryLevelView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (item) {
      setQty(0);
      setNotes('');
      setError(null);
    }
  }, [item]);

  async function submit() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('inventory:stockIn', {
        token: requireToken(),
        productId: item.productId,
        quantity: qty,
        notes: notes || null,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={!!item} onClose={onClose} title={`Stock in — ${item?.name ?? ''}`} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <NumberInput
          label="Quantity received"
          min={0}
          step={item?.unitOfMeasure === 'kg' ? 0.1 : 1}
          decimalScale={item?.unitOfMeasure === 'kg' ? 3 : 0}
          value={qty}
          onChange={(v) => setQty(typeof v === 'number' ? v : Number(v) || 0)}
          autoFocus
        />
        <TextInput label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={qty <= 0}>
            Add stock
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function AdjustModal({
  item,
  onClose,
  onDone,
}: {
  item: InventoryLevelView | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [qty, setQty] = useState<number>(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (item) {
      setQty(item.quantity);
      setReason('');
      setError(null);
    }
  }, [item]);

  async function submit() {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('inventory:adjust', {
        token: requireToken(),
        productId: item.productId,
        newQuantity: qty,
        reason,
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal opened={!!item} onClose={onClose} title={`Adjust stock — ${item?.name ?? ''}`} centered>
      <Stack>
        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}
        <Text c="dimmed" size="sm">
          Current: {item?.quantity} {item?.unitOfMeasure}. Enter the corrected count.
        </Text>
        <NumberInput
          label="Counted quantity"
          min={0}
          step={item?.unitOfMeasure === 'kg' ? 0.1 : 1}
          decimalScale={item?.unitOfMeasure === 'kg' ? 3 : 0}
          value={qty}
          onChange={(v) => setQty(typeof v === 'number' ? v : Number(v) || 0)}
        />
        <TextInput
          label="Reason"
          placeholder="e.g. damage, wastage, stock count correction"
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          required
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!reason.trim()}>
            Save adjustment
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
