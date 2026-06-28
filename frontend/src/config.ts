import { getNetworkConfig } from './network';

const REQUIRED_VARS: Record<string, string | undefined> = {
  VITE_SERVER_URL: import.meta.env.VITE_SERVER_URL,
  VITE_NETWORK_PASSPHRASE: import.meta.env.VITE_NETWORK_PASSPHRASE,
  VITE_CONTRACT_ID: import.meta.env.VITE_CONTRACT_ID,
};

const missing = Object.entries(REQUIRED_VARS)
  .filter(([, v]) => !v)
  .map(([k]) => k);

if (missing.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. ` +
      'Check frontend/.env.example for the full list of required variables.'
  );
}

// Returns config for the active network, resolved from VITE_NETWORK / VITE_*_RPC_URL
// / VITE_*_IDENTITY_REGISTRY_ID env vars defined in .env.example.
export function getAppConfig() {
  return getNetworkConfig();
}
