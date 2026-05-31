import type { DidDocument } from './types';

/**
 * Convert a Soroban-Identity {@link DidDocument} into a W3C DID Core 1.0
 * JSON-LD shape.
 *
 * Each metadata entry is mapped to a `service` object using `LinkedDomains` as
 * the type. The contract does not track verification methods, so that array is
 * always empty.
 *
 * @param doc DID document as returned by {@link IdentityClient.resolveDid}.
 * @returns A plain object conforming to the W3C DID Core 1.0 shape.
 */
export function toW3CDidDocument(doc: DidDocument): object {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: doc.id,
    controller: doc.controller,
    verificationMethod: [],
    service: Object.entries(doc.metadata).map(([id, serviceEndpoint]) => ({
      id: `${doc.id}#${id}`,
      type: 'LinkedDomains',
      serviceEndpoint,
    })),
  };
}

/**
 * Convenience wrapper around {@link toW3CDidDocument} that returns a
 * 2-space-indented JSON-LD string ready for file output or HTTP response.
 *
 * @param doc DID document to serialise.
 * @returns Pretty-printed JSON-LD string.
 */
export function exportDidDocumentAsJsonLd(doc: DidDocument): string {
  return JSON.stringify(toW3CDidDocument(doc), null, 2);
}
