import { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { ScoreHistoryEntry } from "../../../sdk/src/reputation";
import SkeletonCard from "./SkeletonCard";

interface Props {
  history: ScoreHistoryEntry[];
  isLoading?: boolean;
}

const CHART_HEIGHT = 200;

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function ReputationChart({ history, isLoading = false }: Props) {
  const [startDate, setStartDate] = useState<string>(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return formatDateForInput(start);
  });

  const [endDate, setEndDate] = useState<string>(() => {
    return formatDateForInput(new Date());
  });

  const [validationError, setValidationError] = useState<string | null>(null);

  const filteredHistory = useMemo(() => {
    const startTs = new Date(startDate).getTime() / 1000;
    const endTs = new Date(endDate).getTime() / 1000 + 86400;

    if (startTs > endTs) {
      setValidationError("Start date cannot be after end date");
      return history;
    }

    setValidationError(null);
    return history.filter((entry) => entry.submittedAt >= startTs && entry.submittedAt <= endTs);
  }, [history, startDate, endDate]);

  const handleReset = () => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    setStartDate(formatDateForInput(start));
    setEndDate(formatDateForInput(end));
    setValidationError(null);
  };

  if (isLoading) {
    return <SkeletonCard height={CHART_HEIGHT} aria-label="Loading reputation chart" />;
  }

  if (history.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "1rem 0" }}>
        No score history available.
      </p>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: "1rem", display: "flex", gap: "1rem", alignItems: "flex-end", flexWrap: "wrap" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 500 }}>
            Start Date
          </label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid var(--border-input)",
              borderRadius: "0.4rem",
              fontSize: "0.9rem",
            }}
          />
        </div>
        <div>
          <label style={{ display: "block", fontSize: "0.85rem", marginBottom: "0.25rem", fontWeight: 500 }}>
            End Date
          </label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={{
              padding: "0.5rem 0.75rem",
              border: "1px solid var(--border-input)",
              borderRadius: "0.4rem",
              fontSize: "0.9rem",
            }}
          />
        </div>
        <button
          onClick={handleReset}
          style={{
            padding: "0.5rem 1rem",
            backgroundColor: "var(--button-bg, #4f46e5)",
            color: "white",
            border: "none",
            borderRadius: "0.4rem",
            cursor: "pointer",
            fontSize: "0.9rem",
            fontWeight: 500,
          }}
        >
          Reset
        </button>
      </div>

      {validationError && (
        <div style={{ color: "var(--error, #f87171)", fontSize: "0.85rem", marginBottom: "0.5rem" }}>
          {validationError}
        </div>
      )}

      <div style={{ width: "100%", height: CHART_HEIGHT }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={filteredHistory} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-input)" />
            <XAxis
              dataKey="submittedAt"
              tickFormatter={formatTimestamp}
              tick={{ fontSize: 11, fill: "var(--text-muted)" }}
            />
            <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
            <Tooltip
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any) => {
                const v = Number(value ?? 0);
                return [v > 0 ? `+${v}` : v, "Delta"];
              }}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              labelFormatter={(label: any) => formatTimestamp(Number(label))}
              contentStyle={{ background: "var(--card-bg)", border: "1px solid var(--border-input)", borderRadius: "0.4rem" }}
            />
            <Bar dataKey="delta" radius={[3, 3, 0, 0]}>
              {filteredHistory.map((entry, i) => (
                <Cell key={i} fill={entry.delta >= 0 ? "var(--accent-light, #6ee7b7)" : "var(--error, #f87171)"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
