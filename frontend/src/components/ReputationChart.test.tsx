import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ReputationChart from "./ReputationChart";
import type { ScoreHistoryEntry } from "../../../sdk/src/reputation";

const sampleHistory: ScoreHistoryEntry[] = [
  { reporter: "GREPORTER1", submittedAt: 1700000000, delta: 10, reason: "activity" },
  { reporter: "GREPORTER1", submittedAt: 1700086400, delta: -5, reason: "penalty" },
];

describe("ReputationChart", () => {
  it("renders empty-state when history is empty", () => {
    const { container } = render(<ReputationChart history={[]} />);
    const p = container.querySelector("p");
    expect(p).not.toBeNull();
    expect(p!.textContent).toBe("No reputation history yet.");
    expect(p!.getAttribute("role")).toBe("status");
  });

  it("does not render empty-state when history is non-empty", () => {
    const { container } = render(<ReputationChart history={sampleHistory} />);
    const p = container.querySelector("p[role='status']");
    expect(p).toBeNull();
  });

  it("renders chart container when history is non-empty", () => {
    const { container } = render(<ReputationChart history={sampleHistory} />);
    // recharts renders an svg
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });

  it("matches empty-state snapshot", () => {
    const { container } = render(<ReputationChart history={[]} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("matches non-empty chart snapshot", () => {
    const { container } = render(<ReputationChart history={sampleHistory} />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
