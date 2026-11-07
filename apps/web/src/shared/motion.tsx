import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { LazyMotion, MotionConfig, domMax } from "framer-motion";

export const spring = { type: "spring" as const, stiffness: 440, damping: 36, mass: 0.8 };
export const listSpring = { type: "spring" as const, stiffness: 380, damping: 34, mass: 0.8 };

/** Both the OS preference and the saved app preference stop motion, including opacity. */
export function useMotionPreference() {
  const subscribe = useCallback((update: () => void) => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    media.addEventListener("change", update);
    window.addEventListener("kram-appearance-changed", update);
    window.addEventListener("storage", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("kram-appearance-changed", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return useSyncExternalStore(subscribe, () =>
    document.documentElement.dataset.motion === "reduced" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  () => true);
}

export function MotionProvider({ children }: { children: ReactNode }) {
  const reduced = useMotionPreference();
  return (
    <LazyMotion features={domMax}>
      <MotionConfig reducedMotion={reduced ? "always" : "user"} transition={reduced ? { duration: 0 } : spring}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}
