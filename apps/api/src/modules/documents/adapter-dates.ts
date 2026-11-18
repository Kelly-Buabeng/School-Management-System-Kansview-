// Owner: Agent F.
/** '2026-11-18' + 14 → '2026-12-02' (calendar arithmetic in UTC, no timezone shifting). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
