import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { AlertCircle, CircleDashed, Clock3, FastForward, HelpCircle, Play, X } from 'lucide-react';
import { clsx } from 'clsx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'text' | 'destructive'; loading?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', loading, className, children, disabled, ...props }, ref) {
  return <button ref={ref} type="button" className={clsx('button', `button-${variant}`, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading ? 'Saving…' : children}</button>;
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton({ label, className, children, ...props }, ref) {
  return <button ref={ref} type="button" className={clsx('button button-text button-icon', className)} aria-label={label} title={label} {...props}>{children}</button>;
});

export function Card({ className, children, ...props }: HTMLAttributes<HTMLElement>) { return <section className={clsx('card', className)} {...props}>{children}</section>; }
export function PageHeader({ title, eyebrow, description, action }: { title: string; eyebrow?: string; description?: string; action?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{action}</header>;
}
export function Field({ label, id, hint, error, children }: { label: string; id: string; hint?: string; error?: string; children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}{error && <p id={`${id}-error`} className="field-error" role="alert">{error}</p>}</div>;
}
export function Banner({ children, tone = 'neutral', action }: { children: ReactNode; tone?: 'neutral' | 'info' | 'warning' | 'error'; action?: ReactNode }) {
  return <div className={clsx('banner', `banner-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}><AlertCircle size={20} strokeWidth={1.5} aria-hidden="true"/><div style={{ flex: 1 }}>{children}</div>{action}</div>;
}

const labels: Record<string, string> = { pending: 'To do', in_progress: 'In progress', partial: 'Partial', completed: 'Done', skipped: 'Skipped', deferred: 'Deferred', cancelled: 'Cancelled', overdue: 'Overdue', unverified: 'Not reported', proposed: 'Proposed', at_risk: 'At risk', active: 'Active', paused: 'Paused', met: 'Met', missed: 'Missed', rest: 'Rest', grace: 'Grace', sent: 'Accepted by channel', failed: 'Failed', suppressed_quiet_hours: 'Quiet hours', accepted: 'Accepted', discarded: 'Discarded', archived: 'Archived' };
function StatusGlyph({ status }: { status: string }) {
  if (status === 'in_progress') return <Play size={15} strokeWidth={1.5} fill="currentColor" aria-hidden="true"/>;
  if (status === 'deferred') return <Clock3 size={16} strokeWidth={1.5} aria-hidden="true"/>;
  if (status === 'skipped') return <FastForward size={16} strokeWidth={1.5} aria-hidden="true"/>;
  if (status === 'unverified' || status === 'proposed') return <CircleDashed size={16} strokeWidth={1.5} aria-hidden="true"/>;
  if (status === 'overdue' || status === 'at_risk' || status === 'failed') return <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true"/>;
  return <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5"/>{status === 'completed' || status === 'met' || status === 'sent' ? <path d="m4.4 8 2.3 2.4 4.9-5" fill="none" stroke="currentColor" strokeWidth="1.5"/> : status === 'partial' ? <path d="M8 1.75a6.25 6.25 0 0 0 0 12.5Z" fill="currentColor"/> : status === 'cancelled' || status === 'missed' ? <path d="m5.5 5.5 5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.5"/> : null}</svg>;
}
export function StatusPill({ status, detail }: { status: string; detail?: string }) { return <span className={clsx('status', `status-${status}`)}><StatusGlyph status={status}/><span className="status-label">{labels[status] || status.replaceAll('_', ' ')}{detail && ` · ${detail}`}</span></span>; }
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state">{icon || <HelpCircle strokeWidth={1} aria-hidden="true"/>}<h2>{title}</h2><p>{children}</p>{action}</div>; }
export function Skeleton({ height = 90 }: { height?: number }) { return <div className="skeleton" style={{ height }} role="status" aria-label="Loading"><span className="sr-only">Loading</span></div>; }
export function Segments<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (value: T) => void; label: string }) { return <div className="segmented" role="group" aria-label={label}>{options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>; }
export function Sheet({ open, onOpenChange, title, description, children, modal = true }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; modal?: boolean }) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className="dialog-content sheet-content"><div className="sheet-grab"/><DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title><DialogPrimitive.Description className="dialog-description">{description || 'View details and choose the next step.'}</DialogPrimitive.Description><DialogPrimitive.Close asChild><IconButton label="Close panel" className="dialog-close"><X size={20} strokeWidth={1.5}/></IconButton></DialogPrimitive.Close>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>;
}
export function ConfirmDialog({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode }) { return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className="dialog-content"><DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title><DialogPrimitive.Description className="dialog-description">{description}</DialogPrimitive.Description>{children}</DialogPrimitive.Content></DialogPrimitive.Portal></DialogPrimitive.Root>; }
