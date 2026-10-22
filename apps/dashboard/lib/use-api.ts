"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

interface State<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

/**
 * Minimal SWR-style hook: fetch on mount, optional polling (which can depend on the data,
 * e.g. poll fast while something is building), and a `refresh` for after mutations.
 */
export function useApi<T>(path: string | null, refreshInterval?: number | ((data: T | undefined) => number)) {
  const [state, setState] = useState<State<T>>({ data: undefined, error: undefined, loading: true });
  const dataRef = useRef<T | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api<T>(path);
      dataRef.current = data;
      setState({ data, error: undefined, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error: error as Error, loading: false }));
    }
  }, [path]);

  useEffect(() => {
    void refresh();
    if (!refreshInterval) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const ms = typeof refreshInterval === "function" ? refreshInterval(dataRef.current) : refreshInterval;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, ms);
    };
    schedule();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  return { ...state, refresh };
}
