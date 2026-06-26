import { createContext, useContext, type ReactNode } from "react";
import { useWallet } from "../hooks/useWallet";
import type { WalletState } from "../hooks/useWalletState";
import type { FrontendNetworkConfig } from "../network";
import { getNetworkConfig } from "../network";

interface WalletContextValue extends WalletState {
  connect: (walletType?: string) => void;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const networkConfig: FrontendNetworkConfig = getNetworkConfig();
  const wallet = useWallet(networkConfig);
  return (
    <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>
  );
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx)
    throw new Error("useWalletContext must be used inside WalletProvider");
  return ctx;
}
