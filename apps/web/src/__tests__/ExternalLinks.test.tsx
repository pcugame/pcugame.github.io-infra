/* @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ExternalLink } from '@pcu/contracts';
import { ExternalLinksFieldset } from '../components/project/ExternalLinksFieldset';
import { ProjectPublicMeta } from '../components/project/ProjectPublicMeta';
import { effectiveExternalLinks } from '../components/project/externalLinks';
import { SubmitProjectPayloadSchema } from '../contracts/schemas';
import { buildSubmitFormData } from '../lib/utils/formData';

afterEach(cleanup);
function Editor({ initial = [], disabled = false }: { initial?: ExternalLink[]; disabled?: boolean }) {
 const [links, setLinks] = useState(initial);
 return <ExternalLinksFieldset value={links} onChange={setLinks} disabled={disabled} showErrors />;
}
describe('external links', () => {
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
