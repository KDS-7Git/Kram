import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type CSSProperties, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { Button, IconButton } from "../components/ui/kit";
import { listSpring, useMotionPreference } from "./motion";
import { errorMessage } from "./api";

interface Toast {
  message: string;
  undo?: () => void | Promise<void>;
  tone?: "success" | "error";
  id: number;
  remaining: number;
}
interface UI {
  toast: (message: string, undo?: () => void | Promise<void>, tone?: "success" | "error") => void;
}
const UIContext = createContext<UI>({ toast: () => undefined });

function ToastMessage({ item, dismiss, notify }: { item: Toast; dismiss: (id: number) => void; notify: UI["toast"] }) {
  const reduced = useMotionPreference();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [undoing, setUndoing] = useState(false);
  const remaining = useRef(item.remaining);
  const windowAtMount = useRef(item.remaining);
  const paused = hovered || focused || hidden || undoing;
  useEffect(() => {
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  useEffect(() => {
    if (paused) return;
    const started = performance.now();
    const timer = window.setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (performance.now() - started));
      item.remaining = remaining.current;
    };
  }, [item, paused, dismiss]);

  return <m.div layout={reduced ? false : "position"}
    initial={reduced ? false : { opacity: 0, y: 10, scale: .97 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={reduced ? undefined : { opacity: 0, y: 6, scale: .97 }}
    transition={reduced ? { duration: 0 } : { ...listSpring, opacity: { duration: .16 } }}
    role="status" aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    className={item.tone === "error" ? "toast toast-error" : "toast"}>
    {item.tone === "error" ? <AlertCircle size={18} strokeWidth={1.7} aria-hidden="true" />
      : <CheckCircle2 size={18} strokeWidth={1.7} aria-hidden="true" />}
    <span>{item.message}</span>
    {item.undo && <Button variant="text" loading={undoing} onClick={async () => {
      setUndoing(true);
      try { await item.undo?.(); dismiss(item.id); }
      catch (error) { dismiss(item.id); notify(errorMessage(error), undefined, "error"); }
      finally { setUndoing(false); }
    }}>Undo</Button>}
    <IconButton label="Dismiss message" onClick={() => dismiss(item.id)}><X size={16} strokeWidth={1.7} /></IconButton>
    <i className={`toast-window${paused ? " toast-window-paused" : ""}`} aria-hidden="true"
      style={{ animationDuration: `${windowAtMount.current}ms`, "--toast-progress": windowAtMount.current / 5000 } as CSSProperties} />
  </m.div>;
}

export function UIProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [messages, setMessages] = useState<Toast[]>([]);
  const [toastHost, setToastHost] = useState<HTMLElement>(document.body);
  const hasMessages = messages.length > 0;
  const dismiss = useCallback((id: number) => setMessages(rows => rows.filter(row => row.id !== id)), []);
  const toast = useCallback<UI["toast"]>((message, undo, tone) => {
    setMessages(rows => [...rows, { message, undo, tone, id: ++sequence.current, remaining: 5000 }]);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  useEffect(() => {
    if (!hasMessages) return;
    const updateHost = () => setToastHost(
      [...document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')].at(-1) || document.body,
    );
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    return () => observer.disconnect();
  }, [hasMessages]);

  return <UIContext.Provider value={value}>
    {children}
    {createPortal(<div className="toast-region" role="region" aria-label="Notifications">
      <AnimatePresence>{[...messages].reverse().map(item =>
        <ToastMessage key={item.id} item={item} dismiss={dismiss} notify={toast} />,
      )}</AnimatePresence>
    </div>, toastHost)}
  </UIContext.Provider>;
}
export function useUI() { return useContext(UIContext); }
