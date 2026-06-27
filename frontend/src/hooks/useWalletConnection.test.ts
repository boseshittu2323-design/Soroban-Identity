import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useWalletConnection } from "./useWalletConnection";
import { DISCONNECTED_STATE } from "./useWalletState";

// Mock window.freighter
const mockFreighter = {
  isConnected: vi.fn(),
  getPublicKey: vi.fn(),
  getNetwork: vi.fn(),
};

Object.defineProperty(window, "freighter", {
  value: mockFreighter,
  writable: true,
  configurable: true,
});

// Mock SignClient
vi.mock("@walletconnect/sign-client", () => ({
  default: {
    init: vi.fn(),
  },
}));

// Mock network module
vi.mock("../network", () => ({
  getNetworkConfig: vi.fn(() => ({
    networkPassphrase: "Test SDF Network ; September 2015",
  })),
  getActiveNetwork: vi.fn(() => "testnet"),
}));

describe("useWalletConnection", () => {
  let setState: ReturnType<typeof vi.fn>;
  const mockNetworkConfig = {
    networkPassphrase: "Test SDF Network ; September 2015",
    walletConnectChain: "stellar:testnet",
  };

  beforeEach(() => {
    setState = vi.fn((fn) => {
      if (typeof fn === "function") {
        return fn(DISCONNECTED_STATE);
      }
      return fn;
    });
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  describe("Successful connection on first attempt", () => {
    it("should connect successfully on first attempt", async () => {
      mockFreighter.isConnected.mockResolvedValueOnce(true);
      mockFreighter.getPublicKey.mockResolvedValueOnce("GTEST123...");
      mockFreighter.getNetwork.mockResolvedValueOnce({
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 3,
          retryDelayMs: 1500,
        }),
      );

      await act(async () => {
        await result.current.connect("freighter");
      });

      expect(result.current.retryCount).toBe(0);
      expect(result.current.error).toBeNull();
      expect(result.current.isConnecting).toBe(false);
    });
  });

  describe("Timeout with retries", () => {
    it("should retry 3 times then set error after maxRetries failures", async () => {
      mockFreighter.isConnected.mockRejectedValue(
        new Error("Connection timeout"),
      );

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 3,
          retryDelayMs: 100,
        }),
      );

      await act(async () => {
        await result.current.connect("freighter");
      });

      // First attempt fails immediately
      expect(result.current.retryCount).toBe(1);
      expect(result.current.error).toBeNull();

      // Wait and advance timers for retry
      await act(async () => {
        vi.advanceTimersByTime(100);
        await waitFor(() => {
          expect(result.current.retryCount).toBe(2);
        });
      });

      await act(async () => {
        vi.advanceTimersByTime(100);
        await waitFor(() => {
          expect(result.current.retryCount).toBe(3);
        });
      });

      // Third retry fails, should stop
      await act(async () => {
        vi.advanceTimersByTime(100);
        await waitFor(() => {
          expect(result.current.retryCount).toBe(3);
          expect(result.current.error).not.toBeNull();
        });
      });

      const errorObj = result.current.error;
      expect(typeof errorObj === "object" && errorObj !== null).toBe(true);
      if (typeof errorObj === "object" && errorObj !== null) {
        expect(errorObj.code).toBe("WALLET_TIMEOUT");
        expect(errorObj.message).toContain(
          "Could not connect to Freighter after 3 attempts",
        );
      }
    });
  });

  describe("Successful connection on attempt 2 of 3", () => {
    it("should clear error and set connected state when successful", async () => {
      mockFreighter.isConnected
        .mockRejectedValueOnce(new Error("Connection timeout"))
        .mockResolvedValueOnce(true);
      mockFreighter.getPublicKey.mockResolvedValueOnce("GTEST123...");
      mockFreighter.getNetwork.mockResolvedValueOnce({
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 3,
          retryDelayMs: 100,
        }),
      );

      await act(async () => {
        await result.current.connect("freighter");
      });

      // First attempt fails
      expect(result.current.retryCount).toBe(1);

      // Advance timer and wait for second attempt
      await act(async () => {
        vi.advanceTimersByTime(100);
        await waitFor(() => {
          expect(result.current.retryCount).toBe(0);
          expect(result.current.error).toBeNull();
        });
      });

      expect(result.current.isConnecting).toBe(false);
    });
  });

  describe("Retry function", () => {
    it("should reset counter and start fresh connection on retry()", async () => {
      mockFreighter.isConnected.mockRejectedValue(
        new Error("Connection timeout"),
      );

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 3,
          retryDelayMs: 1500,
        }),
      );

      // Initial connection attempt
      await act(async () => {
        await result.current.connect("freighter");
      });

      // Fail 3 times
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          vi.advanceTimersByTime(1500);
        });
      }

      // Should have error now
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await waitFor(() => {
          expect(result.current.error).not.toBeNull();
        });
      });

      const errorBeforeRetry = result.current.error;

      // Now succeed on retry
      mockFreighter.isConnected.mockResolvedValueOnce(true);
      mockFreighter.getPublicKey.mockResolvedValueOnce("GTEST123...");
      mockFreighter.getNetwork.mockResolvedValueOnce({
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.retryCount).toBe(0);
      expect(result.current.error).toBeNull();
    });
  });

  describe("Error logging", () => {
    it("should log failed attempts with attempt number and elapsed time", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockFreighter.isConnected.mockRejectedValue(
        new Error("Connection timeout"),
      );

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 1,
          retryDelayMs: 100,
        }),
      );

      await act(async () => {
        await result.current.connect("freighter");
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Freighter attempt 1 failed"),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Connection timeout"),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("Disconnection cleanup", () => {
    it("should clear retries and error on disconnect", async () => {
      mockFreighter.isConnected.mockResolvedValueOnce(true);
      mockFreighter.getPublicKey.mockResolvedValueOnce("GTEST123...");
      mockFreighter.getNetwork.mockResolvedValueOnce({
        networkPassphrase: "Test SDF Network ; September 2015",
      });

      const { result } = renderHook(() =>
        useWalletConnection({
          networkConfig: mockNetworkConfig,
          setState,
          maxRetries: 3,
          retryDelayMs: 1500,
        }),
      );

      await act(async () => {
        await result.current.connect("freighter");
      });

      await act(async () => {
        await result.current.disconnect("freighter");
      });

      expect(result.current.error).toBeNull();
      expect(result.current.retryCount).toBe(0);
      expect(result.current.isConnecting).toBe(false);
    });
  });
});
