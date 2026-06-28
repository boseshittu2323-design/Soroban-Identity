export type SkeletonVariant = 'credential' | 'identity' | 'reputation';

interface Props {
  rows?: number;
  variant?: SkeletonVariant;
}

function CredentialSkeleton() {
  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div className="skeleton" style={{ width: '2rem', height: '2rem', borderRadius: '0.25rem', flexShrink: 0 }} />
        <div className="skeleton skeleton-title" style={{ flex: 1 }} />
        <div className="skeleton" style={{ width: '4rem', height: '1.2rem', borderRadius: '999px' }} />
        <div className="skeleton" style={{ width: '3.5rem', height: '1.2rem', borderRadius: '999px' }} />
      </div>
      <div className="skeleton skeleton-row" style={{ width: '100%' }} />
      <div className="skeleton skeleton-row" style={{ width: '75%' }} />
    </div>
  );
}

function IdentitySkeleton() {
  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div className="skeleton skeleton-title" style={{ width: '60%', marginBottom: '0.75rem' }} />
      <div className="skeleton skeleton-row" style={{ width: '100%' }} />
      <div className="skeleton skeleton-row" style={{ width: '100%' }} />
      <div className="skeleton skeleton-row" style={{ width: '85%' }} />
      <div className="skeleton skeleton-row" style={{ width: '90%' }} />
      <div className="skeleton skeleton-row" style={{ width: '60%' }} />
    </div>
  );
}

function ReputationSkeleton() {
  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div className="skeleton skeleton-title" style={{ width: '40%', marginBottom: '0.75rem' }} />
      <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem' }}>
        <div className="skeleton" style={{ width: '3rem', height: '3rem', borderRadius: '50%' }} />
        <div style={{ flex: 1 }}>
          <div className="skeleton skeleton-row" style={{ width: '100%' }} />
          <div className="skeleton skeleton-row" style={{ width: '60%' }} />
        </div>
      </div>
      <div className="skeleton skeleton-row" style={{ width: '100%', height: '4rem' }} />
    </div>
  );
}

export default function SkeletonCard({ rows = 3, variant }: Props) {
  if (variant === 'credential') return <CredentialSkeleton />;
  if (variant === 'identity') return <IdentitySkeleton />;
  if (variant === 'reputation') return <ReputationSkeleton />;

  return (
    <div className="card skeleton-card" aria-busy="true" aria-label="Loading…">
      <div className="skeleton skeleton-title" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton skeleton-row" style={{ width: i === rows - 1 ? "60%" : "100%" }} />
      ))}
    </div>
  );
}
