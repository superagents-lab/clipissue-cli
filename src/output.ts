/**
 * Output helpers: JSON output for agents, human table for terminals.
 */

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

export function jsonOut(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function tableOut<T>(rows: T[], columns: TableColumn<T>[]): string {
  const cells = rows.map((row) => columns.map((col) => String(col.value(row) ?? '')));
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  const line = (parts: string[]): string =>
    parts.map((p, i) => p.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  const out: string[] = [line(columns.map((c) => c.header))];
  out.push(line(widths.map((w) => '-'.repeat(w))));
  for (const row of cells) out.push(line(row));
  return out.join('\n');
}
