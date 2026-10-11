/**
 * Loading hub REST data for a screen: one GET, reloaded when the hub stream reconnects (a
 * restarted hub may have new data) or on demand after a write.
 */
import { useCallback, useEffect, useState } from "react";
import { hubRequest, isAppError, type AppError } from "../../lib/ipc";
import { useHubStore } from "../../stores/hubStore";

export interface HubResource<T> {
  data: T | null;
  loading: boolean;
  /** Null when the last load succeeded. */
  error: AppError | null;
  /** True when the background service is not reachable. */
  unavailable: boolean;
  reload: () => Promise<void>;
}

export function useHubResource<T>(path: string | null): HubResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<AppError | null>(null);
  const connected = useHubStore((s) => s.connected);

  const reload = useCallback(async () => {
    if (path === null) return;
    setLoading(true);
    try {
      setData(await hubRequest<T>("GET", path));
      setError(null);
    } catch (e) {
      setError(asAppError(e));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload, connected]);

  return { data, loading, error, unavailable: error?.code === "hub_unavailable", reload };
}

export function asAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { code: "io", message: e instanceof Error ? e.message : String(e) };
}
