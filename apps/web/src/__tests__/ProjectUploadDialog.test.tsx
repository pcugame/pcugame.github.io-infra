/* @vitest-environment jsdom */
import './helpers/dialog';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectUploadDialog } from '../components/common/ProjectUploadDialog';
import { UploadFileRows } from '../components/common/UploadFileRows';
import { UploadProvider } from '../lib/upload/UploadProvider';
import { startUpload, clearUpload } from '../lib/upload/store';

afterEach(cleanup);
const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
it('shows one aggregate bar, retains children, and warns only while the open operation is busy', () => {
 const props = { title: '파일 업로드', description: '파일 검증', completed: 1, total: 4 };
 const view = (open: boolean, busy: boolean) => <ProjectUploadDialog {...props} open={open} busy={busy}>
  <UploadFileRows names={['cover.png']} phase="ready" />
  <UploadFileRows names={['game.zip', 'video.mp4', 'notes.pdf']} percent={60} phase="uploading" />
 </ProjectUploadDialog>;
 const { rerender } = render(view(true, true));
 expect(screen.getAllByRole('progressbar')).toHaveLength(1);
 expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(40);
 expect(screen.getByLabelText('파일 검증 완료').textContent).toBe('40% · 1 / 4');
 expect(unload()).toBe(true);
 const event = new Event('cancel', { cancelable: true });
 fireEvent(screen.getByRole('dialog'), event);
 expect(event.defaultPrevented).toBe(true);
 const row = screen.getByText('game.zip');
 rerender(view(true, false)); expect(unload()).toBe(false);
 rerender(view(false, false)); expect(row.isConnected).toBe(true);
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(document.body.style.overflow).toBe('');
});
it('keeps retry and cancellation actions on the failed file row only', () => {
 const retry = vi.fn();
 render(<ProjectUploadDialog open busy title="파일 업로드" description="" completed={1} total={3}>
  <UploadFileRows names={['done.png', 'failed.png', 'pending.png']} completed={1} phase="error"
   actions={<><button onClick={retry}>재시도</button><button>취소</button></>} />
 </ProjectUploadDialog>);
 const button = screen.getByRole('button', { name: '재시도' });
 expect(button.closest('.upload-file-row')?.textContent).toContain('failed.png');
 expect(button.closest('.upload-file-row')?.textContent).not.toContain('done.png');
 fireEvent.click(button); expect(retry).toHaveBeenCalledOnce();
});
it('suppresses the individual overlay while the project dialog owns presentation', () => {
 let task = '';
 const { rerender } = render(<UploadProvider><ProjectUploadDialog open busy title="전체 업로드" description="" total={1} completed={0}>목록</ProjectUploadDialog></UploadProvider>);
 act(() => { task = startUpload({ title: '개별 파일' }); });
 expect(screen.getAllByRole('dialog')).toHaveLength(1);
 expect(screen.getByRole('dialog').getAttribute('aria-labelledby')).toBeTruthy();
 rerender(<UploadProvider><div /></UploadProvider>);
 expect(screen.getByRole('dialog', { name: '개별 파일' })).toBeTruthy();
 act(() => clearUpload(task));
});
