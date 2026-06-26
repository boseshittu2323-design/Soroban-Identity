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

interface Props {
  history: ScoreHistoryEntry[];
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function ReputationChart({ history }: Props) {
  if (history.length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center", padding: "1rem 0" }}>
        No score history available.
      </p>
    );
  }

  return (
    <div style={{ width: "100%", height: 200 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={history} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
            {history.map((entry, i) => (
              <Cell key={i} fill={entry.delta >= 0 ? "var(--accent-light, #6ee7b7)" : "var(--error, #f87171)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
