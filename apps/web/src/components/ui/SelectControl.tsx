import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronDown, X } from "lucide-react";

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> };
type Choice = { value: string; label: string; disabled: boolean; group: string };
type Snapshot = { choices: Choice[]; value: string; index: number };

function textContent(children: ReactNode): string {
  let text = "";
  Children.forEach(children, child => {
    if (typeof child === "string" || typeof child === "number") text += String(child);
    else if (isValidElement<{ children?: ReactNode }>(child)) text += textContent(child.props.children);
  });
  return text;
}

function initialChoices(children: ReactNode, group = "", disabled = false): Choice[] {
  const choices: Choice[] = [];
  Children.forEach(children, child => {
    if (!isValidElement<{ children?: ReactNode; value?: string | number; label?: string; disabled?: boolean }>(child)) return;
    if (child.type === "option") {
      const text = textContent(child.props.children);
      choices.push({ value: String(child.props.value ?? text), label: child.props.label || text, disabled: disabled || !!child.props.disabled, group });
    } else {
      choices.push(...initialChoices(child.props.children, child.type === "optgroup" ? child.props.label || "" : group, disabled || !!child.props.disabled));
    }
  });
  return choices;
}

function nativeSnapshot(node: HTMLSelectElement): Snapshot {
  return {
    value: node.value,
    index: node.selectedIndex,
    choices: Array.from(node.options, option => {
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
      return { value: option.value, label: option.label, disabled: option.disabled || !!group?.disabled, group: group?.label || "" };
    }),
  };
}

/** A styled chooser backed by the original select for form values, registration and events. */
export function SelectControl({ select, label }: { select: ReactElement<SelectProps>; label?: string }) {
  const props = select.props;
  const generatedId = useId().replaceAll(":", "");
  const id = props.id || `${generatedId}-select`;
  const listboxId = `${generatedId}-choices`;
  const errorId = `${generatedId}-error`;
  const name = props["aria-label"] || label || "Option";
  const nativeRef = useRef<HTMLSelectElement | null>(null);
  const initialValue = useRef<string | undefined>(undefined);
  const latestProps = useRef(props);
  latestProps.current = props;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const outsideDismiss = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => {
    const choices = initialChoices(props.children);
    const value = String(props.value ?? props.defaultValue ?? choices[0]?.value ?? "");
    return { choices, value, index: choices.findIndex(choice => choice.value === value) };
  });
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState(() => matchMedia("(max-width: 599px)").matches);
  const [active, setActive] = useState(-1);
  const [issue, setIssue] = useState("");
  const [anchor, setAnchor] = useState({ left: 12, top: 12, width: 288 });
  const typeahead = useRef({ text: "", at: 0 });

  // RHF can replace its registration ref on reset. Preserve that lifecycle while
  // reading the native element after registration has applied its current value.
  const mergeRef = useCallback((node: HTMLSelectElement | null) => {
    nativeRef.current = node;
    if (typeof props.ref === "function") {
      const cleanup = props.ref(node);
      if (node && initialValue.current === undefined) initialValue.current = node.value;
      if (typeof cleanup === "function") return () => { nativeRef.current = null; cleanup(); };
    } else if (props.ref) props.ref.current = node;
    if (node && initialValue.current === undefined) initialValue.current = node.value;
  }, [props.ref]);

  const syncNative = useCallback(() => {
    const node = nativeRef.current;
    if (!node) return;
    const next = nativeSnapshot(node);
    setSnapshot(previous => previous.value === next.value && previous.index === next.index &&
      JSON.stringify(previous.choices) === JSON.stringify(next.choices) ? previous : next);
  }, []);
  useLayoutEffect(syncNative);
  useEffect(() => {
    const media = matchMedia("(max-width: 599px)");
    const update = () => setPhone(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const node = nativeRef.current, form = node?.form;
    if (!node || !form) return;
    const invalid = () => {
      setIssue("Choose an option before continuing.");
      triggerRef.current?.focus({ preventScroll: true });
    };
    const guard = (event: Event) => {
      if (!node.disabled && !node.validity.valid) {
        event.preventDefault();
        event.stopImmediatePropagation();
        invalid();
      }
    };
    const reset = () => requestAnimationFrame(() => {
      if (!node.isConnected || nativeRef.current !== node) return;
      const current = latestProps.current;
      // Registration may set an empty disabled placeholder without changing the
      // browser's defaultSelected flags. Native reset must retain that starting value.
      node.value = String(current.value ?? current.defaultValue ?? initialValue.current ?? node.value);
      // Native reset changes the DOM without a change event. Send its resulting
      // value through the original adapter so registered form state also resets.
      node.dispatchEvent(new Event("change", { bubbles: true }));
      setIssue("");
      syncNative();
    });
    form.addEventListener("submit", guard, true);
    form.addEventListener("reset", reset);
    return () => { form.removeEventListener("submit", guard, true); form.removeEventListener("reset", reset); };
  }, [props.form, syncNative]);
  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);
  useEffect(() => {
    if (!open) return;
    const option = optionRefs.current[active];
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest", behavior: "instant" });
    if (!option) closeRef.current?.focus({ preventScroll: true });
  }, [open, active, snapshot.choices, phone]);

  const available = snapshot.choices.map((choice, index) => choice.disabled ? -1 : index).filter(index => index >= 0);
  const openPicker = (next: boolean, direction = 1) => {
    setOpen(next);
    if (!next || props.disabled) return;
    outsideDismiss.current = false;
    syncNative();
    setActive(available.includes(snapshot.index) ? snapshot.index : direction < 0 ? available.at(-1) ?? -1 : available[0] ?? -1);
    typeahead.current = { text: "", at: 0 };
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(Math.max(rect.width, 288), 400, innerWidth - 24);
      const desiredHeight = Math.min(400, snapshot.choices.length * 48 + 84);
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      setAnchor({ width, left: Math.max(12, Math.min(innerWidth - width - 12, rect.left)),
        top: below >= desiredHeight || below >= above ? rect.bottom + 8 : Math.max(12, rect.top - Math.min(desiredHeight, above) - 8) });
    }
  };
  const commit = (index: number) => {
    const node = nativeRef.current, choice = snapshot.choices[index];
    if (!node || !choice || choice.disabled || props.disabled) return;
    node.selectedIndex = index;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    setIssue("");
    syncNative();
    if (open) typeahead.current = { text: "", at: 0 };
    setOpen(false);
  };
  const matchText = (key: string, current: number) => {
    const now = Date.now();
    const previous = now - typeahead.current.at < 700 ? typeahead.current.text : "";
    const text = previous + key.toLocaleLowerCase();
    typeahead.current = { text, at: now };
    const repeating = [...text].every(character => character === text[0]);
    const query = repeating ? text[0]! : text;
    const order = [...available.filter(index => index > current), ...available.filter(index => index <= current)];
    return order.find(index => snapshot.choices[index]!.label.trim().toLocaleLowerCase().startsWith(query));
  };
  const optionKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const position = available.indexOf(index);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1)
        : available[(position + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length];
      if (next !== undefined) setActive(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(index);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const next = matchText(event.key, index);
      if (next !== undefined) setActive(next);
    }
  };
  const triggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      typeahead.current = { text: "", at: 0 };
      const next = event.key === "Home" ? available[0] : available.at(-1);
      if (next !== undefined) commit(next);
    } else if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      openPicker(true, event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const next = matchText(event.key, snapshot.index);
      if (next !== undefined) commit(next);
    }
  };
  const describedBy = [...new Set([props["aria-describedby"], issue ? errorId : undefined].filter(Boolean))].join(" ");
  const current = snapshot.choices[snapshot.index];

  return <div className="select-control">
    {cloneElement(select, {
      ref: mergeRef,
      id: `${id}-native`,
      hidden: true,
      tabIndex: -1,
      "aria-hidden": true,
      "aria-label": undefined,
      "aria-labelledby": undefined,
      onChange: event => { props.onChange?.(event); syncNative(); },
      onInvalid: event => {
        event.preventDefault();
        setIssue("Choose an option before continuing.");
        triggerRef.current?.focus({ preventScroll: true });
        props.onInvalid?.(event);
      },
    })}
    <Dialog.Root open={open} onOpenChange={next => openPicker(next)} modal={phone}>
      <Dialog.Trigger asChild>
        <button ref={triggerRef} id={id} type="button" role="combobox" className={`${props.className || "input"} select-trigger`}
          style={props.style} disabled={props.disabled} data-value={snapshot.value}
          aria-label={name} aria-labelledby={props["aria-labelledby"]} aria-haspopup="listbox" aria-expanded={open}
          aria-controls={open ? listboxId : undefined} aria-required={props.required}
          aria-invalid={issue ? true : props["aria-invalid"]} aria-describedby={describedBy || undefined}
          onKeyDown={triggerKey}
          onFocus={() => nativeRef.current?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))}
          onBlur={() => { if (!open) nativeRef.current?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); }}>
          <span className="select-current">{current?.label || "Choose an option"}</span>
          <ChevronDown size={20} strokeWidth={1.5} className="select-chevron" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        {phone && <Dialog.Overlay className="select-overlay" />}
        <Dialog.Content className={`select-picker ${phone ? "select-sheet" : "select-popover"}`}
          style={phone ? undefined : { left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: `calc(100dvh - ${anchor.top + 12}px)` }}
          onOpenAutoFocus={event => {
            event.preventDefault();
            const target = optionRefs.current[active] || closeRef.current;
            target?.focus({ preventScroll: true });
            optionRefs.current[active]?.scrollIntoView({ block: "nearest", behavior: "instant" });
          }}
          onPointerDownOutside={() => { outsideDismiss.current = true; }}
          onFocusOutside={() => { outsideDismiss.current = true; }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (outsideDismiss.current && !phone) return;
            const target = triggerRef.current?.isConnected && !triggerRef.current.disabled ? triggerRef.current : document.getElementById("main-content");
            target?.focus({ preventScroll: true });
          }}>
          <div className="select-picker-heading">
            <Dialog.Title className="select-picker-title">{name}</Dialog.Title>
            <Dialog.Close asChild><button ref={closeRef} type="button" className="select-close" aria-label={`Close ${name} choices`}><X size={20} strokeWidth={1.5} /></button></Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Choose one option. Use arrows, Home or End, or type its name. Enter selects; Escape closes.</Dialog.Description>
          <div className="select-options" id={listboxId} role="listbox" aria-label={name}>
            {snapshot.choices.map((choice, index) => <div key={`${index}:${choice.value}`} role="presentation">
              {choice.group && snapshot.choices[index - 1]?.group !== choice.group && <p className="select-group-label" aria-hidden="true">{choice.group}</p>}
              <button ref={node => { optionRefs.current[index] = node; }} type="button" role="option" className="select-option"
                data-value={choice.value} data-selected={index === snapshot.index || undefined} aria-selected={index === snapshot.index}
                disabled={choice.disabled} aria-disabled={choice.disabled || undefined} tabIndex={index === active ? 0 : -1}
                onKeyDown={event => optionKey(event, index)} onClick={() => commit(index)}>
                <span>{choice.label}</span>{index === snapshot.index && <Check size={18} strokeWidth={1.5} aria-hidden="true" />}
              </button>
            </div>)}
            {!snapshot.choices.length && <p className="select-empty">No options are available.</p>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {issue && <p id={errorId} className="field-error" role="alert">{issue}</p>}
  </div>;
}
