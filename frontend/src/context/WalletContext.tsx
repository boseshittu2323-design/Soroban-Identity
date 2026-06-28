import { createContext, useContext, useMemo, type ReactNode } from "react";
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

  const value = useMemo(
    () => wallet,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      wallet.publicKey,
      wallet.connected,
      wallet.networkPassphrase,
      wallet.connecting,
      wallet.txLoading,
      wallet.walletType,
      wallet.error,
      wallet.retryCount,
      wallet.isConnecting,
      wallet.connectionError,
      wallet.connect,
      wallet.disconnect,
      wallet.signTransaction,
      wallet.retry,
    ]
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx)
    throw new Error("useWalletContext must be used inside WalletProvider");
  return ctx;
}
