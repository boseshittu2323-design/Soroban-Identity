/**
 * Truncates a Stellar (or any long) address for display.
 *
 * @param address   Full G… address (typically 56 chars) or any identifier.
 * @param prefixLen Characters to show at the start (default 4).
 * @param suffixLen Characters to show at the end  (default 4).
 * @returns         Truncated string like "GABC…WXYZ", or the original string
 *                  if it is already short enough to display in full.
 *
 * @example
 * formatAddress('GABC...WXYZ56chars');      // → 'GABC…WXYZ'
 * formatAddress('GABC...WXYZ56chars', 6, 6); // → 'GABCDE…UVWXYZ'
 * formatAddress('GABC');                    // → 'GABC'   (too short to truncate)
 * formatAddress('');                        // → ''
 */
export function formatAddress(
  address: string,
  prefixLen = 4,
  suffixLen = 4,
): string {
  if (!address) return '';
  if (address.length <= prefixLen + suffixLen + 3) return address;
  return `${address.slice(0, prefixLen)}…${address.slice(-suffixLen)}`;
}
