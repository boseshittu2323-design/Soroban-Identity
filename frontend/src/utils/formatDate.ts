import type React from 'react';

export function formatTimestamp(unix: number): string {
  if (unix === 0) return 'No expiry';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(unix * 1000));
}

export function getExpiryStyle(unix: number): React.CSSProperties {
  if (unix === 0) return { color: 'var(--text-muted)' };
  const diffMs = unix * 1000 - Date.now();
  if (diffMs < 0) return { color: 'var(--text-muted)' };
  if (diffMs < 7 * 24 * 60 * 60 * 1000) return { color: 'var(--warning)', fontWeight: 600 };
  return {};
}
