import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityClient } from './identity';
import type { SorobanIdentityConfig, DidDocument } from './types';

const { mockSimulateTransaction, mockIsSimulationError } = vi.hoisted(() => ({
  mockSimulateTransaction: vi.fn(),
  mockIsSimulationError: vi.fn(),
}));

vi.mock('@stellar/stellar-sdk', () => ({
  SorobanRpc: {
    Server: vi.fn().mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({ id: 'GABC', sequence: '0' }),
      simulateTransaction: mockSimulateTransaction,
      prepareTransaction: vi.fn().mockImplementation((tx) => tx),
      sendTransaction: vi
        .fn()
        .mockResolvedValue({ status: 'PENDING', hash: 'abc123' }),
      getTransaction: vi.fn().mockResolvedValue({
        status: 'SUCCESS',
        returnValue: 'did:stellar:GABC',
      }),
    })),
    Api: {
      isSimulationError: mockIsSimulationError,
      GetTransactionStatus: { SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
    },
  },
  Contract: vi.fn().mockImplementation(() => ({
    call: vi.fn().mockReturnValue({}),
  })),
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({ sign: vi.fn() }),
  })),
  BASE_FEE: '100',
  Account: vi.fn().mockImplementation((id: string) => ({ id, sequence: '0' })),
  Keypair: {
    fromSecret: vi.fn().mockReturnValue({
      publicKey: () => 'GABC',
    }),
  },
  nativeToScVal: vi.fn().mockReturnValue({}),
  scValToNative: vi.fn().mockImplementation((v) => v),
  StrKey: {
    isValidEd25519PublicKey: (addr: string) =>
      typeof addr === 'string' && addr.startsWith('G'),
    isValidContract: (id: string) =>
      typeof id === 'string' && id.startsWith('C') && id.length === 56,
  },
}));

const config: SorobanIdentityConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  identityRegistryId: 'CBBNTYLY7WH6O3IGUI6BKUYLB5UQOOCNDYW5EL7BY4DJKPZ7SGIRWCSL',
  credentialManagerId: 'CD5MO3M3LYM5JLYXD27ARVECRKQXLJJSNBWMAUJ6ST3F4FXBGGXTJA7T',
  reputationId: 'CBXM5TFFI4DWZ2OQSR37KHVO6OEKTJQTGOQMFTIDFTFUP32COAGW4OPK',
};

describe('IdentityClient', () => {
  let client: IdentityClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new IdentityClient(config);
  });

  it('constructs without throwing', () => {
    expect(client).toBeDefined();
  });

  it('resolveDid — happy path returns a DidDocument', async () => {
    const mockDidDoc: DidDocument = {
      id: 'did:stellar:GABC',
      controller: 'GABC',
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
      active: true,
    };

    mockIsSimulationError.mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: mockDidDoc },
    });

    const result = await client.resolveDid('GABC');

    expect(result).toEqual(mockDidDoc);
  });

  it('resolveDid — throws when simulation fails', async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulateTransaction.mockResolvedValue({ error: 'Contract error' });

    await expect(client.resolveDid('GABC')).rejects.toThrow(
      'Simulation failed'
    );
  });

  it('hasActiveDid — returns true for active DID', async () => {
    mockIsSimulationError.mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValue({
      result: { retval: true },
    });

    const result = await client.hasActiveDid('GABC');

    expect(result).toBe(true);
  });

  it('hasActiveDid — returns false for inactive or missing DID', async () => {
    mockIsSimulationError.mockReturnValue(true);
    mockSimulateTransaction.mockResolvedValue({ error: 'No DID' });

    const result = await client.hasActiveDid('GABC');

    expect(result).toBe(false);
  });

  it('createDid — happy path returns the new DID string', async () => {
    const keypair = { publicKey: () => 'GABC', sign: vi.fn() } as any;

    const result = await client.createDid(keypair, {
      service: 'https://example.com',
    });

    expect(result.data.did).toBe('did:stellar:GABC');
    expect(result.txHash).toBe('abc123');
  });

  it('createDid — throws descriptive error when DID already exists', async () => {
    const utils = await import('./utils');
    vi.spyOn(utils, 'pollTransactionStatus').mockRejectedValueOnce(
      new Error('DID already exists for this address')
    );

    const keypair = { publicKey: () => 'GABC', sign: vi.fn() } as any;

    await expect(client.createDid(keypair)).rejects.toThrow(
      'A DID already exists for address GABC'
    );
  });

  it('resolveDid — throws InvalidAddress for an invalid address', async () => {
    await expect(client.resolveDid('not-valid')).rejects.toThrow(
      'InvalidAddress'
    );
  });

  it('hasActiveDid — throws InvalidAddress for an invalid address', async () => {
    await expect(client.hasActiveDid('bad')).rejects.toThrow('InvalidAddress');
  });

  it('getStorageStats — returns decoded stats on success', async () => {
    const mockStats = { totalDids: 5, activeDids: 3 };
    mockIsSimulationError.mockReturnValue(false);
    mockSimulateTransaction.mockResolvedValue({ result: { retval: {} } });
    const { scValToNative } = await import('@stellar/stellar-sdk');
    (scValToNative as ReturnType<typeof vi.fn>).mockReturnValue(mockStats);

    const result = await client.getStorageStats('GCALLER');
    expect(result).toEqual(mockStats);
  });
});
