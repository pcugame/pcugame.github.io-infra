/* @vitest-environment jsdom */
import { useForm, useWatch } from 'react-hook-form';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const mocks = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue({ id: 1, year: 2026, visibility: 'STAFF' }) }));
vi.mock('../features/auth', () => ({ useMe: () => ({ user: { id: 1, role: 'OPERATOR' }, isPending: false }) }));
vi.mock('../lib/api', () => ({ adminExhibitionApi: { list: async () => ({ items: [] }), create: mocks.create }, adminExportApi: { status: vi.fn(), run: vi.fn() }, isApiError: () => false, getApiErrorMessage: String }));
import AdminYearsPage from '../pages/admin/AdminYearsPage';
vi.mock('../lib/env', () => ({ env: { VISIBILITY_CONTROLS_ENABLED: true } }));
import { VisibilityNotice, VisibilitySelect } from '../components/VisibilitySelect';
afterEach(cleanup);
describe('visibility controls', () => {
 it('blocks exhibition creation until the form selection is explicit and sends that value', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminYearsPage /></QueryClientProvider>);
  const button = await screen.findByRole('button', { name: '추가' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('combobox', { name: '공개 범위' }));
  fireEvent.click(screen.getByRole('option', { name: '운영자·관리자' }));
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'STAFF' })));
  client.clear();
 });
 it('requires an explicit exhibition choice and shows all shared labels', () => {
  const { container } = render(<VisibilitySelect defaultValue="" required />);
  expect(container.querySelector('select')!.checkValidity()).toBe(false);
  fireEvent.click(screen.getByRole('combobox'));
  expect(screen.getByRole('option', { name: '전체 공개' })).toBeTruthy();
  expect(screen.getByRole('option', { name: '로그인 사용자' })).toBeTruthy();
  expect(screen.getByRole('option', { name: '운영자·관리자' })).toBeTruthy();
 });
 it('submits custom choices through React Hook Form and reflects resets and setValue', async () => {
  const submitted = vi.fn();
  function Form() {
   const { register, handleSubmit, control, reset, setValue, formState: { touchedFields } } = useForm<{ visibility: string }>({ defaultValues: { visibility: 'PUBLIC' } });
   const visibility = useWatch({ control, name: 'visibility' });
   return <form onSubmit={handleSubmit(submitted)}>
    <label htmlFor="visibility">공개 범위</label>
    <VisibilitySelect id="visibility" value={visibility} {...register('visibility')} />
    <button type="submit">저장</button>
    <button type="button" onClick={() => reset({ visibility: 'AUTHENTICATED' })}>초기화</button>
    <button type="button" onClick={() => setValue('visibility', 'PUBLIC')}>전체로 변경</button>
    <output>{touchedFields.visibility ? 'touched' : 'untouched'}</output>
   </form>;
  }
  const { container } = render(<Form />);
  const trigger = screen.getByRole('combobox');
  expect(trigger.textContent).toContain('전체 공개');
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
  expect(trigger.textContent).toContain('운영자·관리자');
  expect(new FormData(container.querySelector('form')!).get('visibility')).toBe('STAFF');
  fireEvent.blur(trigger, { relatedTarget: screen.getByRole('button', { name: '저장' }) });
  await waitFor(() => expect(screen.getByText('touched')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  await waitFor(() => expect(submitted).toHaveBeenCalledWith({ visibility: 'STAFF' }, expect.anything()));
  fireEvent.click(screen.getByRole('button', { name: '초기화' }));
  expect(trigger.textContent).toContain('로그인 사용자');
  fireEvent.click(screen.getByRole('button', { name: '전체로 변경' }));
  expect(trigger.textContent).toContain('전체 공개');
 });
 it('initializes its display from the forwarded register ref', async () => {
  function Form() {
   const { register, reset } = useForm<{ visibility: string }>({ defaultValues: { visibility: 'STAFF' } });
   return <form><VisibilitySelect {...register('visibility')} /><button type="button" onClick={() => reset({ visibility: 'PUBLIC' })}>reset</button></form>;
  }
  render(<Form />);
  expect(screen.getByRole('combobox').textContent).toContain('운영자·관리자');
  fireEvent.click(screen.getByRole('button', { name: 'reset' }));
  await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('전체 공개'));
 });
 it('restores uncontrolled values on native form reset', async () => {
  const { container } = render(<form><VisibilitySelect name="visibility" defaultValue="PUBLIC" /><button type="reset">reset</button></form>);
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: '로그인 사용자' }));
  expect(screen.getByRole('combobox').textContent).toContain('로그인 사용자');
  fireEvent.click(screen.getByRole('button', { name: 'reset' }));
  await waitFor(() => expect(screen.getByRole('combobox').textContent).toContain('전체 공개'));
  expect(new FormData(container.querySelector('form')!).get('visibility')).toBe('PUBLIC');
 });
 it('closes with Escape, outside pointers and blur while preserving the selection', () => {
  render(<><VisibilitySelect defaultValue="PUBLIC" /><button>next</button></>);
  const trigger = screen.getByRole('combobox');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const panel = screen.getByRole('listbox');
  fireEvent.keyDown(panel, { key: 'ArrowDown' });
  fireEvent.keyDown(panel, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.blur(screen.getByRole('listbox'), { relatedTarget: screen.getByRole('button', { name: 'next' }) });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(trigger.textContent).toContain('전체 공개');
 });
 it('blocks choices in a disabled fieldset even when a panel was already open', () => {
  const changed = vi.fn();
  const { rerender } = render(<fieldset><VisibilitySelect defaultValue="PUBLIC" onChange={changed} /></fieldset>);
  fireEvent.click(screen.getByRole('combobox'));
  rerender(<fieldset disabled><VisibilitySelect defaultValue="PUBLIC" onChange={changed} /></fieldset>);
  fireEvent.click(screen.getByRole('option', { name: '운영자·관리자' }));
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'End' });
  fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' });
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox').textContent).toContain('전체 공개');
 });
 it('explains the effective exhibition restriction only when it is stricter', () => {
  const { rerender } = render(<VisibilityNotice visibility="PUBLIC" exhibitionVisibility="STAFF" />);
  expect(screen.getByText(/전시회의 공개 범위/)).toBeTruthy();
  rerender(<VisibilityNotice visibility="STAFF" exhibitionVisibility="AUTHENTICATED" />);
  expect(screen.queryByText(/전시회의 공개 범위/)).toBeNull();
 });
});
