/** Stored reviews own uncertainty; a task's current flag cannot rewrite earlier days. */
export function unreportedReviewTasks(summary: unknown): string[] | null {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const value = summary as Record<string, unknown>;
  if (Array.isArray(value.unreportedTaskIds)) return value.unreportedTaskIds.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(value.decisions)) return value.decisions.flatMap(decision => {
    if (!decision || typeof decision !== 'object') return [];
    const item = decision as Record<string, unknown>;
    return item.decision === 'unreported' && typeof item.taskId === 'string' ? [item.taskId] : [];
  });
  return null;
}
export function storedProgressUnit(rules: unknown, fallback: string): string {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return fallback;
  const unit = (rules as Record<string, unknown>).unit;
  return typeof unit === 'string' && unit.trim() ? unit : fallback;
}
