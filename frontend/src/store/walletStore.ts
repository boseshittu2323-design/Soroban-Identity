import {
  StellarWalletsKit,
  WalletNetwork,
  FREIGHTER_ID,
  xBullWalletId,
} from '@creit.tech/stellar-wallets-kit';

const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  selectedWalletId: FREIGHTER_ID,
  wallets: [FREIGHTER_ID, xBullWalletId],
});

/** Session-storage key used to persist connection state across HMR reloads. */
const SESSION_KEY = 'soroban_identity_wallet';

interface PersistedState {
  address: string;
}

/**
 * Read the previously persisted address from sessionStorage.
 * Returns `null` when nothing is stored or the stored value is invalid.
 * sessionStorage is tab-scoped, so this has no effect in other tabs or after
 * the browser window is closed — identical to production behaviour.
 */
function loadPersistedAddress(): string | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return typeof parsed.address === 'string' && parsed.address.length > 0
      ? parsed.address
      : null;
  } catch {
    return null;
  }
}

function persistAddress(address: string | null): void {
  try {
    if (address) {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ address }));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // sessionStorage may be unavailable in certain environments (e.g. SSR).
  }
}

// Rehydrate from sessionStorage on module creation so that HMR and page
// refreshes with an active Freighter connection restore isConnected: true.
let _address: string | null = loadPersistedAddress();
const _listeners = new Set<(address: string | null) => void>();

function set(partial: { address: string | null }) {
  _address = partial.address;
  persistAddress(_address);
  _listeners.forEach((fn) => fn(_address));
}

export const walletStore = {
  getAddress: (): string | null => _address,

  subscribe: (fn: (address: string | null) => void): (() => void) => {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  },

  connect: async (): Promise<void> => {
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address } = await kit.getAddress();
        set({ address });
      },
    });
  },

  /** Disconnects the wallet and clears the persisted sessionStorage state. */
  disconnect: (): void => {
    set({ address: null });
    kit.setWallet(FREIGHTER_ID);
  },

  sign: async (xdr: string): Promise<string> => {
    const { signedTxXdr } = await kit.sign({
      xdr,
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    return signedTxXdr;
  },

  getKit: (): StellarWalletsKit => kit,
};
