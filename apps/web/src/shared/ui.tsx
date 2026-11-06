import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { Button, IconButton } from "../components/ui/kit";
import { errorMessage } from "./api";

interface Toast {
  message: string;
  undo?: () => void | Promise<void>;
  tone?: "success" | "error";
  id: number;
}
interface UI {
  toast: (
    message: string,
    undo?: () => void | Promise<void>,
    tone?: "success" | "error",
  ) => void;
}
const UIContext = createContext<UI>({ toast: () => undefined });
export function UIProvider({ children }: { children: ReactNode }) {
  const [paused, setPaused] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const remaining = useRef(5000);
  const sequence = useRef(0);
  const countdownId = useRef(0);
  const [current, setCurrent] = useState<Toast | null>(null);
  const [toastHost, setToastHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!current) return;
    const updateHost = () =>
      setToastHost(
        [
          ...document.querySelectorAll<HTMLElement>(
            '[role="dialog"][data-state="open"]',
          ),
        ].at(-1) || document.body,
      );
    updateHost();
    const observer = new MutationObserver(updateHost);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    return () => observer.disconnect();
  }, [current]);
  useEffect(() => {
    if (!current || paused || undoing) return;
    if (countdownId.current !== current.id) { remaining.current = 5000; countdownId.current = current.id; }
    const started = performance.now();
    const timer = setTimeout(() => setCurrent(null), remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (performance.now() - started)); };
  }, [current, paused, undoing]);
  const toast = (
    message: string,
    undo?: () => void | Promise<void>,
    tone?: "success" | "error",
  ) => {
    remaining.current = 5000;
    setPaused(false);
    setCurrent({ message, undo, tone, id: ++sequence.current });
    setToastHost(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][data-state="open"]',
        ),
      ].at(-1) || document.body,
    );
  };
  return (
    <UIContext.Provider value={{ toast }}>
      {children}
      {current &&
        toastHost &&
        createPortal(
          <div
            className="toast-region"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div
              key={current.id}
              onMouseEnter={() => setPaused(true)}
              onMouseLeave={() => setPaused(false)}
              onFocusCapture={() => setPaused(true)}
              onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
              className={
                current.tone === "error" ? "toast toast-error" : "toast"
              }
            >
              {current.tone === "error" ? (
                <AlertCircle size={20} strokeWidth={1.5} aria-hidden="true" />
              ) : (
                <CheckCircle2 size={20} strokeWidth={1.5} aria-hidden="true" />
              )}
              <span>{current.message}</span>
              {current.undo && (
                <Button
                  variant="text"
                  disabled={undoing}
                  onClick={async () => {
                    setUndoing(true);
                    try {
                      await current.undo?.();
                      setCurrent(active => active?.id === current.id ? null : active);
                    } catch (error) {
                      toast(errorMessage(error), undefined, "error");
                    } finally { setUndoing(false); }
                  }}
                >
                  Undo
                </Button>
              )}
              {current.undo && <i className={`toast-window${paused || undoing ? ' toast-window-paused' : ''}`} aria-hidden="true" />}
              <IconButton
                label="Dismiss message"
                onClick={() => setCurrent(null)}
              >
                <X size={18} strokeWidth={1.5} />
              </IconButton>
            </div>
          </div>,
          toastHost,
        )}
    </UIContext.Provider>
  );
}
export function useUI() {
  return useContext(UIContext);
}
