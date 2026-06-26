import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SorobanEventListener } from './events';

describe('SorobanEventListener', () => {
  let listener: SorobanEventListener;
  const mockRpcUrl = 'https://soroban-testnet.stellar.org';
  const mockContractId =
    'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  beforeEach(() => {
    listener = new SorobanEventListener(mockRpcUrl, mockContractId);
  });

  afterEach(() => {
    listener.stop();
  });

  it('should create an instance with contract ID', () => {
    expect(listener).toBeDefined();
  });

  it('should start and stop polling', () =>
    new Promise<void>((resolve) => {
      const callback = vi.fn();
      listener.start(callback, 100);

      setTimeout(() => {
        listener.stop();
        resolve();
      }, 250);
    }));

  it('should not start multiple times', () => {
    const callback = vi.fn();
    listener.start(callback, 100);
    listener.start(callback, 100);

    setTimeout(() => {
      listener.stop();
      expect(callback.mock.calls.length).toBeLessThan(10);
    }, 300);
  });

  it('should accept event filter', () => {
    const filter = { topic: [['credential_issued']] };
    const filteredListener = new SorobanEventListener(
      mockRpcUrl,
      mockContractId,
      filter
    );
    expect(filteredListener).toBeDefined();
  });
});
