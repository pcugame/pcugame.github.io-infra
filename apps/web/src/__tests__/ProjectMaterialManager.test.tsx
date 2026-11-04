/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectMaterialManager, MaterialUploadSummary } from '../components/project/editor/ProjectMaterialManager';
import { materialGroups } from '../components/project/editor/materialGroups';
import { MaterialFileRow } from '../components/project/editor/MaterialFileRow';
import type { FileUploadRowState } from '../lib/upload/fileUploadQueue';

afterEach(cleanup);
const groups = (failed = false) => materialGroups.map(group => ({ id: group.id, count: 1, failed: failed && group.id === 'video', content: <input aria-label={`${group.label} 초안`} defaultValue="보존됨" /> }));
it('keeps every panel mounted, supports arrow keys, and only selects a processing kind when work begins', () => {
 const { rerender } = render(<ProjectMaterialManager groups={groups()} />);
 const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
 expect(tab('포스터').getAttribute('aria-selected')).toBe('true');
 fireEvent.change(screen.getByLabelText('포스터 초안'), { target: { value: '유지할 값' } });
 fireEvent.keyDown(tab('포스터'), { key: 'End' });
 expect(document.activeElement).toBe(tab('기타 자료'));
 rerender(<ProjectMaterialManager groups={groups()} busy firstKind="GAME" />);
 expect(tab('네이티브').getAttribute('aria-selected')).toBe('true');
 fireEvent.click(tab('웹 빌드'));
 rerender(<ProjectMaterialManager groups={groups(true)} busy firstKind="VIDEO" />);
 expect(tab('웹 빌드').getAttribute('aria-selected')).toBe('true');
 fireEvent.click(screen.getByRole('button', { name: '실패 파일 보기' }));
 expect(tab('동영상').getAttribute('aria-selected')).toBe('true');
 expect(document.activeElement).toBe(tab('동영상'));
 fireEvent.keyDown(tab('동영상'), { key: 'Home' });
 expect((screen.getByLabelText('포스터 초안') as HTMLInputElement).value).toBe('유지할 값');
});
it('supports menu navigation, disabled actions, Escape focus restoration, outside clicks and action execution', () => {
 const remove = vi.fn();
 render(<MaterialFileRow name="demo.webm" kind="VIDEO" status="재생 가능" actions={[{ label: '영상 다시 변환', onClick: vi.fn(), disabled: true }, { label: '삭제', onClick: remove }, { label: '다른 작업', onClick: vi.fn() }]} />);
 const trigger = screen.getByRole('button', { name: 'demo.webm 더보기' });
 fireEvent.click(trigger);
 expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '삭제' }));
 fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
 expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '다른 작업' }));
 fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
 expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(trigger);
 fireEvent.keyDown(trigger, { key: 'ArrowDown' });
 fireEvent.pointerDown(document.body);
 expect(screen.queryByRole('menu')).toBeNull();
 fireEvent.click(trigger); fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
 expect(remove).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(trigger);
});
it('distinguishes transferred bytes from verification and exposes full names and errors in details', () => {
 const row: FileUploadRowState = { id: 'one', owner: { type: 'PROJECT', id: 1 }, kind: 'VIDEO', name: '긴_파일.webm', size: 1024, phase: 'verifying' };
 render(<><MaterialUploadSummary rows={[row]} /><MaterialFileRow name={row.name} kind="VIDEO" status="변환 실패" size={row.size} failed error="변환에 실패했습니다. 원본을 확인하세요." /></>);
 expect(screen.getByText('검증 0/1개 완료')).toBeTruthy();
 expect(screen.getByText(/전송 완료/)).toBeTruthy();
 const details = screen.getByText('실패 이유 · 파일 정보').closest('details')!;
 expect(within(details).getByText(row.name)).toBeTruthy();
 expect(within(details).getByText(/원본을 확인/)).toBeTruthy();
});
