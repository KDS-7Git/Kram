import { clientId } from "../../shared/id";
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Link2, Send } from 'lucide-react';
import { Banner, Button, Card, DelayedSkeleton, Field, Toggle } from '../../components/ui/kit';
import { api, errorMessage } from '../../shared/api';
import { useData, useOnline } from '../../shared/data';
import { useUI } from '../../shared/ui';
import './streaks.css';
type Channel = { id: 'ntfy' | 'telegram'; configured: boolean; linked: boolean; enabled: boolean; privacy: boolean; linking?: boolean; lastSentAt?: string | null };
type Route = { profileId: string | null; type: string; channels: string[]; topic: string | null };
type Routing = { defaults: Record<string, string[]>; routes: Route[] };
const names: Record<string, string> = { plan_ready: 'Plan ready', upcoming: 'Upcoming activity', task_reminder: 'Task reminder', deadline: 'Deadline', overdue: 'Overdue work', daily_review: 'Daily review', weekly_review: 'Weekly review', streak_at_risk: 'Streak at risk', schedule_changed: 'Schedule changed', feasibility_warning: 'Goal needs a review', backup_failed: 'Backup failed', worker_unhealthy: 'Worker needs attention', healthcheck_report: 'Instance health report' };
export function ChannelSettings() {
  const query = useQueryClient(), online = useOnline(), data = useData(), { toast } = useUI();
  const [profile, setProfile] = useState('');
  const channels = useQuery({ queryKey: ['channels', profile], queryFn: () => api<Channel[]>(profile ? `/channels?profileId=${encodeURIComponent(profile)}` : '/channels'), refetchInterval: 10000 });
  const routing = useQuery({ queryKey: ['notification-routes'], queryFn: () => api<Routing>('/notification-routes') });
  const invalidate = async () => { await Promise.all([query.invalidateQueries({ queryKey: ['channels'] }), query.invalidateQueries({ queryKey: ['notification-routes'] }), query.invalidateQueries({ queryKey: ['notifications'] })]); };
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<Channel> }) => api(`/channels/${id}`, { method: 'PATCH', body }), onMutate: ({ id, body }) => { const previous = query.getQueryData<Channel[]>(['channels', profile]); query.setQueryData<Channel[]>(['channels', profile], rows => rows?.map(row => row.id === id ? { ...row, ...body } : row)); return previous; }, onSuccess: async () => { await invalidate(); }, onError: (error, _variables, previous) => { query.setQueryData(['channels', profile], previous); toast(errorMessage(error), undefined, 'error'); } });
  const test = useMutation({ mutationFn: (id: string) => api(`/channels/${id}/test`, { method: 'POST', body: {} }), onSuccess: async () => { await invalidate(); toast('Test queued. Check the delivery history and your receiving device.'); }, onError: error => toast(errorMessage(error), undefined, 'error') });
  return <div className="stack-lg workspace-page channels-workspace">
    <Card>
      <h2>Delivery channels</h2>
      <p className="muted">Choose where reminders go. Telegram is optional and uses private text by default.</p>
      <p className="caption">Accepted means the provider received a message; check your receiving device to confirm arrival.</p>
      {!data.user.settings.notificationsEnabled && <Banner>General reminders are turned off in Settings. Channel tests are still available.</Banner>}
      {channels.isPending ? <DelayedSkeleton height={180} /> : channels.isError ? (
        <Banner tone="error">{errorMessage(channels.error)} <Button variant="text" onClick={() => void channels.refetch()}>Retry channels</Button></Banner>
      ) : <div className="channel-grid">
        {channels.data?.map(channel => <article key={channel.id} className="channel-preference">
          <div className="channel-header row between">
            <h3><Bell size={18} strokeWidth={1.5} aria-hidden="true" /> {channel.id === 'ntfy' ? 'ntfy' : 'Telegram'}</h3>
            <Button disabled={!online || !channel.linked} loading={test.isPending && test.variables === channel.id} onClick={() => test.mutate(channel.id)}><Send size={16} strokeWidth={1.5} />Send test</Button>
          </div>
          <div className="channel-body stack">
            <p className="caption">{channel.linked ? channel.id === 'telegram' ? 'Private chat linked.' : 'Protected topic configured.' : channel.id === 'telegram' ? 'Link your private chat to receive messages.' : 'Configure the protected server and topic for this instance.'}</p>
            <p className="caption">{channel.lastSentAt ? `Last accepted ${new Date(channel.lastSentAt).toLocaleString(undefined, { timeZone: data.user.settings.timezone })}${profile ? ' for this profile' : ''}.` : profile ? 'No accepted messages for this profile yet.' : 'No accepted messages yet.'}</p>
            <Toggle label={`${channel.id === 'ntfy' ? 'ntfy' : 'Telegram'} delivery`} checked={channel.enabled} disabled={!online || !channel.linked || update.isPending} onChange={enabled => update.mutate({ id: channel.id, body: { enabled } })} />
            <Toggle label="Private lock-screen text" checked={channel.privacy} disabled={!online || !channel.configured || update.isPending} onChange={privacy => update.mutate({ id: channel.id, body: { privacy } })} />
            <div className="notification-preview">
              <p className="caption">Message preview</p>
              <strong>{channel.privacy || data.user.settings.notificationPrivacy ? 'Kram reminder' : 'A chapter to study'}</strong>
              <p>{channel.privacy || data.user.settings.notificationPrivacy ? 'You have a scheduled reminder. Open Kram for details.' : 'Open Kram to review your scheduled work.'}</p>
            </div>
          </div>
          <div className="channel-actions">
            {channel.id === 'telegram' ? <TelegramLink channel={channel} onChange={invalidate} /> : <Link className="button" to="/notifications">Topic and delivery history</Link>}
          </div>
        </article>)}
      </div>}
    </Card>
    <Card><h2>Routing by reminder type</h2><p className="muted">Profile choices override your general routes. Each selected channel receives its own message.</p><Field id="routing-profile" label="Apply these routes to"><select className="input" id="routing-profile" value={profile} onChange={event => setProfile(event.target.value)}><option value="">All profiles by default</option>{data.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></Field>{routing.isPending ? <DelayedSkeleton height={280} /> : routing.isError ? <Banner tone="error">{errorMessage(routing.error)} <Button variant="text" onClick={() => void routing.refetch()}>Retry routing</Button></Banner> : routing.data && <RoutingEditor key={profile} profileId={profile || null} routing={routing.data} onDone={invalidate} />}</Card>
  </div>;
}
function TelegramLink({ channel, onChange }: { channel: Channel; onChange: () => Promise<void> }) {
  const online = useOnline(), { toast } = useUI(), [token, setToken] = useState('');
  const link = useMutation({ mutationFn: () => api<{ command: string; expiresAt: string }>('/channels/telegram/link-code', { method: 'POST', body: { token } }), onSuccess: async () => { setToken(''); await onChange(); } });
  const unlink = useMutation({ mutationFn: () => api('/channels/telegram', { method: 'DELETE' }), onSuccess: async () => { await onChange(); toast('Telegram disconnected. Delivery history stays available.'); } });
  return <details className="disclosure"><summary><Link2 size={16} strokeWidth={1.5} />{channel.linked ? 'Manage private chat' : 'Link Telegram'}</summary><p>Create a bot with Telegram’s BotFather, then enter its token here. Send the one-time command to that bot in your private chat.</p><p className="caption">Telegram messages pass through Telegram’s servers. Your bot token and linked chat are encrypted on this instance.</p><form className="stack" onSubmit={event => { event.preventDefault(); link.mutate(); }}><Field id="telegram-token" label="Bot token"><input className="input" id="telegram-token" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} /></Field><Button type="submit" disabled={!online || !token.trim()} loading={link.isPending}>{channel.linked ? 'Create a new link code' : 'Create link code'}</Button></form>{link.data && <div className="stack"><Field id="telegram-command" label="Send this command to your bot" hint="It expires after ten minutes and can be used once."><input className="input" id="telegram-command" readOnly value={link.data.command} onFocus={event => event.target.select()} /></Field><p className="caption">The linked status will update after the worker processes your message.</p></div>}{link.isError && <Banner tone="error">{errorMessage(link.error)}</Banner>}{channel.linked && <Button disabled={!online} loading={unlink.isPending} onClick={() => unlink.mutate()}>Disconnect Telegram</Button>}{unlink.isError && <Banner tone="error">{errorMessage(unlink.error)}</Banner>}</details>;
}
function RoutingEditor({ profileId, routing, onDone }: { profileId: string | null; routing: Routing; onDone: () => Promise<void> }) {
  const online = useOnline(), { toast } = useUI();
  const [choices, setChoices] = useState<Record<string, string[]>>(Object.fromEntries(Object.keys(names).map(type => [type, routing.routes.find(route => route.type === type && route.profileId === profileId)?.channels ?? routing.routes.find(route => route.type === type && route.profileId === null)?.channels ?? routing.defaults[type] ?? ['ntfy']])));
  const [topic, setTopic] = useState(routing.routes.find(route => route.profileId === profileId && route.topic)?.topic ?? '');
  const save = useMutation({ mutationFn: async () => { for (const [type, channels] of Object.entries(choices)) await api('/notification-routes', { method: 'PUT', body: { profileId, type, channels, topic: topic.trim() || null } }); }, onSuccess: async () => { await onDone(); toast('Routing saved. Linked, enabled channels will receive these reminders.'); } });
  return <form className="stack-lg" onSubmit={event => { event.preventDefault(); save.mutate(); }}><div className="routing-matrix" role="group" aria-label="Reminder channels">{Object.entries(names).map(([type, name]) => <fieldset key={type}><legend>{name}</legend>{['ntfy', 'telegram'].map(channel => <label key={channel}><input type="checkbox" checked={choices[type]?.includes(channel) ?? false} onChange={event => setChoices({ ...choices, [type]: event.target.checked ? [...choices[type] ?? [], channel] : (choices[type] ?? []).filter(value => value !== channel) })} />{channel === 'ntfy' ? 'ntfy' : 'Telegram'}</label>)}</fieldset>)}</div><Field id="routing-topic" label={profileId ? 'ntfy topic for this profile (optional)' : 'Default ntfy topic override (optional)'} hint="Leave blank for the configured topic. A separate protected topic lets the phone mute this profile independently."><input className="input" id="routing-topic" value={topic} spellCheck={false} onChange={event => setTopic(event.target.value)} /></Field><Button disabled={!online} onClick={() => setTopic(`kram-${clientId().replaceAll('-', '')}`)}>Generate a private topic name</Button><p className="caption">Subscribe to a new topic in the ntfy app and grant its access using your ntfy account. An unlinked or disabled channel does not send.</p>{save.isError && <Banner tone="error">{errorMessage(save.error)}</Banner>}<Button variant="primary" type="submit" disabled={!online} loading={save.isPending}>Save routing</Button></form>;
}
