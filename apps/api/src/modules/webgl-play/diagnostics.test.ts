import { describe, expect, it } from 'vitest';
import { sanitizeConnectionReport } from './diagnostics.js';

describe('untrusted CSP connection reports', () => {
 it('keeps only origin and directive and strips URL credentials, paths and queries', () => {
  expect(sanitizeConnectionReport({ 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'wss://user:password@socket.example.com:8443/private?key=secret#token', 'script-sample': 'secret', 'original-policy': 'secret', 'document-uri': 'secret' } }))
   .toEqual({ origin: 'wss://socket.example.com:8443', directive: 'connect-src' });
 });
 it('discards unsupported and malformed reports without copying their contents', () => {
  for (const body of [null, [], 'secret', {}, { 'csp-report': null }, { 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'inline' } }, { 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'data:text/plain,secret' } }, { 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'not-a-url' } }]) expect(sanitizeConnectionReport(body)).toBeNull();
 });
});
