const sensitive = /(?:password|passphrase|secret|token|credential|requestHash|leaseId|leaseUntil|^ip$)/i;
export function portable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(portable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive.test(key)).map(([key, child]) => [key, portable(child)]));
  if (typeof value === 'bigint') return value.toString();
  return value;
}
export interface PortableExport { format: 'kram-portable'; formatVersion: 1; exportedAt: string; account: unknown; tables: Record<string, unknown[]> }
export function csvCell(value: unknown) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  // eslint-disable-next-line no-control-regex -- spreadsheet readers ignore leading control characters.
  const guarded = /^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}
/** Long-form CSV preserves arbitrary fields and nested data without schema-specific columns. */
export function exportCsv(snapshot: PortableExport) {
  const lines = ['table,record,field,value'];
  for (const [table, rows] of Object.entries({ account: [snapshot.account], ...snapshot.tables })) rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const record = 'id' in row ? String(row.id) : String(index);
    for (const [field, value] of Object.entries(row)) lines.push([table, record, field, value].map(csvCell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}
