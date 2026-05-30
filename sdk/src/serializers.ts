import type { DidDocument } from './types';

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

export function exportDidDocumentAsJsonLd(doc: DidDocument): string {
  return JSON.stringify(toW3CDidDocument(doc), null, 2);
}
