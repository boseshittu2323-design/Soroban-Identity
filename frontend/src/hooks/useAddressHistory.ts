import { useState, useEffect } from "react";

const STORAGE_KEY = "soroban_identity_address_history";
const MAX_ENTRIES = 5;

export function useAddressHistory() {
  const [history, setHistory] = useState<string[]>([]);

  // Load history from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setHistory(JSON.parse(stored));
      } catch {
        setHistory([]);
      }
    }
  }, []);

  const addAddress = (address: string) => {
    if (!address.trim()) return;
    
    const trimmed = address.trim();
    setHistory((prev) => {
      // Remove if already exists, then add to front
      const filtered = prev.filter((a) => a !== trimmed);
      const updated = [trimmed, ...filtered].slice(0, MAX_ENTRIES);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      return updated;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  return { history, addAddress, clearHistory };
}
