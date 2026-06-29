import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContentType } from '../src/http-utils.js';

function makeReq(method, contentType) {
  return { method, headers: contentType !== undefined ? { 'content-type': contentType } : {} };
}

function makeRes() {
  const res = { _status: null, _body: null };
  res.writeHead = (status) => { res._status = status; return res; };
  res.end = (body) => { res._body = body; };
  return res;
}

// Non-JSON Content-Type on POST returns 415 UNSUPPORTED_MEDIA_TYPE
test('POST with form content-type returns 415', () => {
  const req = makeReq('POST', 'application/x-www-form-urlencoded');
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, true);
  assert.equal(res._status, 415);
  assert.match(res._body, /UNSUPPORTED_MEDIA_TYPE/);
});

// Missing Content-Type on POST returns 415
test('POST with missing content-type returns 415', () => {
  const req = makeReq('POST', undefined);
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, true);
  assert.equal(res._status, 415);
});

// Correct Content-Type on POST passes through
test('POST with application/json passes', () => {
  const req = makeReq('POST', 'application/json; charset=utf-8');
  const res = makeRes();
  const result = validateContentType(req, res);
  assert.equal(result, false);
  assert.equal(res._status, null);
});

// GET is unaffected regardless of Content-Type
test('GET is unaffected', () => {
  const req = makeReq('GET', 'text/plain');
  const res = makeRes();
  assert.equal(validateContentType(req, res), false);
});

// DELETE is unaffected
test('DELETE is unaffected', () => {
  const req = makeReq('DELETE', undefined);
  const res = makeRes();
  assert.equal(validateContentType(req, res), false);
});

// PATCH with wrong content-type returns 415
test('PATCH with wrong content-type returns 415', () => {
  const req = makeReq('PATCH', 'multipart/form-data');
  const res = makeRes();
  assert.equal(validateContentType(req, res), true);
  assert.equal(res._status, 415);
});
