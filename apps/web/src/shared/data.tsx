import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Bootstrap } from "@kram/shared";
import { api } from "./api";

const DataContext = createContext<Bootstrap | null>(null);
export function DataProvider({
  value,
  children,
}: {
  value: Bootstrap;
  children: ReactNode;
}) {
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
export function useData() {
  const value = useContext(DataContext);
  if (!value) throw new Error("Kram data is not available.");
  return value;
}
export function useBootstrap() {
  return useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => api<Bootstrap>("/bootstrap"),
    staleTime: 15000,
  });
}
export function useRefresh() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["bootstrap"] }),
      client.invalidateQueries({ queryKey: ["hierarchy"] }),
      client.invalidateQueries({ queryKey: ["goals"] }),
      client.invalidateQueries({ queryKey: ["resources"] }),
      client.invalidateQueries({ queryKey: ["today"] }),
      client.invalidateQueries({ queryKey: ["tasks"] }),
      client.invalidateQueries({ queryKey: ["timetable"] }),
      client.invalidateQueries({ queryKey: ["reminders"] }),
      client.invalidateQueries({ queryKey: ["notifications"] }),
    ]);
}
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}
