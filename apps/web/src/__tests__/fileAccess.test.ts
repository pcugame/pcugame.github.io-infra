import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFileTokens, hydrateFileUrls } from '../lib/api/file-access';
import { api } from '../lib/api/client';

afterEach(() => vi.restoreAllMocks());

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
 it('finds and deduplicates file and WebGL tokens for stable renewal', () => {
  expect([...collectFileTokens({ image: 'https://files.test/x?pcu_token=one', play: 'https://files.test/play/two/index.html', same: ['https://files.test/y?pcu_token=one'], download: 'https://files.test/file/three' })].sort()).toEqual(['one', 'three', 'two']);
 });
});
