export function getAppConfig() {
  // Support multiple RPC URLs separated by commas
  const rpcUrls = import.meta.env.VITE_RPC_URL?.split(',').map((url: string) => url.trim()).filter(Boolean);
  
  return {
    rpcUrl: rpcUrls && rpcUrls.length > 1 ? rpcUrls : import.meta.env.VITE_RPC_URL,
    networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE,
    identityRegistryId: import.meta.env.VITE_IDENTITY_REGISTRY_ID,
    credentialManagerId: import.meta.env.VITE_CREDENTIAL_MANAGER_ID,
    reputationId: import.meta.env.VITE_REPUTATION_ID,
  };
}
