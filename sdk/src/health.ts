import { IdentityClient } from './identity';
import { CredentialClient } from './credentials';
import { ReputationClient } from './reputation';
import type { SorobanIdentityConfig } from './types';

export interface HealthCheckResult {
  identityRegistry: boolean;
  credentialManager: boolean;
  reputation: boolean;
  allHealthy: boolean;
}

/**
 * Pre-flight health check that pings all three deployed contracts.
 *
 * Calls the read-only `ping()` function on each contract in parallel and
 * returns a per-contract boolean indicating whether it responded. Use this
 * before initiating user-facing operations to surface deployment problems
 * early.
 *
 * @param config SDK config with all three contract IDs populated.
 * @returns {@link HealthCheckResult} with individual and aggregate liveness
 *   flags. A contract is considered unhealthy if its `ping()` throws for any
 *   reason (network error, contract not deployed, not initialised, etc.).
 *
 * @example
 * ```ts
 * import { healthCheck, TESTNET_CONFIG } from '@soroban-identity/sdk';
 * const { allHealthy } = await healthCheck({ ...TESTNET_CONFIG, ... });
 * if (!allHealthy) throw new Error('One or more contracts are not reachable');
 * ```
 */
export async function healthCheck(config: SorobanIdentityConfig): Promise<HealthCheckResult> {
  const [identityResult, credentialResult, reputationResult] = await Promise.allSettled([
    new IdentityClient(config).ping(),
    new CredentialClient(config).ping(),
    new ReputationClient(config).ping(),
  ]);

  const identityOk = identityResult.status === 'fulfilled';
  const credentialOk = credentialResult.status === 'fulfilled';
  const reputationOk = reputationResult.status === 'fulfilled';

  return {
    identityRegistry: identityOk,
    credentialManager: credentialOk,
    reputation: reputationOk,
    allHealthy: identityOk && credentialOk && reputationOk,
  };
}
