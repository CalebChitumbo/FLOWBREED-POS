import { Badge, Card, Group, Stack, Text, Title } from '@mantine/core';

/** Stand-in for sections delivered in later milestones. */
export function PlaceholderPage({ title, milestone, summary }: { title: string; milestone: string; summary: string }) {
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{title}</Title>
        <Badge variant="light" color="blue">
          Planned: {milestone}
        </Badge>
      </Group>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">{summary}</Text>
      </Card>
    </Stack>
  );
}
