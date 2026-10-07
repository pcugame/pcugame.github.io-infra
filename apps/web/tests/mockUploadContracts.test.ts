/** Verify the mock control plane against the real API's route response contracts. */
import { File as NodeFile } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRouteRuntimeContract } from '../../api/src/shared/http-route-schemas';
import { createFileSourceIdentity } from '../src/lib/file-identity';
import { mockFetch, resetMockState, selectMockUser, getMockSnapshot } from '../src/lib/api/mock/transport';

async function checkedResponse(method: string, runtimeUrl: string, path: string, body?: unknown, expectedStatus = 200) {
  const response = await mockFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(response.status).toBe(expectedStatus);
  const envelope = await response.json();
  const schema = findRouteRuntimeContract(method, runtimeUrl)!.response[expectedStatus]!;
  // Real route schemas strip unknown fields; equality also detects internal fields that would be stripped by production serialization.
  expect(schema.parse(envelope)).toEqual(envelope);
  return envelope.data;
}
beforeEach(async () => { vi.useFakeTimers(); await resetMockState(); await selectMockUser('ADMIN'); });
afterEach(() => vi.useRealTimers());

describe('mock direct uploads match real API route serialization', () => {
  it('returns exact creation/status/capability/completion shapes, absolute capabilities and opaque ETag', async () => {
    const file = new NodeFile(['demo'], 'game.zip');
    const identity = await createFileSourceIdentity(file as File);
    const created = await checkedResponse('POST', '/api/admin/projects/:id/direct-game-upload-sessions', '/api/admin/projects/1/direct-game-upload-sessions', { originalName: file.name, totalBytes: file.size, ...identity }, 201);
    expect(created.sourceIdentityBlockSizeBytes).toBe(1048576);
    const sessionPath = `/api/admin/direct-asset-upload-sessions/${created.sessionId}`;
    const before = await checkedResponse('GET', '/api/admin/direct-asset-upload-sessions/:sessionId', sessionPath);
    expect(before).toMatchObject({ state: 'UPLOADING', parts: [] });
    const checksumSha256 = Buffer.from(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())).toString('base64');
    const signed = await checkedResponse('POST', '/api/admin/direct-asset-upload-sessions/:sessionId/part-urls', `${sessionPath}/part-urls`, { generation: created.generation, parts: [{ partNumber: 1, checksumSha256 }] });
    expect(new URL(signed.parts[0].url).pathname).toContain('/mock/garage-upload/');
    const uploaded = await mockFetch(signed.parts[0].url, { method: 'PUT', body: file, headers: signed.parts[0].requiredHeaders });
    expect(uploaded.status).toBe(200); const etag = uploaded.headers.get('etag'); expect(etag).toBeTruthy();
    const populated = await checkedResponse('GET', '/api/admin/direct-asset-upload-sessions/:sessionId', sessionPath);
    expect(populated.parts).toEqual([{ partNumber: 1, etag, sizeBytes: file.size }]);
    await checkedResponse('POST', '/api/admin/direct-asset-upload-sessions/:sessionId/complete', `${sessionPath}/complete`, { generation: created.generation, parts: populated.parts });
    await vi.advanceTimersByTimeAsync(400);
    const verifying = await checkedResponse('GET', '/api/admin/direct-asset-upload-sessions/:sessionId', sessionPath);
    expect(verifying.state).toBe('VERIFYING'); expect(verifying).not.toHaveProperty('processingState');
    expect((await getMockSnapshot()).sessions[created.sessionId]).toMatchObject({ processingState: 'PROCESSING' });
    await vi.advanceTimersByTimeAsync(600);
    expect((await checkedResponse('GET', '/api/admin/direct-asset-upload-sessions/:sessionId', sessionPath)).state).toBe('READY');
  });
});
