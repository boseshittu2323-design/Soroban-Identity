import { getNetworkConfig } from './network';

// Returns config for the active network, resolved from VITE_NETWORK / VITE_*_RPC_URL
// / VITE_*_IDENTITY_REGISTRY_ID env vars defined in .env.example.
export function getAppConfig() {
  return getNetworkConfig();
}
