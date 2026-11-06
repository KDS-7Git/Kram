import {
  Children,
  createContext,
  useContext,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useState,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  type InputHTMLAttributes,
} from "react";
import { TemporalControl } from "./TemporalControl";
import { SelectControl } from "./SelectControl";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CircleDashed,
  Clock3,
  FastForward,
  HelpCircle,
  Play,
  Minus,
  Plus,
  X,
} from "lucide-react";
import { clsx } from "clsx";

const DialogDismissContext = createContext<(() => void) | null>(null);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "text" | "destructive";
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", loading, className, children, disabled, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        className={clsx("button", `button-${variant}`, className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        <span className={clsx("button-label", loading && "button-label-loading")}>{children}</span>
        {loading && <span className="button-loading-dots" aria-hidden="true"><i /><i /><i /></span>}
      </button>
    );
  },
);

export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }
>(function IconButton({ label, className, children, ...props }, ref) {
  const dismissDialog = useContext(DialogDismissContext);
  return (
    <TooltipPrimitive.Provider delayDuration={400}><TooltipPrimitive.Root><TooltipPrimitive.Trigger asChild>
    <button
      ref={ref}
      type="button"
      className={clsx("button button-text button-icon", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
    </TooltipPrimitive.Trigger><TooltipPrimitive.Portal><TooltipPrimitive.Content className="kit-tooltip" sideOffset={6} onEscapeKeyDown={event => { if (dismissDialog) { event.preventDefault(); dismissDialog(); } }}>{label}</TooltipPrimitive.Content></TooltipPrimitive.Portal></TooltipPrimitive.Root></TooltipPrimitive.Provider>
  );
});

export function Card({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <section className={clsx("card", className)} {...props}>
      {children}
    </section>
  );
}
export function PageHeader({
  title,
  eyebrow,
  description,
  action,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {action}
    </header>
  );
}
export function Field({
  label,
  id,
  hint,
  error,
  children,
}: {
  label: string;
  id: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const controls = Children.map(children, (child) => {
    if (
      !isValidElement(child) ||
      typeof child.type !== "string" ||
      !["input", "select", "textarea"].includes(child.type)
    )
      return child;
    const element = child as ReactElement<{
      "aria-describedby"?: string;
      "aria-invalid"?: boolean;
    }>;
    const describedBy = [
      ...new Set(
        [
          element.props["aria-describedby"],
          hint ? `${id}-hint` : undefined,
          error ? `${id}-error` : undefined,
        ].filter(Boolean),
      ),
    ].join(" ");
    const control = cloneElement(element, {
      "aria-describedby": describedBy || undefined,
      "aria-invalid": error ? true : element.props["aria-invalid"],
    });
    if (child.type === "input" && ["date", "time"].includes((child.props as InputHTMLAttributes<HTMLInputElement>).type || "")) {
      return <TemporalControl input={control as ReactElement<InputHTMLAttributes<HTMLInputElement>>} label={label} />;
    }
    if (child.type === "select") return (child.props as { multiple?: boolean }).multiple ? control : <SelectControl select={control} label={label} />;
    return control;
  });
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {controls}
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
export function Banner({
  children,
  tone = "neutral",
  action,
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "warning" | "error";
  action?: ReactNode;
}) {
  return (
    <div
      className={clsx("banner", `banner-${tone}`)}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={20} strokeWidth={1.5} aria-hidden="true" />
      <div style={{ flex: 1 }}>{children}</div>
      {action}
    </div>
  );
}

const labels: Record<string, string> = {
  pending: "To do",
  queued: "Queued",
  in_progress: "In progress",
  partial: "Partial",
  completed: "Done",
  skipped: "Skipped",
  deferred: "Deferred",
  cancelled: "Cancelled",
  overdue: "Overdue",
  unverified: "Not reported",
  proposed: "Proposed",
  at_risk: "At risk",
  active: "Active",
  paused: "Paused",
  met: "Met",
  missed: "Missed",
  rest: "Rest",
  grace: "Grace",
  sent: "Accepted by channel",
  failed: "Failed",
  suppressed_quiet_hours: "Quiet hours",
  accepted: "Accepted",
  discarded: "Discarded",
  archived: "Archived",
};
function StatusGlyph({ status }: { status: string }) {
  if (status === "in_progress")
    return (
      <Play
        size={15}
        strokeWidth={1.5}
        fill="currentColor"
        aria-hidden="true"
      />
    );
  if (status === "deferred")
    return <Clock3 size={16} strokeWidth={1.5} aria-hidden="true" />;
  if (status === "skipped")
    return <FastForward size={16} strokeWidth={1.5} aria-hidden="true" />;
  if (status === "unverified" || status === "proposed")
    return <CircleDashed size={16} strokeWidth={1.5} aria-hidden="true" />;
  if (status === "overdue" || status === "at_risk" || status === "failed")
    return <AlertCircle size={16} strokeWidth={1.5} aria-hidden="true" />;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      {status === "completed" || status === "met" || status === "sent" ? (
        <path
          d="m4.4 8 2.3 2.4 4.9-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ) : status === "partial" ? (
        <path d="M8 1.75a6.25 6.25 0 0 0 0 12.5Z" fill="currentColor" />
      ) : status === "cancelled" || status === "missed" ? (
        <path
          d="m5.5 5.5 5 5m0-5-5 5"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ) : null}
    </svg>
  );
}
export function StatusPill({
  status,
  detail,
}: {
  status: string;
  detail?: string;
}) {
  return (
    <span className={clsx("status", `status-${status}`)}>
      <StatusGlyph status={status} />
      <span className="status-label">
        {labels[status] || status.replaceAll("_", " ")}
        {detail && ` · ${detail}`}
      </span>
    </span>
  );
}
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon || <HelpCircle strokeWidth={1} aria-hidden="true" />}
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Skeleton({ height = 90 }: { height?: number }) {
  return (
    <div
      className="skeleton"
      style={{ height }}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading</span>
    </div>
  );
}
export function DelayedSkeleton({ height = 90 }: { height?: number }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <Skeleton height={height} />
  ) : (
    <span className="sr-only" role="status">
      Loading
    </span>
  );
}
export function Segments<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
function useDialogFocusReturn() {
  const origin = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = origin.current?.isConnected ? origin.current : document.getElementById("main-content");
      if (target) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    },
  };
}

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  modal = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  modal?: boolean;
}) {
  const focusReturn = useDialogFocusReturn();
  return (
    <DialogDismissContext.Provider value={() => onOpenChange(false)}><DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog-content sheet-content" {...focusReturn}>
          <button type="button" className="sheet-grab" aria-label="Dismiss panel" onClick={() => onOpenChange(false)} onPointerDown={event => { event.currentTarget.dataset.startY = String(event.clientY); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerUp={event => { if (event.clientY - Number(event.currentTarget.dataset.startY) > 70) onOpenChange(false); }}><span /></button>
          <DialogPrimitive.Title className="dialog-title">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">
            {description || "View details and choose the next step."}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close asChild>
            <IconButton label="Close panel" className="dialog-close">
              <X size={20} strokeWidth={1.5} />
            </IconButton>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root></DialogDismissContext.Provider>
  );
}
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const focusReturn = useDialogFocusReturn();
  return (
    <DialogDismissContext.Provider value={() => onOpenChange(false)}><DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog-content" {...focusReturn}>
          <DialogPrimitive.Title className="dialog-title">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="dialog-description">
            {description}
          </DialogPrimitive.Description>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root></DialogDismissContext.Provider>
  );
}


export function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <label className="kit-toggle"><input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span className="toggle-track" aria-hidden="true"><i /></span><span>{label}</span><span className="caption">{checked ? 'On' : 'Off'}</span></label>;
}
export function ProfileChip({ label, color, selected, onClick }: { label: string; color: string; selected: boolean; onClick: () => void }) {
  return <button type="button" className="profile-chip" aria-pressed={selected} onClick={onClick}><i className="profile-dot" style={{ background: `var(--profile-${color})` }} aria-hidden="true" />{label}</button>;
}
export function parseDuration(value: string) {
  const input = value.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(input)) return Number(input);
  const hours = /^(\d+)\s*h(?:\s*(\d+)(?:\s*m(?:in)?)?)?$/.exec(input);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] || 0);
  const minutes = /^(\d+(?:\.\d+)?)\s*m(?:in)?$/.exec(input);
  return minutes ? Number(minutes[1]) : NaN;
}
export function DurationStepper({ id, label, value, onChange, min = 0, max = 1440, disabled = false, describedBy, invalid }: { id: string; label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; disabled?: boolean; describedBy?: string; invalid?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const timers = useRef<{ delay?: ReturnType<typeof setTimeout>; repeat?: ReturnType<typeof setInterval>; repeated: boolean }>({ repeated: false });
  const latest = useRef({ value, onChange }); latest.current = { value, onChange };
  const stop = () => { clearTimeout(timers.current.delay); clearInterval(timers.current.repeat); };
  useEffect(() => () => stop(), []);
  useEffect(() => { if (Number.isFinite(value)) setDraft(current => parseDuration(current) === value ? current : String(value)); }, [value]);
  const step = (delta: number) => latest.current.onChange(Math.min(max, Math.max(min, (Number.isFinite(latest.current.value) ? latest.current.value : min) + delta)));
  const controls = (delta: number) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => { timers.current.repeated = false; event.currentTarget.setPointerCapture(event.pointerId); timers.current.delay = setTimeout(() => { timers.current.repeated = true; step(delta); timers.current.repeat = setInterval(() => step(delta), 100); }, 400); },
    onPointerUp: stop, onPointerCancel: stop, onBlur: stop,
    onClick: () => { if (!timers.current.repeated) step(delta); timers.current.repeated = false; },
  });
  return <div className="duration-stepper">
    <IconButton label={`Decrease ${label.toLowerCase()}`} disabled={disabled || value <= min} {...controls(-5)}><Minus size={18} strokeWidth={1.5} /></IconButton>
    <input id={id} className="input" inputMode="decimal" value={draft} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={event => { setDraft(event.target.value); onChange(parseDuration(event.target.value)); }} onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); step(event.key === 'ArrowUp' ? 5 : -5); } }} />
    <IconButton label={`Increase ${label.toLowerCase()}`} disabled={disabled || value >= max} {...controls(5)}><Plus size={18} strokeWidth={1.5} /></IconButton>
  </div>;
}
