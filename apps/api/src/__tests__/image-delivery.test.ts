import { describe, expect, it, vi } from 'vitest';
import { imageDeliveryUrl, imageSources, parseImageDeliveryPath, signedImagePath } from '../shared/image-delivery.js';
import { serializePublicImage } from '../modules/public/image-serialization.js';
import { createFileAccessService } from '../modules/file-access/service.js';
import { createUnavailableFileAccessRepository, type FileAccessRepository } from '../modules/file-access/repository.js';
import { defaultTestEnv } from './helpers/app-mocks.js';
import type { Env } from '../config/env.js';

const config: Env = { ...defaultTestEnv, LOG_LEVEL: 'info', GOOGLE_CLIENT_IDS: [...defaultTestEnv.GOOGLE_CLIENT_IDS], CORS_ALLOWED_ORIGINS: [...defaultTestEnv.CORS_ALLOWED_ORIGINS], IMAGE_DELIVERY_MODE: 'imgproxy', PUBLIC_ASSET_ORIGIN: 'https://images.test',
 S3_BUCKET_PUBLIC: 'public', S3_BUCKET_PROTECTED: 'protected', FILE_GATEWAY_SECRET: 's'.repeat(32),
 IMGPROXY_KEY: '11'.repeat(32), IMGPROXY_SALT: '22'.repeat(32) };
const key = 'public/images/한 글 %.png';

function fixture() {
 const project = { status: 'PUBLISHED', publicationStatus: 'PUBLIC', creatorId: 1, members: [], visibility: 'PUBLIC', exhibition: { visibility: 'PUBLIC' } };
 const representation = { role: 'ORIGINAL', state: 'READY', mimeType: 'image/png', asset: { kind: 'IMAGE', status: 'READY', project } };
 const repository = { ...createUnavailableFileAccessRepository(), votePoster: vi.fn(async () => null),
  findDeployment: vi.fn(async () => null), findRepresentation: vi.fn(async () => representation),
 } as unknown as FileAccessRepository;
 const service = createFileAccessService(repository, config);
 const uri = new URL(imageDeliveryUrl(config.PUBLIC_ASSET_ORIGIN!, key, 480)).pathname;
 const headers = { 'x-pcu-gateway-secret': config.FILE_GATEWAY_SECRET, 'x-pcu-file-kind': 'public', 'x-pcu-file-uri': uri };
 return { service, repository, representation, project, headers, uri };
}

describe('on-demand image delivery', () => {
 it('signs literal S3 keys without double-encoding percent or query characters', () => {
  const special = key + '?v=#1';
  const path = signedImagePath('public', special, 480, config.IMGPROXY_KEY!, config.IMGPROXY_SALT!);
  const source = path.split('/').at(-1)!.replace(/\.webp$/, '');
  expect(Buffer.from(source, 'base64url').toString()).toBe(`s3://public/${special}`);
  expect(path).not.toBe(signedImagePath('public', special, 960, config.IMGPROXY_KEY!, config.IMGPROXY_SALT!));
 });
 it('round trips exact unicode/object identity and rejects malformed routes', () => {
  expect(parseImageDeliveryPath(new URL(imageDeliveryUrl('https://images.test', key, 480)).pathname)).toEqual({ key, width: 480 });
  for (const path of ['/img/v1/999/YQ', '/img/v1/480/!', '/img/v1/0480/YQ', '/img/v2/480/YQ']) expect(parseImageDeliveryPath(path)).toBeNull();
  for (const invalid of ['../secret', '/absolute', 'a/../b', 'a\\b', 'a\nb']) expect(parseImageDeliveryPath(new URL(imageDeliveryUrl('https://images.test', invalid, 480)).pathname)).toBeNull();
 });
 it('does not enlarge small originals or emit duplicate widths', () => {
  expect(imageSources('https://images.test', key, 200, 100)).toEqual([{ url: imageDeliveryUrl('https://images.test', key, 320), width: 200, height: 100 }]);
  expect(imageSources('https://images.test', key, 1000, 500).map(s => s.width)).toEqual([320, 480, 768, 960, 1000]);
  expect(imageSources('https://images.test', key)).toEqual([]);
 });
 it('serializes a READY original without requiring stored derivatives', async () => {
  const result = await serializePublicImage({ representations: [{ role: 'ORIGINAL', state: 'READY', bucket: 'public', objectKey: key, width: 1600, height: 800 }] }, { publicAssetOrigin: 'https://images.test', publicBucket: 'public', imageDeliveryMode: 'imgproxy' });
  expect(result?.sources).toHaveLength(6);
  expect(result?.renditions).toEqual([]);
 });
 it('checks current access before returning the internal signed path, even after a successful request', async () => {
  const f = fixture();
  expect(await f.service.check(f.headers)).toEqual({ path: signedImagePath('public', key, 480, config.IMGPROXY_KEY!, config.IMGPROXY_SALT!), host: '', image: true });
  f.project.publicationStatus = 'PRIVATE';
  await expect(f.service.check(f.headers)).rejects.toThrow();
 });
 it('fails closed for missing/deleted originals and non-image sources', async () => {
  const f = fixture();
  f.representation.asset.status = 'DELETED';
  await expect(f.service.check(f.headers)).rejects.toThrow();
  f.representation.asset.status = 'READY'; f.representation.role = 'PLAYBACK';
  await expect(f.service.check(f.headers)).rejects.toThrow();
  await expect(f.service.check({ ...f.headers, 'x-pcu-gateway-secret': 'wrong' })).rejects.toThrow();
 });
 it('keeps retained vote snapshots accessible without substituting a current original', async () => {
  const f = fixture();
  vi.mocked(f.repository.votePoster!).mockResolvedValue({ objectKey: key } as never);
  vi.mocked(f.repository.findRepresentation).mockResolvedValue(null);
  expect(await f.service.check(f.headers)).toHaveProperty('image', true);
 });
 it('does not disclose a protected source or bypass expired capabilities', async () => {
  const f = fixture();
  await expect(f.service.check({ ...f.headers, 'x-pcu-file-kind': 'protected' })).rejects.toThrow();
  f.repository.token = vi.fn(async () => ({ expiresAt: new Date(0) })) as never;
  await expect(f.service.check({ ...f.headers, 'x-pcu-file-uri': `${f.uri}?pcu_token=${'a'.repeat(64)}` })).rejects.toThrow();
 });
 it('binds capability checks to the decoded original key, not the transform route', async () => {
  const f = fixture();
  f.repository.token = vi.fn(async () => ({ expiresAt: new Date(Date.now() + 60000), bucket: 'public', objectKey: 'different', sessionId: null })) as never;
  await expect(f.service.check({ ...f.headers, 'x-pcu-file-uri': `${f.uri}?pcu_token=${'a'.repeat(64)}` })).rejects.toThrow();
 });
});
