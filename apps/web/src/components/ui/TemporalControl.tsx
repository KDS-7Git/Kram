import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type Ref,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, X } from "lucide-react";

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  ref?: Ref<HTMLInputElement>;
  "data-allow-midnight"?: boolean | string;
  "data-min-error"?: string;
};
type Kind = "date" | "time";
const dayMillis = 86_400_000;
const epoch = "1970-01-01";
const pad = (value: number) => String(value).padStart(2, "0");
const inputText = (value: InputProps["value"]) => value == null ? "" : String(value);

function dateNumber(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? Math.floor(date.getTime() / dayMillis) : null;
}
function dateFromNumber(value: number) {
  return new Date(value * dayMillis + 43_200_000).toISOString().split("T")[0]!;
}
function timeNumber(value: string, allowMidnight = false): number | null {
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [hour, minute, second = 0] = value.split(":").map(Number);
  if (allowMidnight && hour === 24 && minute === 0 && second === 0) return 86_400;
  return hour !== undefined && minute !== undefined && hour <= 23 && minute <= 59 && second <= 59
    ? hour * 3600 + minute * 60 + second : null;
}
function timeFromNumber(value: number) {
  const hours = Math.floor(value / 3600), minutes = Math.floor(value / 60) % 60, seconds = value % 60;
  return `${pad(hours)}:${pad(minutes)}${seconds ? `:${pad(seconds)}` : ""}`;
}
function localToday() {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function addMonths(value: string, delta: number) {
  const date = new Date(`${value}T12:00:00Z`), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + delta);
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return value;
  const last = new Date(date.getTime());
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return date.toISOString().slice(0, 10);
}
function constraintIssue(value: string, kind: Kind, props: InputProps) {
  if (value === "") return props.required ? `Enter a ${kind}.` : "";
  const allowMidnight = props["data-allow-midnight"] === true || props["data-allow-midnight"] === "true";
  const parse = kind === "date" ? dateNumber : (text: string) => timeNumber(text, allowMidnight);
  const number = parse(value);
  if (number === null) return kind === "date"
    ? "Enter a real date as YYYY-MM-DD, for example 2026-11-06."
    : `Enter a time as HH:mm, from 00:00 to ${allowMidnight ? "24:00 (end of this day)" : "23:59"}.`;
  const min = parse(inputText(props.min)), max = parse(inputText(props.max));
  const wrappingTime = kind === "time" && min !== null && max !== null && min > max;
  if (wrappingTime ? number < min! && number > max! :
    (min !== null && number < min) || (max !== null && number > max)) {
    if (!wrappingTime && min !== null && number < min && props["data-min-error"]) return props["data-min-error"];
    return min !== null && max !== null ? `Choose a ${kind} between ${props.min} and ${props.max}.`
      : min !== null ? `Choose ${props.min} or later.` : `Choose ${props.max} or earlier.`;
  }
  const step = props.step === "any" ? null : Number(props.step ?? (kind === "date" ? 1 : 60));
  const base = min ?? (kind === "date" ? dateNumber(epoch)! : 0);
  if (step !== null && Number.isFinite(step) && step > 0) {
    const remainder = Math.abs((number - base) / step - Math.round((number - base) / step));
    if (remainder > 1e-7) return kind === "date"
      ? `Choose a date in ${step}-day steps.`
      : `Choose a time in ${step >= 60 ? `${step / 60}-minute` : `${step}-second`} steps.`;
  }
  return "";
}

/** A real typed input with an optional token-styled picker; it preserves the caller's form registration. */
export function TemporalControl({ input, label }: { input: ReactElement<InputProps>; label?: string }) {
  const props = input.props;
  const kind: Kind = props.type === "time" ? "time" : "date";
  const allowMidnight = props["data-allow-midnight"] === true || props["data-allow-midnight"] === "true";
  const parseTime = (value: string) => timeNumber(value, allowMidnight);
  const name = label || props["aria-label"] || (kind === "date" ? "Date" : "Time");
  const controlled = props.value !== undefined;
  const nativeRef = useRef<HTMLInputElement | null>(null);
  const callerRef = props.ref;
  const [draft, setDraft] = useState(inputText(props.value ?? props.defaultValue));
  const [issue, setIssue] = useState("");
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 599px)").matches);
  const [anchor, setAnchor] = useState({ left: 16, top: 16 });
  const [month, setMonth] = useState(localToday().slice(0, 7) + "-01");
  const [focusedDate, setFocusedDate] = useState(localToday());
  const [focusedTime, setFocusedTime] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const outsideDismiss = useRef(false);
  const errorId = useId();
  const formatId = useId();
  const unavailable = props.disabled || props.readOnly;

  // Preserve the caller's ref lifecycle: RHF reattaches registration after reset.
  // A local draft render keeps the same ref; a parent registration change gets its
  // normal detach/attach cycle, without inventing a second form-value owner.
  const mergeRef = useCallback((node: HTMLInputElement | null) => {
    nativeRef.current = node;
    if (typeof callerRef === "function") callerRef(node);
    else if (callerRef) callerRef.current = node;
  }, [callerRef]);
  useEffect(() => {
    if (controlled) { setDraft(inputText(props.value)); setIssue(""); }
  }, [controlled, props.value]);
  useEffect(() => {
    const media = matchMedia("(max-width: 599px)");
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const node = nativeRef.current;
    if (!node) return;
    if (!controlled && node.value !== draft) {
      setDraft(node.value);
      if (!constraintIssue(node.value, kind, props)) setIssue("");
    }
    node.setCustomValidity(unavailable ? "" : constraintIssue(node.value, kind, props));
  });
  useEffect(() => {
    const node = nativeRef.current, form = node?.form;
    if (!node || !form) return;
    const guard = (event: Event) => {
      if (unavailable) return;
      const message = constraintIssue(node.value, kind, props);
      node.setCustomValidity(message);
      if (message) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setIssue(message);
        node.focus();
      }
    };
    const reset = () => queueMicrotask(() => {
      if (nativeRef.current !== node) return;
      const value = controlled ? inputText(props.value) : node.value;
      setDraft(value);
      setIssue("");
      node.setCustomValidity(unavailable ? "" : constraintIssue(value, kind, props));
    });
    form.addEventListener("submit", guard, true);
    form.addEventListener("reset", reset);
    return () => {
      form.removeEventListener("submit", guard, true);
      form.removeEventListener("reset", reset);
    };
  }, [controlled, kind, props, unavailable]);

  const valid = (value: string) => !constraintIssue(value, kind, { ...props, required: false });
  const commit = (value: string, close = true) => {
    const node = nativeRef.current;
    if (!node || unavailable || !valid(value)) return;
    // Bypass React's value tracker, then send its normal input event. This reaches both
    // controlled onChange handlers and react-hook-form's registered native input.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    setDraft(value);
    setIssue("");
    if (close) setOpen(false);
  };
  const changed = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setDraft(value);
    const message = constraintIssue(value, kind, props);
    event.currentTarget.setCustomValidity(message);
    if (issue) setIssue(message);
    // Partial/invalid text remains on this input. Numeric adapters must not receive it
    // and coerce it to zero; form submission is blocked until it is valid or cleared.
    if (!message) props.onChange?.(event);
  };

  const boundedDate = (value: string) => {
    const min = dateNumber(inputText(props.min)), max = dateNumber(inputText(props.max));
    const candidate = dateNumber(value) ?? dateNumber(localToday())!;
    return dateFromNumber(Math.max(min ?? candidate, Math.min(max ?? candidate, candidate)));
  };
  const openPicker = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    outsideDismiss.current = false;
    const value = nativeRef.current?.value || "";
    setDraft(value);
    const date = boundedDate(value);
    setMonth(date.slice(0, 7) + "-01");
    setFocusedDate(date);
    setFocusedTime(parseTime(value) !== null ? timeFromNumber(parseTime(value)!) : "");
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = kind === "date" ? 336 : 288;
      const height = kind === "date" ? 500 : 440;
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      setAnchor({ left: Math.max(12, Math.min(innerWidth - width - 12, rect.right - width)),
        top: below >= height || below >= above ? rect.bottom + 8 : Math.max(12, rect.top - height - 8) });
    }
  };
  const focusPicker = useCallback(() => {
    const picker = pickerRef.current;
    if (!picker?.isConnected) return;
    const selected = picker?.querySelector<HTMLButtonElement>(`[data-picker-value="${kind === "date" ? focusedDate : focusedTime}"]:not(:disabled)`)
      || picker?.querySelector<HTMLButtonElement>("[data-picker-value]:not(:disabled)");
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [kind, focusedDate, focusedTime]);
  useEffect(() => {
    if (!open) return;
    focusPicker();
    // Focus changes with the calendar/list's roving target; opening focus itself
    // is also handled after Radix has mounted its portal below.
  }, [open, focusPicker, month, phone]);

  const focusDate = (candidate: string, direction = 1) => {
    if (dateNumber(candidate) === null) return;
    let value = boundedDate(candidate);
    for (let index = 0; index < 366 && !valid(value); index++) {
      const next = dateFromNumber(dateNumber(value)! + direction);
      const bounded = boundedDate(next);
      if (bounded === value) return;
      value = bounded;
    }
    if (!valid(value)) return;
    setMonth(value.slice(0, 7) + "-01");
    setFocusedDate(value);
  };
  const dateKey = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    const number = dateNumber(value)!;
    const weekday = (new Date(number * dayMillis).getUTCDay() + 6) % 7;
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
    if (event.key in offsets) {
      event.preventDefault();
      focusDate(dateFromNumber(number + offsets[event.key]!), offsets[event.key]! < 0 ? -1 : 1);
    } else if (event.key === "PageUp" || event.key === "PageDown") {
      event.preventDefault();
      const direction = event.key === "PageUp" ? -1 : 1;
      focusDate(addMonths(value, direction * (event.shiftKey ? 12 : 1)), direction);
    }
  };
  const stepSeconds = props.step === "any" ? 60 : Math.max(1, Number(props.step ?? 60) || 60);
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const listStep = Number.isInteger(stepSeconds) ? 300 * stepSeconds / gcd(300, stepSeconds) : 300;
  const timeBase = parseTime(inputText(props.min)) ?? 0;
  const times: string[] = [];
  if (kind === "time") {
    for (let seconds = timeBase % listStep; seconds <= (allowMidnight ? 86_400 : 86_399); seconds += listStep) {
      const value = timeFromNumber(seconds);
      if (valid(value)) times.push(value);
    }
    if (parseTime(draft) !== null && valid(draft) && !times.some(time => parseTime(time) === parseTime(draft))) times.push(draft);
    times.sort((a, b) => parseTime(a)! - parseTime(b)!);
  }
  const timeKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const positions: Record<string, number> = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: times.length - 1, PageUp: index - 12, PageDown: index + 12 };
    if (event.key in positions) {
      event.preventDefault();
      setFocusedTime(times[Math.max(0, Math.min(times.length - 1, positions[event.key]!))] || "");
    }
  };
  const typedKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      if (!unavailable) openPicker(true);
    } else if (kind === "time" && !unavailable && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const value = event.currentTarget.value;
      const seconds = parseTime(value);
      if (seconds === null) { setIssue(constraintIssue(value, kind, { ...props, required: true })); return; }
      const direction = event.key === "ArrowUp" ? 1 : -1;
      const next = seconds + direction * listStep;
      if (next >= 0 && next <= (allowMidnight ? 86_400 : 86_399) && valid(timeFromNumber(next))) commit(timeFromNumber(next), false);
    } else props.onKeyDown?.(event);
  };
  const monthNumber = dateNumber(month)!;
  const monthWeekday = (new Date(monthNumber * dayMillis).getUTCDay() + 6) % 7;
  const dates = kind === "date" ? Array.from({ length: 42 }, (_, index) => dateFromNumber(monthNumber - monthWeekday + index)) : [];
  const monthTitle = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}T12:00:00Z`));
  const monthAvailable = (candidate: string) => {
    if (candidate === month) return false;
    const first = dateNumber(candidate);
    if (first === null) return false;
    return Array.from({ length: 31 }, (_, index) => dateFromNumber(first + index))
      .some(date => date.startsWith(candidate.slice(0, 7)) && valid(date));
  };
  const inputError = props["aria-invalid"] === true || props["aria-invalid"] === "true";
  const describedBy = [props["aria-describedby"], formatId, issue ? errorId : undefined].filter(Boolean).join(" ");

  return <div className={`temporal-control temporal-${kind}`}>
    <div className="temporal-input-frame">
      {cloneElement(input, {
        ref: mergeRef,
        type: "text",
        inputMode: "text",
        placeholder: props.placeholder || (kind === "date" ? "YYYY-MM-DD" : "HH:mm"),
        className: `${props.className || "input"} temporal-input`,
        ...(controlled ? { value: draft, defaultValue: undefined } : {}),
        onChange: changed,
        onKeyDown: typedKey,
        onBlur: event => {
          setIssue(unavailable ? "" : constraintIssue(event.currentTarget.value, kind, props));
          props.onBlur?.(event);
        },
        onInvalid: event => {
          event.preventDefault();
          setIssue(constraintIssue(event.currentTarget.value, kind, props));
          if (event.currentTarget.form?.querySelector("input:invalid") === event.currentTarget) event.currentTarget.focus();
          props.onInvalid?.(event);
        },
        "aria-describedby": describedBy || undefined,
        "aria-invalid": issue || inputError ? true : undefined,
      })}
      <Dialog.Root open={open} onOpenChange={openPicker} modal={phone}>
        <Dialog.Trigger asChild>
          <button ref={triggerRef} type="button" className="temporal-trigger" disabled={unavailable}
            aria-label={`Choose ${name}`} title={`Choose ${name}`}>
            {kind === "date" ? <CalendarDays size={20} strokeWidth={1.5} /> : <Clock3 size={20} strokeWidth={1.5} />}
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          {phone && <Dialog.Overlay className="temporal-overlay" />}
          <Dialog.Content ref={pickerRef} className={`temporal-picker temporal-${kind}-picker ${phone ? "temporal-sheet" : "temporal-popover"}`}
            style={phone ? undefined : { left: anchor.left, top: anchor.top, maxHeight: `calc(100dvh - ${anchor.top + 12}px)` }}
            onOpenAutoFocus={event => { event.preventDefault(); focusPicker(); }}
            onPointerDownOutside={() => { outsideDismiss.current = true; }}
            onFocusOutside={() => { outsideDismiss.current = true; }}
            onCloseAutoFocus={event => {
              event.preventDefault();
              if (outsideDismiss.current && !phone) return;
              nativeRef.current?.focus({ preventScroll: true });
            }}>
            <div className="temporal-picker-heading">
              <Dialog.Title className="temporal-picker-title">Choose {name}</Dialog.Title>
              <Dialog.Close asChild><button type="button" className="temporal-close" aria-label={`Close ${name} picker`}><X size={20} strokeWidth={1.5} /></button></Dialog.Close>
            </div>
            <Dialog.Description className="temporal-format-hint">
              {kind === "date" ? "Use arrows to choose a day; Page Up and Page Down change month. You can also type YYYY-MM-DD."
                : `Choose a time in ${listStep / 60}-minute steps, or type an exact HH:mm time. Your field’s limits still apply.`}
            </Dialog.Description>
            {kind === "date" ? <>
              <div className="temporal-calendar-header">
                <button type="button" className="temporal-month-nav" aria-label="Previous month"
                  disabled={!monthAvailable(addMonths(month, -1))}
                  onClick={() => focusDate(addMonths(focusedDate, -1), -1)}><ChevronLeft size={20} strokeWidth={1.5} /></button>
                <strong aria-live="polite">{monthTitle}</strong>
                <button type="button" className="temporal-month-nav" aria-label="Next month"
                  disabled={!monthAvailable(addMonths(month, 1))}
                  onClick={() => focusDate(addMonths(focusedDate, 1), 1)}><ChevronRight size={20} strokeWidth={1.5} /></button>
              </div>
              <div className="temporal-calendar-grid" role="grid" aria-label={monthTitle}>
                <div role="row" className="temporal-calendar-weekdays">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
                {Array.from({ length: 6 }, (_, week) => <div role="row" className="temporal-calendar-week" key={week}>
                  {dates.slice(week * 7, week * 7 + 7).map(date => <button key={date} type="button" role="gridcell"
                    className="temporal-day" data-picker-value={date} data-selected={date === draft || undefined}
                    data-today={date === localToday() || undefined} data-outside={!date.startsWith(month.slice(0, 7)) || undefined}
                    aria-label={new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}
                    aria-selected={date === draft} aria-current={date === localToday() ? "date" : undefined}
                    tabIndex={date === focusedDate ? 0 : -1} disabled={!valid(date)}
                    onKeyDown={event => dateKey(event, date)} onClick={() => commit(date)}>{Number(date.slice(8))}</button>)}
                </div>)}
              </div>
            </> : <div className="temporal-time-options" role="listbox" aria-label={`${name}, available times`}>
              {times.length ? times.map((time, index) => <button type="button" role="option" key={time} data-picker-value={time}
                className="temporal-time-option" aria-selected={parseTime(draft) === parseTime(time)} data-selected={parseTime(draft) === parseTime(time) || undefined}
                tabIndex={time === focusedTime || (!focusedTime && index === 0) ? 0 : -1}
                onKeyDown={event => timeKey(event, index)} onClick={() => commit(time)}>{time}</button>)
                : <p className="temporal-format-hint">No five-minute choice fits these limits. Type an exact permitted time.</p>}
            </div>}
            <div className="temporal-picker-actions">
              {kind === "date" && <button type="button" className="temporal-picker-action" disabled={!valid(localToday())} onClick={() => commit(localToday())}>Today</button>}
              {!props.required && <button type="button" className="temporal-picker-action" onClick={() => commit("")}>Clear</button>}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
    <span id={formatId} className="sr-only">{kind === "date" ? "Type YYYY-MM-DD or open the date picker." : "Type HH:mm; Up and Down step five minutes. Alt+Down opens the time picker."}</span>
    {issue && <p id={errorId} className="temporal-error" role="alert">{issue}</p>}
  </div>;
}
