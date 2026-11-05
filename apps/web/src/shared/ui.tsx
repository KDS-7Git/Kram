import {
  createContext,
  useContext,
  useEffect,
  useState,
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
    if (!current) return;
    const timer = setTimeout(
      () => setCurrent(null),
      current.undo ? 10000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [current]);
  const toast = (
    message: string,
    undo?: () => void | Promise<void>,
    tone?: "success" | "error",
  ) => {
    setCurrent({ message, undo, tone });
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
                  onClick={async () => {
                    try {
                      await current.undo?.();
                      setCurrent(null);
                    } catch (error) {
                      toast(errorMessage(error), undefined, "error");
                    }
                  }}
                >
                  Undo
                </Button>
              )}
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
