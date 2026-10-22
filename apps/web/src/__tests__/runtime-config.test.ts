import { describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig, parseRuntimeConfig } from '../lib/env/runtime-config';

const valid = { apiBaseUrl: 'https://api.pcu.test', googleClientId: 'test-client', visibilityControlsEnabled: false };

describe('container public configuration', () => {
  it('accepts explicit false and HTTPS origin', () => {
    expect(parseRuntimeConfig(valid)).toEqual(valid);
  });
  it.each([null, [], {}, { ...valid, apiBaseUrl: 'http://localhost:4000' },
    { ...valid, apiBaseUrl: 'https://api.pcu.test/path' }, { ...valid, apiBaseUrl: 'https://user:pass@api.pcu.test' },
    { ...valid, googleClientId: '' }, { ...valid, visibilityControlsEnabled: 'false' }, { ...valid, secret: 'unexpected' },
  ])('rejects invalid config without a localhost fallback: %j', value => {
    expect(() => parseRuntimeConfig(value)).toThrow();
  });
  it('rejects missing files, SPA fallback HTML and malformed JSON', async () => {
    for (const response of [new Response('', { status: 404 }), new Response('<html>', { headers: { 'Content-Type': 'text/html' } }), new Response('{', { headers: { 'Content-Type': 'application/json' } })]) {
      await expect(loadRuntimeConfig(vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
  });
  it('loads without reusing a cached response or sending credentials', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(valid));
    await loadRuntimeConfig(fetcher);
    expect(fetcher).toHaveBeenCalledWith('/runtime-config.json', expect.objectContaining({ cache: 'no-store', credentials: 'omit' }));
  });
});
