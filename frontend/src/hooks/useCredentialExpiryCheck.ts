import { useState, useEffect, useCallback, useRef } from "react";
import type { Credential } from "../../../sdk/src/types";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ExpiryNotification {
  count: number;
  credentials: Credential[];
  dismissed: boolean;
}

/**
 * Checks credentials for the connected wallet and notifies when any
 * expire within the next 7 days. Re-checks every 5 minutes.
 */
export function useCredentialExpiryCheck(
  publicKey: string | null,
  fetchCredentials: (address: string) => Promise<Credential[]>
) {
  const [notification, setNotification] = useState<ExpiryNotification | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    if (!publicKey) return;
    try {
      const credentials = await fetchCredentials(publicKey);
      const now = Date.now();
      const expiring = credentials.filter((c) => {
        if (c.expiresAt === 0 || c.revoked) return false;
        const expiryMs = c.expiresAt * 1000;
        return expiryMs > now && expiryMs - now <= SEVEN_DAYS_MS;
      });
      if (expiring.length > 0) {
        setNotification((prev: ExpiryNotification | null) =>
          prev?.dismissed ? prev : { count: expiring.length, credentials: expiring, dismissed: false }
        );
      } else {
        setNotification(null);
      }
    } catch {
      // silently ignore fetch errors
    }
  }, [publicKey, fetchCredentials]);

  useEffect(() => {
    if (!publicKey) {
      setNotification(null);
      return;
    }
    check();
    intervalRef.current = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [publicKey, check]);

  const dismiss = useCallback(() => {
    setNotification((prev: ExpiryNotification | null) => (prev ? { ...prev, dismissed: true } : null));
  }, []);

  return { notification, dismiss };
}
