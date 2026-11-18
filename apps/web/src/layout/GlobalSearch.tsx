import { Badge, Group, Kbd, Loader, Paper, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/api/client';
import type { SearchResults } from '@/api/types';
import { ProblemAlert } from '@/components/ProblemAlert';
import { displayPhone, money } from '@/lib/format';

interface Hit {
  key: string;
  group: string;
  label: string;
  detail: string;
  to: string;
  alert?: boolean;
}

function flatten(r: SearchResults): Hit[] {
  return [
    ...(r.students ?? []).map((s) => ({ key: `s-${s.id}`, group: 'Students', label: s.fullName ?? '', detail: [s.studentCode, s.className].filter(Boolean).join(' · '), to: `/students/${s.id}`, alert: s.hasMedicalAlert })),
    ...(r.guardians ?? []).map((g) => ({ key: `g-${g.id}`, group: 'Parents and guardians', label: g.fullName ?? '', detail: `${displayPhone(g.phone)} · ${g.childrenCount ?? 0} child(ren)`, to: `/guardians/${g.id}` })),
    ...(r.staff ?? []).map((s) => ({ key: `t-${s.id}`, group: 'Staff', label: s.fullName ?? '', detail: s.jobTitle ?? '', to: `/staff?highlight=${s.id}` })),
    ...(r.receipts ?? []).map((p) => ({ key: `r-${p.paymentId}`, group: 'Receipts', label: p.receiptNo ?? '', detail: `${p.studentName ?? ''} · ${money(p.amountPesewas)}`, to: `/finance/payments/${p.paymentId}` })),
  ];
}

/** Global search. Press "/" anywhere to jump here. Results are grouped; arrow keys + Enter to open. */
export function GlobalSearch({ autoFocus = false, shortcut = !autoFocus }: { autoFocus?: boolean; shortcut?: boolean } = {}) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced] = useDebouncedValue(value.trim(), 300);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const listId = useId();

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      const ctrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
      if (ctrlK || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shortcut]);

  const query = useQuery({
    queryKey: ['search', debounced],
    queryFn: ({ signal }) => api.get<SearchResults>('/search', { query: { q: debounced, limit: 8 }, signal }),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const hits = useMemo(() => (query.data && debounced.length >= 2 ? flatten(query.data) : []), [query.data, debounced]);
  useEffect(() => setActive(0), [debounced]);

  const go = (h: Hit) => {
    setOpen(false);
    setValue('');
    inputRef.current?.blur();
    navigate(h.to);
  };

  const showPanel = open && value.trim().length >= 2;
  let lastGroup = '';

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <TextInput
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, hits.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && hits[active]) {
            e.preventDefault();
            go(hits[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="Search name, ID, phone, class"
        autoFocus={autoFocus}
        size="md"
        aria-label="Search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-activedescendant={showPanel && hits[active] ? `${listId}-${hits[active].key}` : undefined}
        aria-autocomplete="list"
        rightSectionWidth={64}
        rightSection={query.isFetching ? <Loader size="xs" /> : <Kbd size="xs" visibleFrom="sm">Ctrl K</Kbd>}
      />
      {showPanel && (
        <Paper shadow="md" withBorder p={4} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 300, maxHeight: '70vh', overflowY: 'auto' }}>
          {query.error ? (
            <ProblemAlert error={query.error} />
          ) : (
            <Stack gap={0} id={listId} role="listbox" aria-label="Search results">
              {debounced.length < 2 || (query.isLoading && !hits.length) ? (
                <Text size="sm" c="dimmed" p="xs">
                  Searching…
                </Text>
              ) : hits.length === 0 ? (
                <Text size="sm" c="dimmed" p="xs">
                  Nothing found for “{debounced}”. Try part of the name, the student ID or a phone number.
                </Text>
              ) : (
                hits.map((h, i) => {
                  const header = h.group !== lastGroup;
                  lastGroup = h.group;
                  return (
                    <div key={h.key}>
                      {header && (
                        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="xs" pt="xs">
                          {h.group}
                        </Text>
                      )}
                      <UnstyledButton
                        id={`${listId}-${h.key}`}
                        role="option"
                        aria-selected={i === active}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => go(h)}
                        onMouseEnter={() => setActive(i)}
                        w="100%"
                        p="xs"
                        style={{ borderRadius: 6, background: i === active ? 'var(--mantine-color-blue-0)' : undefined }}
                      >
                        <Group gap="xs" wrap="nowrap">
                          <div style={{ minWidth: 0 }}>
                            <Text size="sm" fw={600} truncate>
                              {h.label}
                            </Text>
                            <Text size="xs" c="dimmed" truncate>
                              {h.detail}
                            </Text>
                          </div>
                          {h.alert && (
                            <Badge color="red" size="sm" ml="auto">
                              Medical alert
                            </Badge>
                          )}
                        </Group>
                      </UnstyledButton>
                    </div>
                  );
                })
              )}
            </Stack>
          )}
        </Paper>
      )}
    </div>
  );
}
