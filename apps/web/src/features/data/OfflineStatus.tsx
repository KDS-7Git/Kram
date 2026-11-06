import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CloudOff, Download } from 'lucide-react';
import { Banner, Button, Card, ConfirmDialog } from '../../components/ui/kit';
import { useOnline } from '../../shared/data';
import { api, errorMessage } from '../../shared/api';
import { offline, listQueued, subscribeOffline, replayProgress, type QueuedProgress } from '../../shared/offline';
import { downloadFile } from './download';

export function OfflineStatus({ compact = false }: { compact?: boolean }) {
  const online = useOnline();
  const [events, setEvents] = useState<QueuedProgress[]>([]);
  const [discarding, setDiscarding] = useState<QueuedProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState('');
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void listQueued().then(items => { if (mounted) setEvents(items); }).catch(() => { if (mounted) setIssue('Offline storage is unavailable on this browser. Reconnect to record progress.'); }); };
    refresh(); const unsubscribe = subscribeOffline(refresh);
    return () => { mounted = false; unsubscribe(); };
  }, []);
  const sync = async () => {
    setBusy(true); setIssue('');
    try { await replayProgress((taskId, input, accountId) => {
      if (offline.currentAccount() !== accountId) throw new Error('Sign in again before syncing.');
      return api(`/tasks/${taskId}/events`, { method: 'POST', body: input });
    }); } catch (error) { setIssue(errorMessage(error)); } finally { setBusy(false); }
  };
  const conflicts = events.filter(event => event.status === 'conflict');
  if (compact) return !online || events.length || issue ? <Banner tone={conflicts.length || issue ? 'warning' : 'info'} action={events.length || issue ? <Link className="button button-text" to="/settings#offline-progress">Review saved progress</Link> : undefined}>{!online ? 'Offline · progress saves on this device. Planning edits need a connection.' : `${events.length} saved events waiting to sync.`}{conflicts.length ? ` ${conflicts.length} need review.` : ''}{issue ? ` ${issue}` : ''}</Banner> : null;
  return <Card id="offline-progress"><h2><CloudOff size={22} aria-hidden="true" /> Saved offline progress</h2><p className="muted">Progress waits on this browser until you reconnect. Planning changes need a connection. Other devices will see progress after it syncs.</p>
    <p role="status">{events.length ? `${events.length} saved ${events.length === 1 ? 'event' : 'events'} · ${conflicts.length} needing review` : 'All saved progress is synced.'}</p>
    {issue && <Banner tone="error">{issue}</Banner>}
    {events.length > 0 && <div className="row" style={{ flexWrap: 'wrap' }}><Button disabled={!online || busy} loading={busy} onClick={() => void sync()}>Sync now</Button><Button onClick={() => downloadFile(`kram-unsynced-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'kram-unsynced-progress', events }, null, 2), 'application/json')}><Download size={18} /> Download saved events</Button></div>}
    {conflicts.map(event => <div key={event.key} style={{ borderTop: '1px solid var(--border)', marginTop: '1rem', paddingTop: '1rem' }}><h3>Review {event.input.kind} event</h3><p className="muted">{new Date(event.input.occurredAt).toLocaleString()}{event.input.minutes !== undefined ? ` · ${event.input.minutes} min` : ''}{event.input.qty !== undefined ? ` · quantity ${event.input.qty}` : ''}</p><p>{event.issue?.message ?? 'The task changed while this event was offline.'}</p><div className="row" style={{ flexWrap: 'wrap' }}><Link className="button button-secondary" to={`/tasks/${event.taskId}`}>Inspect task history</Link><Button disabled={!online || busy} onClick={async () => { await offline.retryConflict(event.key); await sync(); }}>Retry after resolving</Button><Button variant="text" onClick={() => setDiscarding(event)}>Discard event</Button></div></div>)}
    <ConfirmDialog open={!!discarding} onOpenChange={open => { if (!open) setDiscarding(null); }} title="Discard this saved event?" description="This removes unsynced progress from this browser. Download it first if you want to keep a copy. Recorded server history is unchanged."><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}><Button onClick={() => setDiscarding(null)}>Keep event</Button><Button variant="destructive" onClick={async () => { if (discarding) await offline.discardEvent(discarding.key, true); setDiscarding(null); }}>Discard saved event</Button></div></ConfirmDialog>
  </Card>;
}
