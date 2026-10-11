/**
 * Loads one hub GET route for a screen. `path === null` skips loading. A stale response (the
 * path changed meanwhile) is dropped. `unavailable` is true when the background service isn't
 * reachable, so screens can show their "not running" state instead of an error.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { hubRequest, isAppError, toAppError } from "../../lib/ipc";

export interface HubQuery<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  reload: () => void;
}

export function useHubQuery<T>(path: string | null): HubQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    hubRequest<T>("GET", path)
      .then((result) => {
        if (id !== requestId.current) return;
        setData(result);
        setError(null);
        setUnavailable(false);
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return;
        setUnavailable(isAppError(e, "hub_unavailable"));
        setError(toAppError(e).message);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, unavailable, reload };
}
