import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldCheck } from 'lucide-react';
import type { RecoveryHealth } from '../../../../api/src/data/health';
import type { PortableExport } from '../../../../api/src/data/export';
import { Banner, Button, Card, DelayedSkeleton, PageHeader } from '../../components/ui/kit';
import { api, errorMessage } from '../../shared/api';
import { useOnline } from '../../shared/data';
import { clientId } from '../../shared/id';
import { OfflineStatus } from './OfflineStatus';
import { downloadFile, portableCsv } from './download';

export function DataRecovery({ embedded = false }: { embedded?: boolean }) {
  const online = useOnline();
  const health = useQuery({ queryKey: ['recovery-health'], queryFn: () => api<RecoveryHealth>('/data/health'), enabled: online, refetchInterval: 60_000 });
  const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);
  const [issue, setIssue] = useState('');
  const backupId = useRef<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const queueBackup = async () => {
    setBackupBusy(true); setBackupMessage('');
    backupId.current ??= clientId();
    try { await api('/backup/run', { method: 'POST', body: { clientEventId: backupId.current } }); backupId.current = null; setBackupMessage('Backup queued. The worker will update recovery health when it finishes.'); }
    catch (error) { setBackupMessage(errorMessage(error)); } finally { setBackupBusy(false); }
  };
  const exportData = async (format: 'json' | 'csv') => {
    setExporting(format); setIssue('');
    try {
      const snapshot = await api<PortableExport>('/export', { method: 'POST', body: { format: 'json' } });
      downloadFile(`kram-export-${snapshot.exportedAt.slice(0, 10)}.${format}`, format === 'json' ? JSON.stringify(snapshot, null, 2) : portableCsv(snapshot), format === 'json' ? 'application/json' : 'text/csv;charset=utf-8');
    } catch (error) { setIssue(errorMessage(error)); } finally { setExporting(null); }
  };
  return <>{!embedded && <PageHeader eyebrow="Settings" title="Your data, kept recoverable" description="Export your history, inspect recovery health, and review progress waiting on this device." />}
    <div style={{ display: 'grid', gap: '1.5rem', marginBlock: '1.5rem' }}>
      <Card><h2><Download size={22} aria-hidden="true" /> Export your data</h2><p className="muted">Includes archived work, progress history, plans, reviews and settings. JSON preserves structured data; CSV uses one row for each field. Credentials are excluded.</p><div className="row" style={{ flexWrap: 'wrap' }}><Button disabled={!online || exporting !== null} loading={exporting === 'json'} onClick={() => void exportData('json')}>Download JSON</Button><Button disabled={!online || exporting !== null} loading={exporting === 'csv'} onClick={() => void exportData('csv')}>Download CSV</Button></div>{issue && <Banner tone="error">{issue}</Banner>}</Card>
      <OfflineStatus />
      <Card><h2><ShieldCheck size={22} aria-hidden="true" /> Recovery health</h2><p className="muted">Recovery targets: at most 24 hours of lost data and a return to service within 2 hours. A clean-machine restore confirms whether your setup meets them.</p>
        <Button disabled={!online || backupBusy} loading={backupBusy} onClick={() => void queueBackup()}>Run backup</Button>{backupMessage && <p role="status">{backupMessage}</p>}
        {!online && <Banner tone="info">Reconnect to check current recovery health.</Banner>}
        {health.isPending && online ? <DelayedSkeleton height={120} /> : health.isError ? <Banner tone="error" action={<Button onClick={() => void health.refetch()}>Retry</Button>}>{errorMessage(health.error)}</Banner> : health.data && <>
          {health.data.alerts.length > 0 && <Banner tone="warning"><ul>{health.data.alerts.map(alert => <li key={alert}>{alert}</li>)}</ul></Banner>}
          <dl>{[
            ['Last backup', health.data.backup.lastSuccessAt ? new Date(health.data.backup.lastSuccessAt).toLocaleString() : 'No successful backup recorded'],
            ['Encryption', health.data.backup.encrypted ? 'Enabled' : 'Not configured'],
            ['Off-device copy', health.data.backup.offDeviceAt ? new Date(health.data.backup.offDeviceAt).toLocaleString() : 'Not recorded'],
            ['Restore verification', health.data.backup.verifiedAt ? new Date(health.data.backup.verifiedAt).toLocaleString() : 'Not recorded'],
            ['Database size', `${Math.round(health.data.databaseBytes / 1024 / 1024 * 10) / 10} MB`],
            ['Disk used', health.data.disk ? `${health.data.disk.usedPercent}%` : 'Unavailable'],
            ['Background queue', health.data.queue ? `${health.data.queue.pending} due jobs · oldest ${Math.round(health.data.queue.lagSeconds / 60)} min` : 'Unavailable'],
          ].map(([label, value]) => <div className="row between" style={{ flexWrap: 'wrap', gap: '.5rem', paddingBlock: '.5rem' }} key={label}><dt>{label}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd></div>)}</dl>
          <details><summary className="button button-text">Recent background jobs</summary>{health.data.latestJobs.length ? health.data.latestJobs.map(job => <p key={job.jobName}>{job.jobName}: {job.status} · {new Date(job.finishedAt).toLocaleString()}</p>) : <p className="muted">No completed background jobs recorded.</p>}</details>
          <p className="muted">Checked {new Date(health.data.checkedAt).toLocaleTimeString()}</p>
        </>}
      </Card>
    </div>
  </>;
}
