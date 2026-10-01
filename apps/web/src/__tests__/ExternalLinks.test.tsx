/* @vitest-environment jsdom */
import { StrictMode, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ExternalLink } from '@pcu/contracts';
import { ExternalLinksFieldset } from '../components/project/ExternalLinksFieldset';
import { ProjectPublicMeta } from '../components/project/ProjectPublicMeta';
import { effectiveExternalLinks } from '../components/project/externalLinks';
import { SubmitProjectPayloadSchema } from '../contracts/schemas';
import { buildSubmitFormData } from '../lib/utils/formData';
import { externalLinkApi } from '../lib/api/external-links';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function Editor({ initial = [], disabled = false }: { initial?: ExternalLink[]; disabled?: boolean }) {
 const [links, setLinks] = useState(initial);
 return <ExternalLinksFieldset value={links} onChange={setLinks} disabled={disabled} showErrors />;
}
describe('external links', () => {
 it('shows bundled decorative logos for recognized links, including legacy GitHub, and keeps labels and hrefs', () => {
  const links: ExternalLink[] = [
   { label: '직접 정한 영상 이름', url: 'https://youtu.be/demo' },
   { label: '파일', url: 'https://drive.google.com/file/d/demo' },
   { label: '코드', url: 'https://github.com/team/game' },
   { label: '플레이', url: 'https://team.itch.io/game' },
   { label: '스토어', url: 'https://store.steampowered.com/app/1' },
   { label: '문서', url: 'https://www.notion.so/game' },
   { label: '커뮤니티', url: 'https://discord.gg/team' },
   { label: '홈페이지', url: 'https://example.com' },
  ];
  const { container, rerender } = render(<ProjectPublicMeta externalLinks={links} />);
  for (const link of links) expect(screen.getByRole('link', { name: `${link.label} 링크 열기` }).getAttribute('href')).toBe(link.url);
  expect([...container.querySelectorAll('[data-service]')].map((node) => node.getAttribute('data-service'))).toEqual(['youtube', 'google-drive', 'github', 'itch-io', 'steam', 'notion', 'discord', 'generic']);
  expect(container.querySelectorAll('img[aria-hidden="true"][alt=""]')).toHaveLength(7);
  expect(screen.queryByRole('img')).toBeNull();
  rerender(<ProjectPublicMeta githubUrl="https://github.com/team/game" />);
  expect(container.querySelector('[data-service="github"]')).toBeTruthy();
 });
 it('debounces resolution through the real API client for 500ms without changing the label or URL', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ ok: true, data: { service: 'youtube' } }));
  vi.stubGlobal('fetch', fetcher);
  const { container } = render(<Editor initial={[{ label: '내 영상', url: '' }]} />);
  fireEvent.change(screen.getByLabelText('외부 링크 1 URL'), { target: { value: 'https://example.com/first' } });
  await act(() => vi.advanceTimersByTimeAsync(400));
  fireEvent.change(screen.getByLabelText('외부 링크 1 URL'), { target: { value: 'https://example.com/final' } });
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(fetcher).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual([expect.stringContaining('/api/me/external-links/resolve'), expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ url: 'https://example.com/final' }) })]);
  expect(container.querySelector('[data-service="youtube"]')).toBeTruthy();
  expect((screen.getByLabelText('외부 링크 1 이름') as HTMLInputElement).value).toBe('내 영상');
  expect((screen.getByLabelText('외부 링크 1 URL') as HTMLInputElement).value).toBe('https://example.com/final');
 });
 it('ignores obsolete responses even when the resolver ignores cancellation and preserves edits made in flight', async () => {
  vi.useFakeTimers();
  let finishOld!: (value: { service: 'youtube' }) => void;
  let finishNew!: (value: { service: 'discord' }) => void;
  vi.spyOn(externalLinkApi, 'resolve')
   .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
   .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
  const { container } = render(<Editor initial={[{ label: '내 링크', url: 'https://example.com/old' }]} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  fireEvent.change(screen.getByLabelText('외부 링크 1 URL'), { target: { value: 'https://example.com/new' } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  fireEvent.change(screen.getByLabelText('외부 링크 1 이름'), { target: { value: '수정한 이름' } });
  await act(async () => { finishNew({ service: 'discord' }); });
  await act(async () => { finishOld({ service: 'youtube' }); });
  expect(container.querySelector('[data-service="discord"]')).toBeTruthy();
  expect(container.querySelector('[data-service="youtube"]')).toBeNull();
  expect((screen.getByLabelText('외부 링크 1 이름') as HTMLInputElement).value).toBe('수정한 이름');
  expect((screen.getByLabelText('외부 링크 1 URL') as HTMLInputElement).value).toBe('https://example.com/new');
 });
 it('cancels pending resolution for removed rows and disabled or invalid inputs', async () => {
  vi.useFakeTimers();
  const resolve = vi.spyOn(externalLinkApi, 'resolve').mockResolvedValue({ service: null });
  const { rerender } = render(<Editor initial={[{ label: '게임', url: 'https://example.com' }]} />);
  fireEvent.click(screen.getByRole('button', { name: '외부 링크 1 삭제' }));
  await act(() => vi.advanceTimersByTimeAsync(500));
  rerender(<Editor key="disabled" disabled initial={[{ label: '게임', url: 'https://example.com' }]} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  rerender(<Editor key="invalid" initial={[{ label: '게임', url: 'javascript:alert(1)' }]} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(resolve).not.toHaveBeenCalled();
 });
 it('resolves in StrictMode with a live abort signal and aborts requests on unmount', async () => {
  vi.useFakeTimers();
  const resolve = vi.spyOn(externalLinkApi, 'resolve').mockResolvedValue({ service: 'github' });
  const { container, unmount } = render(<StrictMode><Editor initial={[{ label: '코드', url: 'https://example.com/code' }]} /></StrictMode>);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(resolve).toHaveBeenCalledTimes(1);
  const signal = resolve.mock.calls[0][1]!;
  expect(signal.aborted).toBe(false);
  expect(container.querySelector('[data-service="github"]')).toBeTruthy();
  unmount();
  expect(signal.aborted).toBe(true);
 });
 it('reuses completed and pending resolutions when another row changes', async () => {
  vi.useFakeTimers();
  let finish!: (value: { service: 'youtube' }) => void;
  const resolve = vi.spyOn(externalLinkApi, 'resolve')
   .mockImplementationOnce(() => new Promise((done) => { finish = done; }))
   .mockResolvedValue({ service: null });
  render(<Editor initial={[{ label: '영상', url: 'https://example.com/video' }, { label: '게임', url: 'https://example.com/game' }]} />);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(resolve).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('외부 링크 2 URL'), { target: { value: 'https://example.com/new-game' } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(resolve).toHaveBeenCalledTimes(3);
  await act(async () => { finish({ service: 'youtube' }); });
  fireEvent.change(screen.getByLabelText('외부 링크 2 URL'), { target: { value: 'https://example.com/game' } });
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(resolve).toHaveBeenCalledTimes(3);
 });
 it('adds, edits and removes arbitrary links', () => {
  render(<Editor />);
  fireEvent.click(screen.getByRole('button', { name: '링크 추가' }));
  fireEvent.change(screen.getByLabelText('외부 링크 1 이름'), { target: { value: '게임 다운로드' } });
  fireEvent.change(screen.getByLabelText('외부 링크 1 URL'), { target: { value: 'https://example.com/game' } });
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '링크 추가' }));
  expect(screen.getByLabelText('외부 링크 2 URL')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '외부 링크 1 삭제' }));
  fireEvent.click(screen.getByRole('button', { name: '외부 링크 1 삭제' }));
  expect(screen.queryByRole('textbox')).toBeNull();
 });
 it('enforces safe URL validation and the row limit', () => {
  const { rerender } = render(<Editor initial={[{ label: '링크', url: 'javascript:alert(1)' }]} />);
  expect(screen.getByLabelText('외부 링크 1 URL').getAttribute('aria-invalid')).toBe('true');
  rerender(<Editor key="limit" initial={Array.from({ length: 20 }, () => ({ label: '링크', url: 'https://example.com' }))} />);
  expect((screen.getByRole('button', { name: '링크 추가' }) as HTMLButtonElement).disabled).toBe(true);
 });
 it('shows named safe links, suppresses unsafe links and never revives a cleared legacy link', () => {
  const { rerender } = render(<ProjectPublicMeta externalLinks={[{ label: '게임', url: 'https://example.com' }, { label: '위험', url: 'data:text/html,test' }]} githubUrl="https://github.com/old" />);
  expect(screen.getByRole('link', { name: '게임 링크 열기' }).getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.queryByRole('link', { name: '위험 링크 열기' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'GitHub 링크 열기' })).toBeNull();
  rerender(<ProjectPublicMeta externalLinks={[]} githubUrl="https://github.com/old" />);
  expect(screen.queryByRole('link')).toBeNull();
  expect(effectiveExternalLinks(undefined, 'https://github.com/old')).toEqual([{ label: 'GitHub', url: 'https://github.com/old' }]);
  expect(effectiveExternalLinks(undefined, 'javascript:alert(1)')).toEqual([]);
 });
 it('validates and serializes trimmed submission links and explicit clearing', () => {
  const base = { exhibitionId: 1, title: '게임', members: [{ name: '학생', studentId: '20260001' }] };
  const payload = SubmitProjectPayloadSchema.parse({ ...base, externalLinks: [{ label: ' 다운로드 ', url: ' https://example.com/game ' }] });
  const data = buildSubmitFormData({ ...payload, manifest: [] }, {});
  expect(JSON.parse(data.get('payload') as string).externalLinks).toEqual([{ label: '다운로드', url: 'https://example.com/game' }]);
  expect(SubmitProjectPayloadSchema.parse({ ...base, externalLinks: [] }).externalLinks).toEqual([]);
  expect(SubmitProjectPayloadSchema.safeParse({ ...base, externalLinks: [{ label: '', url: 'ftp://example.com' }] }).success).toBe(false);
 });
});
