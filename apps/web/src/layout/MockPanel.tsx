import { Affix, Paper, SegmentedControl, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { mockControl, type FlakeMode } from '@/mocks/control';

/** Demo-only network simulator (mock mode). Lets trainers show what happens on bad internet. */
export default function MockPanel() {
  const [mode, setMode] = useState<FlakeMode>(mockControl.mode);
  const [open, setOpen] = useState(false);
  useEffect(() => mockControl.subscribe(setMode), []);
  return (
    <Affix position={{ bottom: 90, left: 8 }} className="no-print">
      <Paper withBorder shadow="sm" p={6} maw={340}>
        <Text size="xs" fw={700} style={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)} aria-expanded={open}>
          Demo network: {mode === 'normal' ? 'working' : mode} {open ? '▾' : '▸'}
        </Text>
        {open && (
          <SegmentedControl
            mt={4}
            size="xs"
            orientation="vertical"
            fullWidth
            value={mode}
            onChange={(v) => mockControl.setMode(v as FlakeMode)}
            data={[
              { value: 'normal', label: 'Working' },
              { value: 'slow', label: 'Very slow' },
              { value: 'lose-next-save', label: 'Lose reply to next save' },
              { value: 'offline', label: 'Offline' },
            ]}
            aria-label="Demo network behaviour"
          />
        )}
      </Paper>
    </Affix>
  );
}
