// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ReputationChart from "./ReputationChart";
import type { ScoreHistoryEntry } from "../../../sdk/src/reputation";

const mockHistory: ScoreHistoryEntry[] = [
  {
    score: 10,
    delta: 5,
    reason: "Contribution",
    submittedBy: "GBXXX...",
    submittedAt: Math.floor(Date.now() / 1000) - 86400,
  },
  {
    score: 15,
    delta: 5,
    reason: "Verification",
    submittedBy: "GBXXX...",
    submittedAt: Math.floor(Date.now() / 1000),
  },
];

// Recharts ResponsiveContainer often needs fallback or resize observer in jsdom
vi.mock("recharts", async (importOriginal) => {
  const original = await importOriginal<typeof import("recharts")>();
  return {
    ...original,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: "100%", height: 200 }}>
        {children}
      </div>
    ),
  };
});

describe("ReputationChart", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders skeleton placeholder during loading state with correct aria-label and dimensions", () => {
    const { container } = render(<ReputationChart history={[]} isLoading={true} />);

    const skeleton = screen.getByLabelText("Loading reputation chart");
    expect(skeleton).toBeInTheDocument();
    expect(skeleton).toHaveClass("card", "skeleton-card");

    // Check style has height 200 applied
    expect(skeleton.style.height).toBe("200px");
    expect(container.querySelector(".skeleton-title")).toBeInTheDocument();
  });

  it("shows skeleton loader when isLoading=true even if history is empty", () => {
    render(<ReputationChart history={[]} isLoading={true} />);
    expect(screen.getByLabelText("Loading reputation chart")).toBeInTheDocument();
    expect(screen.queryByText("No score history available.")).not.toBeInTheDocument();
  });

  it("shows empty state when isLoading=false and history is empty", () => {
    render(<ReputationChart history={[]} isLoading={false} />);
    expect(screen.getByText("No score history available.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading reputation chart")).not.toBeInTheDocument();
  });

  it("renders chart when isLoading=false and history has items", () => {
    render(<ReputationChart history={mockHistory} isLoading={false} />);
    expect(screen.queryByLabelText("Loading reputation chart")).not.toBeInTheDocument();
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
  });

  it("matches snapshot when loading", () => {
    const { container } = render(<ReputationChart history={[]} isLoading={true} />);
    expect(container).toMatchSnapshot();
  });
});
