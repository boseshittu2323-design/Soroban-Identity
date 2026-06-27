import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WalletButton from "./WalletButton";
import { WalletContext } from "../context/WalletContext";

// Mock the clipboard API
const mockClipboard = {
  writeText: vi.fn(),
};

Object.defineProperty(navigator, "clipboard", {
  value: mockClipboard,
  writable: true,
  configurable: true,
});

Object.defineProperty(window, "isSecureContext", {
  value: true,
  writable: true,
  configurable: true,
});

const mockWalletContext = {
  connected: true,
  publicKey: "GBTST2LSVJ7RQHAJWUIBVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX",
  connecting: false,
  txLoading: false,
  error: null,
  walletType: "freighter" as const,
  connect: vi.fn(),
  disconnect: vi.fn(),
  signTransaction: vi.fn(),
  retry: vi.fn(),
  isConnecting: false,
  connectionError: null,
  retryCount: 0,
};

const renderWithContext = (contextValue = mockWalletContext) => {
  return render(
    <WalletContext.Provider value={contextValue}>
      <WalletButton />
    </WalletContext.Provider>,
  );
};

describe("WalletButton Copy Functionality", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClipboard.writeText.mockResolvedValue(undefined);
  });

  describe("Copy button visibility and accessibility", () => {
    it("should render copy button when wallet is connected", () => {
      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");
      expect(copyButton).toBeInTheDocument();
    });

    it("should have correct aria-label and title attributes", () => {
      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");
      expect(copyButton).toHaveAttribute("title", "Copy wallet address");
    });

    it("should not render copy button when wallet is not connected", () => {
      renderWithContext({
        ...mockWalletContext,
        connected: false,
        publicKey: null,
      });
      const copyButton = screen.queryByLabelText("Copy wallet address");
      expect(copyButton).not.toBeInTheDocument();
    });
  });

  describe("Copy to clipboard functionality", () => {
    it("should copy full address to clipboard on button click", async () => {
      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");

      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(mockClipboard.writeText).toHaveBeenCalledWith(
          "GBTST2LSVJ7RQHAJWUIBVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX",
        );
      });
    });

    it("should show checkmark for 1500ms then revert to copy icon", async () => {
      vi.useFakeTimers();
      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");

      expect(copyButton.textContent).toContain("📋");

      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(copyButton.textContent).toContain("✓");
      });

      // Fast-forward 1500ms
      vi.advanceTimersByTime(1500);

      await waitFor(() => {
        expect(copyButton.textContent).toContain("📋");
      });

      vi.useRealTimers();
    });
  });

  describe("Fallback for non-secure contexts", () => {
    it("should use execCommand fallback when Clipboard API unavailable", async () => {
      // Mock non-secure context
      Object.defineProperty(window, "isSecureContext", {
        value: false,
        writable: true,
        configurable: true,
      });

      const mockSelect = vi.fn();
      const mockExecCommand = vi.fn(() => true);
      const mockAppendChild = vi.fn();
      const mockRemoveChild = vi.fn();

      const mockTextArea = {
        value: "",
        style: {},
        select: mockSelect,
      };

      vi.spyOn(document, "createElement").mockReturnValue(
        mockTextArea as unknown as Element,
      );
      vi.spyOn(document, "execCommand").mockImplementation(
        mockExecCommand as any,
      );
      vi.spyOn(document.body, "appendChild").mockImplementation(
        mockAppendChild as any,
      );
      vi.spyOn(document.body, "removeChild").mockImplementation(
        mockRemoveChild as any,
      );

      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");

      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(mockTextArea.value).toBe(
          "GBTST2LSVJ7RQHAJWUIBVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX",
        );
        expect(mockSelect).toHaveBeenCalled();
        expect(mockExecCommand).toHaveBeenCalledWith("copy");
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("fallback clipboard method"),
        );
      });

      consoleSpy.mockRestore();
      Object.defineProperty(window, "isSecureContext", {
        value: true,
        writable: true,
        configurable: true,
      });
    });

    it("should handle clipboard errors gracefully", async () => {
      mockClipboard.writeText.mockRejectedValue(new Error("Clipboard denied"));
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      renderWithContext();
      const copyButton = screen.getByLabelText("Copy wallet address");

      fireEvent.click(copyButton);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          "[WalletButton] Failed to copy address:",
          expect.any(Error),
        );
      });

      consoleSpy.mockRestore();
    });
  });

  describe("Display truncated address", () => {
    it("should display truncated address (first 4 and last 4 chars)", () => {
      renderWithContext();
      const truncatedAddress = screen.getByText("GBTS…5XCVX");
      expect(truncatedAddress).toBeInTheDocument();
    });

    it("should show full address in title attribute", () => {
      renderWithContext();
      const addressBadge = screen.getByText("GBTS…5XCVX");
      expect(addressBadge).toHaveAttribute(
        "title",
        "GBTST2LSVJ7RQHAJWUIBVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX5XCVX",
      );
    });
  });

  describe("Wallet type display", () => {
    it("should show 'via Freighter' for freighter wallet", () => {
      renderWithContext({ ...mockWalletContext, walletType: "freighter" });
      expect(screen.getByText("via Freighter")).toBeInTheDocument();
    });

    it("should show 'via WalletConnect' for walletconnect wallet", () => {
      renderWithContext({ ...mockWalletContext, walletType: "walletconnect" });
      expect(screen.getByText("via WalletConnect")).toBeInTheDocument();
    });
  });

  describe("Disconnect button interaction", () => {
    it("should show Disconnect button when connected", () => {
      renderWithContext();
      const disconnectButton = screen.getByRole("button", {
        name: /Disconnect/,
      });
      expect(disconnectButton).toBeInTheDocument();
    });

    it("should call disconnect when Disconnect button clicked", async () => {
      const mockDisconnect = vi.fn();
      renderWithContext({
        ...mockWalletContext,
        disconnect: mockDisconnect,
      });

      const disconnectButton = screen.getByRole("button", {
        name: /Disconnect/,
      });
      fireEvent.click(disconnectButton);

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it("should show 'Transaction pending...' when txLoading is true", () => {
      renderWithContext({ ...mockWalletContext, txLoading: true });
      expect(screen.getByText(/Transaction pending/)).toBeInTheDocument();
    });
  });
});
