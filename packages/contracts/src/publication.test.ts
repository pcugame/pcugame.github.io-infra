import { describe, expect, it } from 'vitest';
import { publicationReadiness, type PublicationSource } from './publication.js';
const rep = (role: string, state = 'READY') => ({ role, state });
const complete = (): PublicationSource => ({ title: 'Game', summary: 'Summary', platforms: ['PC'], members: [{ name: 'Student', studentId: '1' }], poster: { status: 'READY', representations: ['ORIGINAL', 'CARD_480', 'DISPLAY_960'].map(r => rep(r)) }, assets: [{ kind: 'GAME', status: 'READY', representations: [rep('ORIGINAL')] }, { kind: 'VIDEO', status: 'READY', representations: [rep('ORIGINAL'), rep('PLAYBACK')] }] });
describe('publication readiness', () => {
 it('does not require WebGL or screenshots', () => expect(publicationReadiness(complete()).ready).toBe(true));
 it.each(['title', 'summary', 'platforms', 'members', 'poster', 'nativeBuild', 'video'] as const)('requires %s', key => {
  const source = complete();
  if (key === 'title' || key === 'summary') source[key] = ' \n\t ';
  else if (key === 'platforms' || key === 'members') source[key] = [];
  else if (key === 'poster') source.poster = null;
  else source.assets = source.assets.filter(a => a.kind !== (key === 'video' ? 'VIDEO' : 'GAME'));
  expect(publicationReadiness(source).blockers).toContain(key);
 });
 it('does not substitute WebGL or video original for required media', () => {
  const source = complete(); source.assets = [{ kind: 'WEBGL', representations: [rep('WEBGL_SOURCE')] }, { kind: 'VIDEO', representations: [rep('ORIGINAL')] }];
  expect(publicationReadiness(source).blockers).toEqual(['nativeBuild', 'video']);
 });
 it('distinguishes pending and failed playback, and restricts exception eligibility', () => {
  const source = complete(); source.assets = [...source.assets.filter(a => a.kind !== 'VIDEO'), { kind: 'VIDEO', representations: [rep('ORIGINAL'), rep('PLAYBACK', 'PENDING')] }];
  expect(publicationReadiness(source).requirements.at(-1)?.state).toBe('PROCESSING');
  source.assets = [{ kind: 'VIDEO', representations: [rep('PLAYBACK', 'FAILED')] }];
  expect(publicationReadiness(source).requirements.at(-1)?.state).toBe('FAILED');
  for (const role of ['USER', 'OPERATOR', 'ADMIN']) expect(publicationReadiness(source, role).canOverride).toBe(role === 'ADMIN');
 });
});
