import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { DeletionKind, DeletionPreview, DeletionResult } from '@kram/shared';
import { Banner, Button, ConfirmDialog, DelayedSkeleton } from './ui/kit';
import { api, errorMessage } from '../shared/api';
import { useOnline, useRefresh } from '../shared/data';
import { offline } from '../shared/offline';
import { useUI } from '../shared/ui';

const labels: Record<DeletionKind, string> = { goal: 'Delete goal', 'goal-history': 'Delete progress history', schedule: 'Delete schedule', template: 'Delete template' };
const descriptions: Record<DeletionKind, string> = {
  goal: 'Permanently remove this goal and its tasks, progress, rules and linked timetable records from the planner. Linked resources remain in your library. This cannot be undone.',
  'goal-history': 'Permanently remove this goal’s recorded progress, timer actions and corrections. Its tasks return to pending with zero progress. This cannot be undone.',
  schedule: 'Permanently remove this repeating schedule and its past and future blocks, including its makeup meetings. This cannot be undone.',
  template: 'Permanently remove this template and its application records. Blocks already placed in the timetable stay independent. This cannot be undone.',
};

export function DeleteButton({ kind, id, title, onDeleted }: { kind: DeletionKind; id: string; title: string; onDeleted?: () => void }) {
  const [open, setOpen] = useState(false), online = useOnline(), refresh = useRefresh(), client = useQueryClient(), { toast } = useUI();
  const preview = useQuery({ queryKey: ['deletion', kind, id], queryFn: () => api<DeletionPreview>(`/deletions/${kind}/${id}`), enabled: open && online, staleTime: 0 });
  const queued = useQuery({ queryKey: ['offline', 'deletion', kind, id, preview.data?.token], queryFn: async () => (await offline.listQueued()).filter(event => preview.data?.taskIds.includes(event.taskId)).length, enabled: open && !!preview.data });
  const remove = useMutation({ mutationFn: async () => {
    const current = preview.data!;
    const resume = await offline.pauseTaskReplay(current.taskIds);
    try {
      const result = await api<DeletionResult>(`/deletions/${kind}/${id}`, { method: 'DELETE', body: { token: current.token } });
      await offline.forgetTasks(result.taskIds);
      return result;
    } finally { resume(); }
  }, onSuccess: async () => {
    setOpen(false); onDeleted?.();
    const targets = new Set([id, ...(preview.data?.taskIds || [])]);
    client.removeQueries({ predicate: query => !query.isActive() && query.queryKey.some(part => typeof part === 'string' && targets.has(part)) });
    await refresh(); toast(kind === 'goal-history' ? 'Progress history deleted. Tasks reset to pending.' : `${kind === 'goal' ? 'Goal' : kind === 'schedule' ? 'Schedule' : 'Template'} permanently deleted.`);
  }, onError: error => { if ('code' in error && error.code === 'DELETION_CHANGED') void preview.refetch(); } });
  return <>
    <Button variant="destructive" disabled={!online} onClick={() => { remove.reset(); setOpen(true); }}><Trash2 size={17} />{labels[kind]}</Button>
    <ConfirmDialog open={open} onOpenChange={value => { if (!remove.isPending) setOpen(value); }} title={`${labels[kind]}: ${preview.data?.title || title}?`} description={descriptions[kind]}>
      <div className="stack-lg">
        {preview.isPending ? <DelayedSkeleton height={100} /> : preview.isError ? <Banner tone="error" action={<Button onClick={() => void preview.refetch()}>Retry preview</Button>}>{errorMessage(preview.error)}</Banner> : <>
          <ul className="deletion-counts">{preview.data?.counts.map(row => <li key={row.label}><span>{row.label}</span><strong>{row.count}</strong></li>)}</ul>
          {!!queued.data && <p>{queued.data} unsynced progress entries for these tasks will also be removed from this browser.</p>}
        </>}
        {remove.isError && <Banner tone="error">{errorMessage(remove.error)}</Banner>}
        <div className="row wrap"><Button onClick={() => setOpen(false)} disabled={remove.isPending}>Cancel</Button><Button variant="destructive" disabled={!online || !preview.data || preview.isFetching || preview.isError || queued.isPending} loading={remove.isPending} onClick={() => remove.mutate()}>Permanently delete</Button></div>
      </div>
    </ConfirmDialog>
  </>;
}
