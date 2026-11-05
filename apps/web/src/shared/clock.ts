import { useEffect, useState } from "react";

export function useWallClock(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => setNow(Date.now());
    const visibility = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "visible") {
        update();
        timer = setInterval(update, interval);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [interval]);
  return now;
}
