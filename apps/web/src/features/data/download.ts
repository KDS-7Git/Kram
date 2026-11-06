export function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
const cell = (value: unknown) => {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  // eslint-disable-next-line no-control-regex -- spreadsheet readers ignore leading control characters.
  return `"${(/^[\s\u0000-\u001f]*[=+@-]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
};
export function portableCsv(snapshot: { account: unknown; tables: Record<string, unknown[]> }) {
  const lines = ['table,record,field,value'];
  for (const [table, rows] of Object.entries({ account: [snapshot.account], ...snapshot.tables })) rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    for (const [field, value] of Object.entries(row)) lines.push([table, 'id' in row ? String(row.id) : String(index), field, value].map(cell).join(','));
  });
  return `${lines.join('\r\n')}\r\n`;
}
