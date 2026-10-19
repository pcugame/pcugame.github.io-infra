/* @vitest-environment jsdom */
import './helpers/dialog';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectUploadDialog } from '../components/common/ProjectUploadDialog';
import { FileUploadRow } from '../components/common/FileUploadRows';
import { FileUploadQueue } from '../lib/upload/fileUploadQueue';
import { UploadFileRows } from '../components/common/UploadFileRows';
import { UploadProvider } from '../lib/upload/UploadProvider';
import { startUpload, clearUpload } from '../lib/upload/store';

afterEach(cleanup);
const unload = () => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; };
it('shows file bars and a byte-weighted aggregate, retains children, and warns while busy', () => {
 const props = { title: '파일 업로드', description: '파일 검증', completed: 1, total: 4 };
 const view = (open: boolean, busy: boolean) => <ProjectUploadDialog {...props} open={open} busy={busy}>
  {['cover.png', 'game.zip', 'video.mp4', 'notes.pdf'].map((name, index) => <FileUploadRow key={name} queue={new FileUploadQueue('3', 'admin')} row={{ id: name, name, owner: { type: 'PROJECT', id: 7 }, kind: 'IMAGE', size: index === 0 ? 100 : 300, phase: index === 0 ? 'ready' : index === 1 ? 'uploading' : 'waiting', progress: index === 1 ? { uploadedBytes: 180, totalBytes: 300, percent: 60, uploadedChunks: 0, totalChunks: 1 } : undefined }} />)}
 </ProjectUploadDialog>;
 const { rerender } = render(view(true, true));
 expect(screen.getAllByRole('progressbar')).toHaveLength(5);
 expect((screen.getByRole('progressbar', { name: '전체 파일 업로드 진행률' }) as HTMLProgressElement).value).toBe(28);
 expect(screen.getByLabelText('파일 검증 완료').textContent).toBe('28% · 검증 완료 1 / 4');
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

it('withholds the aggregate percent while a recovered file size is unknown', () => {
 const queue = new FileUploadQueue('3', 'admin');
 render(<ProjectUploadDialog open busy title="파일 업로드" description="" completed={0} total={1}>
  <FileUploadRow queue={queue} row={{ id: 'unknown', name: 'unknown.zip', owner: { type: 'PROJECT', id: 7 }, kind: 'GAME', phase: 'waiting' }} />
 </ProjectUploadDialog>);
 expect(screen.getByRole('progressbar', { name: '전체 파일 업로드 진행률' }).hasAttribute('value')).toBe(false);
 expect(screen.getByLabelText('파일 검증 완료').textContent).toContain('크기 확인 중');
});
