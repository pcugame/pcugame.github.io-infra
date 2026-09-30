/* @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adminMemberApi } from '../lib/api';
import { useProjectMemberDraft } from '../features/admin/projects/useProjectMemberDraft';
const initial = [
	{ id: 1, name: '첫째', studentId: '20260001', sortOrder: 0, userId: null },
	{ id: 2, name: '둘째', studentId: '20260002', sortOrder: 0, userId: null },
];
beforeEach(() => {
	vi.spyOn(adminMemberApi, 'add').mockResolvedValue({ id: 3 });
	vi.spyOn(adminMemberApi, 'remove').mockResolvedValue(undefined);
	vi.spyOn(adminMemberApi, 'update').mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('stages equal-order reordering, persists distinct ranks, and clears dirty', async () => {
	const { result } = renderHook(() => useProjectMemberDraft(7, initial));
	act(() => result.current.swap(0, 1)); expect(adminMemberApi.update).not.toHaveBeenCalled(); expect(result.current.hasChanges).toBe(true);
	await act(async () => result.current.applyChanges());
	expect(adminMemberApi.update).toHaveBeenCalledWith(7, 1, { sortOrder: 1 }); expect(result.current.hasChanges).toBe(false);
});
it('reversion and add-then-remove are clean without network mutations', () => {
	const { result } = renderHook(() => useProjectMemberDraft(7, initial));
	act(() => result.current.swap(0, 1)); act(() => result.current.swap(0, 1)); expect(result.current.hasChanges).toBe(false);
	act(() => result.current.add()); const id = result.current.members[2].id; act(() => result.current.remove(id)); expect(result.current.hasChanges).toBe(false);
});
it('checkpoints successful deletes and updates so partial retry does not repeat them', async () => {
	vi.mocked(adminMemberApi.add).mockRejectedValueOnce(new Error('추가 실패'));
	const { result } = renderHook(() => useProjectMemberDraft(7, initial));
	act(() => { result.current.remove(1); result.current.update(2, { name: '수정' }); result.current.add(); });
	const id = result.current.members[1].id;
	act(() => result.current.update(id, { name: '셋째', studentId: '20260003' }));
	await act(async () => { await expect(result.current.applyChanges()).rejects.toThrow('추가 실패'); });
	expect(result.current.hasChanges).toBe(true);
	await act(async () => result.current.applyChanges());
	expect(adminMemberApi.remove).toHaveBeenCalledOnce(); expect(adminMemberApi.update).toHaveBeenCalledOnce(); expect(adminMemberApi.add).toHaveBeenCalledTimes(2); expect(result.current.hasChanges).toBe(false);
});
it('validates all rows before deleting any persisted member', async () => {
	const { result } = renderHook(() => useProjectMemberDraft(7, initial));
	act(() => { result.current.remove(1); result.current.update(2, { name: '' }); });
	await act(async () => { await expect(result.current.applyChanges()).rejects.toThrow(); });
	expect(adminMemberApi.remove).not.toHaveBeenCalled();
});
