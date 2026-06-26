interface Props {
  rows?: number;
}

export default function SkeletonCard({ rows = 3 }: Props) {
  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div className="skeleton skeleton-title" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-row" style={{ width: i === rows - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
}
