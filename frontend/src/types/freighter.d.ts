declare global {
  interface Window {
    freighter?: {
      isConnected: () => Promise<boolean>;
      getPublicKey: () => Promise<string>;
      signTransaction: (xdr: string, opts?: { networkPassphrase?: string }) => Promise<string>;
      getNetwork: () => Promise<{ network: string; networkPassphrase: string }>;
    };
  }
}

export {};
