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

import { flattenSubject } from './serializers';

// ─── #420 — flattenSubject regression ─────────────────────────────────────────

describe('flattenSubject (#420)', () => {
  it('passes flat string subjects through unchanged', () => {
    const input = { name: 'Alice', country: 'US' };
    expect(flattenSubject(input)).toEqual({ name: 'Alice', country: 'US' });
  });

  it('flattens one level of nesting using dot-notation keys', () => {
    const input = { address: { city: 'NYC', zip: '10001' } };
    expect(flattenSubject(input)).toEqual({
      'address.city': 'NYC',
      'address.zip': '10001',
    });
  });

  it('flattens two levels of nesting', () => {
    const input = {
      contact: { address: { city: 'Berlin', country: 'DE' } },
    };
    expect(flattenSubject(input)).toEqual({
      'contact.address.city': 'Berlin',
      'contact.address.country': 'DE',
    });
  });

  it('mixes flat and nested fields', () => {
    const input = {
      name: 'Bob',
      address: { city: 'Paris' },
    };
    expect(flattenSubject(input)).toEqual({
      name: 'Bob',
      'address.city': 'Paris',
    });
  });

  it('produces identical output for flat subjects as direct key access', () => {
    const flat = { role: 'admin', level: '2' };
    expect(flattenSubject(flat)).toEqual(flat);
  });

  it('converts non-string leaf values to strings', () => {
    // Credentials claims are string→string on-chain, so numeric values must
    // be coerced the same way the contract does.
    const input = { score: 42, active: true } as unknown as Record<string, unknown>;
    const result = flattenSubject(input);
    expect(result['score']).toBe('42');
    expect(result['active']).toBe('true');
  });
});
