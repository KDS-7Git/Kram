import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, X } from "lucide-react";
import { Button, IconButton } from "../components/ui/kit";

interface Toast {
  message: string;
  undo?: () => void | Promise<void>;
}
interface UI {
  toast: (message: string, undo?: () => void | Promise<void>) => void;
}
const UIContext = createContext<UI>({ toast: () => undefined });
export function UIProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<Toast | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(
      () => setCurrent(null),
      current.undo ? 10000 : 5000,
    );
    return () => clearTimeout(timer);
  }, [current]);
  const toast = (message: string, undo?: () => void | Promise<void>) => {
    setCurrent({ message, undo });
    setAnnouncement(message);
  };
  return (
    <UIContext.Provider value={{ toast }}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {current && (
        <div className="toast-region">
          <div className="toast">
            <CheckCircle2 size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>{current.message}</span>
            {current.undo && (
              <Button
                variant="text"
                onClick={async () => {
                  await current.undo?.();
                  setCurrent(null);
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
        </div>
      )}
    </UIContext.Provider>
  );
}
export function useUI() {
  return useContext(UIContext);
}
