import { describe, it, expect } from 'vitest';
import { toW3CDidDocument, exportDidDocumentAsJsonLd } from './serializers';
import type { DidDocument } from './types';

const mockDoc: DidDocument = {
  id: 'did:stellar:GABC1234567890',
  controller: 'GABC1234567890',
  metadata: { website: 'https://example.com', twitter: 'https://twitter.com/example' },
  createdAt: 1000000,
  updatedAt: 1000001,
  active: true,
};

describe('toW3CDidDocument', () => {
  it('includes the W3C DID context', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
  });

  it('sets id from doc.id', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.id).toBe('did:stellar:GABC1234567890');
  });

  it('sets controller from doc.controller', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.controller).toBe('GABC1234567890');
  });

  it('maps metadata entries to service array', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.service).toHaveLength(2);
    expect(result.service[0]).toMatchObject({
      id: 'did:stellar:GABC1234567890#website',
      type: 'LinkedDomains',
      serviceEndpoint: 'https://example.com',
    });
  });

  it('produces empty service array when metadata is empty', () => {
    const doc = { ...mockDoc, metadata: {} };
    const result = toW3CDidDocument(doc) as any;
    expect(result.service).toEqual([]);
  });

  it('includes an empty verificationMethod array', () => {
    const result = toW3CDidDocument(mockDoc) as any;
    expect(result.verificationMethod).toEqual([]);
  });
});

describe('exportDidDocumentAsJsonLd', () => {
  it('returns a valid JSON string', () => {
    const output = exportDidDocumentAsJsonLd(mockDoc);
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('parsed output contains @context field', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
  });

  it('parsed output contains correct id', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed.id).toBe('did:stellar:GABC1234567890');
  });

  it('parsed output contains correct controller', () => {
    const parsed = JSON.parse(exportDidDocumentAsJsonLd(mockDoc));
    expect(parsed.controller).toBe('GABC1234567890');
  });

  it('output is pretty-printed with 2-space indent', () => {
    const output = exportDidDocumentAsJsonLd(mockDoc);
    expect(output).toContain('\n  ');
  });
});
