export const IDENTITY_REGISTRY_ERRORS: Record<number, string> = {
  1: 'DID not found',
  2: 'DID is deactivated',
  3: 'Metadata key or value exceeds maximum length',
  4: 'Contract already initialized',
  5: 'Empty metadata not allowed',
  6: 'Unauthorized: caller is not the admin/controller',
  7: 'DID already exists for this address',
};

export const CREDENTIAL_MANAGER_ERRORS: Record<number, string> = {
  1: 'Contract already initialized',
  2: 'Unauthorized issuer',
  3: 'Credential not found',
  4: 'Credential already revoked',
  5: 'Credential already exists',
  6: 'Contract not initialized',
  7: 'Unauthorized: caller is not the admin',
  8: 'Maximum number of issuers reached',
  9: 'Credential is expired',
};

export const REPUTATION_ERRORS: Record<number, string> = {
  1: 'Contract already initialized',
  2: 'Reporter not registered',
  3: 'Rate limit exceeded for this reporter',
  4: 'Reason text exceeds maximum length',
  5: 'Contract not initialized',
  6: 'Unauthorized: caller is not the admin',
};
