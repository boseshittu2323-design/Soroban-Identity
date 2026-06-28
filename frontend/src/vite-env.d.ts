/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: string;
  readonly VITE_TESTNET_RPC_URL?: string;
  readonly VITE_TESTNET_IDENTITY_REGISTRY_ID?: string;
  readonly VITE_TESTNET_CREDENTIAL_MANAGER_ID?: string;
  readonly VITE_TESTNET_REPUTATION_ID?: string;
  readonly VITE_MAINNET_RPC_URL?: string;
  readonly VITE_MAINNET_IDENTITY_REGISTRY_ID?: string;
  readonly VITE_MAINNET_CREDENTIAL_MANAGER_ID?: string;
  readonly VITE_MAINNET_REPUTATION_ID?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  readonly VITE_EVENTS_URL?: string;
}
