import { describe, it, expect } from 'vitest';
import { formatAddress } from './formatAddress';

describe('formatAddress', () => {
  it('truncates a full 56-char Stellar address with default prefix/suffix lengths', () => {
    const addr = 'GABC123456789012345678901234567890123456789012345678WXYZ';
    expect(formatAddress(addr)).toBe('GABC…WXYZ');
  });

  it('truncates with custom prefix and suffix lengths', () => {
    const addr = 'GABC123456789012345678901234567890123456789012345678WXYZ';
    expect(formatAddress(addr, 6, 6)).toBe('GABC12…78WXYZ');
  });

  it('returns the original address if it is short enough', () => {
    expect(formatAddress('GABC123')).toBe('GABC123');
    expect(formatAddress('GABC...XYZ')).toBe('GABC...XYZ');
  });

  it('handles empty string and falsy input gracefully', () => {
    expect(formatAddress('')).toBe('');
    // @ts-expect-error testing invalid runtime input
    expect(formatAddress(null)).toBe('');
    // @ts-expect-error testing invalid runtime input
    expect(formatAddress(undefined)).toBe('');
  });
});
