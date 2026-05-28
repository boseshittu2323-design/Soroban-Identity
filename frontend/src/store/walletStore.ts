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

let _address: string | null = null;
const _listeners = new Set<(address: string | null) => void>();

function set(partial: { address: string | null }) {
  _address = partial.address;
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
