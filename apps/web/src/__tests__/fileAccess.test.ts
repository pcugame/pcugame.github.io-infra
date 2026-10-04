import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFileTokens, hydrateFileUrls } from '../lib/api/file-access';
import { api } from '../lib/api/client';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('media access capabilities', () => {
 it('hydrates originals, renditions, video downloads and WebGL without changing external links or inputs', async () => {
  const issue = vi.spyOn(api, 'post').mockImplementation(async (_path, body) => ({ url: `${(body as {url:string}).url}?pcu_token=secret`, token: 'secret', expiresAt: 'soon' }));
  const input = { githubUrl: 'https://github.com/test', poster: { original: { url: 'https://files.test/a' }, renditions: [{ url: 'https://files.test/a' }] }, videos: [{ originalDownloadUrl: 'https://files.test/video', playbackUrl: 'https://files.test/playback' }], webglUrl: 'https://files.test/webgl', webglPlayUrl: 'https://api.test/play/projects/7' };
  const result = await hydrateFileUrls(input);
  expect(result.poster.original.url).toContain('pcu_token=secret');
  expect(result.videos[0].originalDownloadUrl).toContain('pcu_token=secret');
  expect(result.videos[0].playbackUrl).toContain('pcu_token=secret');
  expect(result.webglUrl).toContain('pcu_token=secret');
  expect(result.githubUrl).toBe(input.githubUrl);
  expect(result.webglPlayUrl).toBe(input.webglPlayUrl);
  expect(input.poster.original.url).toBe('https://files.test/a');
  expect(issue).toHaveBeenCalledTimes(4);
 });
 it('fails closed if a capability cannot be issued', async () => {
  vi.spyOn(api, 'post').mockRejectedValue(new Error('forbidden'));
  await expect(hydrateFileUrls({ url: 'https://files.test/secret' })).rejects.toThrow('forbidden');
 });
 it('keeps named external links out of capability issuance and renewal, including change snapshots', async () => {
  const issue = vi.spyOn(api, 'post').mockRejectedValue(new Error('not a stored file'));
  const externalLinks = [{ label: 'GitHub', url: 'https://github.com/team/game' }, { label: 'Demo', url: 'https://example.com/play/external/index.html?pcu_token=external' }];
  const input = { externalLinks, before: { externalLinks }, changes: { externalLinks }, githubUrl: 'https://example.com/file/legacy' };
  await expect(hydrateFileUrls(input)).resolves.toEqual(input);
  expect(issue).not.toHaveBeenCalled();
  expect([...collectFileTokens(input)]).toEqual([]);
 });
 it('reads a real project response through the API client without requesting file access for external URLs', async () => {
  const externalLinks = [{ label: 'GitHub', url: 'https://github.com/team/game', service: 'github' }, { label: '다운로드', url: 'https://example.com/file/external?pcu_token=external' }, { label: '플레이', url: 'https://example.com/play/external/index.html' }];
  const fetcher = vi.fn(async (url: string) => {
   if (!url.endsWith('/api/public/projects/124')) return new Response('Not found', { status: 404 });
   return Response.json({ ok: true, data: { id: 124, externalLinks } });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await api.get('/api/public/projects/124');
  expect(result).toEqual({ id: 124, externalLinks });
  expect([...collectFileTokens(result)]).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('reads change snapshots through the real API client and hydrates only stored media', async () => {
  const externalLinks = [{ label: '자유 이름', url: 'https://example.com/play/external/index.html?pcu_token=external', service: 'youtube' }];
  const input = { before: { externalLinks, githubUrl: 'https://example.com/file/legacy' }, changes: { externalLinks }, stagedAssets: [{ previewUrl: 'https://media.example/image' }] };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
   if (url.endsWith('/api/admin/change-requests/123')) return Response.json({ ok: true, data: input });
   if (url.endsWith('/api/file-access') && JSON.parse(options?.body as string).url === 'https://media.example/image') return Response.json({ ok: true, data: { url: 'https://media.example/image?pcu_token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', expiresAt: null } });
   return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetcher);
  const result = await api.get<typeof input>('/api/admin/change-requests/123');
  expect(result.before).toEqual(input.before);
  expect(result.changes).toEqual(input.changes);
  expect(result.stagedAssets[0].previewUrl).toBe('https://media.example/image?pcu_token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  expect([...collectFileTokens(result)]).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('ignores project play routes and malformed capability tokens', () => {
  expect([...collectFileTokens({ webglPlayUrl: 'https://api.test/play/projects/7', file: 'https://files.test/file/projects', image: 'https://files.test/x?pcu_token=invalid', short: 'https://files.test/file/abc', long: `https://files.test/file/${'a'.repeat(65)}` })]).toEqual([]);
 });
 it('finds and deduplicates file and WebGL tokens for stable renewal', () => {
  expect([...collectFileTokens({ image: 'https://files.test/x?pcu_token=1111111111111111111111111111111111111111111111111111111111111111', play: 'https://files.test/play/2222222222222222222222222222222222222222222222222222222222222222/index.html', same: ['https://files.test/y?pcu_token=1111111111111111111111111111111111111111111111111111111111111111'], download: 'https://files.test/file/3333333333333333333333333333333333333333333333333333333333333333' })].sort()).toEqual(['1111111111111111111111111111111111111111111111111111111111111111', '2222222222222222222222222222222222222222222222222222222222222222', '3333333333333333333333333333333333333333333333333333333333333333']);
 });
});
