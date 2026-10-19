import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { FileUploadQueue } from '../../lib/upload/fileUploadQueue';
import { FileUploadRows } from '../../components/common/FileUploadRows';
import { ProjectUploadDialog } from '../../components/common/ProjectUploadDialog';
import { putUploadPart } from '../../lib/api/upload-part-transport';
import '../../styles/index.css';
const events: { id: string; loaded: number; percent: number }[] = [];
export function Harness() {
 const queue = useMemo(() => new FileUploadQueue('browser', 'admin'), []);
 const rows = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
 useEffect(() => {
  const detach = queue.attach();
  queue.sync(['one', 'two', 'three'].map((id, index) => {
   const file = new File([new Uint8Array(index === 1 ? 4 * 1024 * 1024 : 512 * 1024)], index === 0 ? '첫 번째 아주 긴 파일명과 모바일 화면 줄바꿈을 확인하는 이미지.png' : 'same-name.png', { type: 'image/png' });
   return { id, owner: { type: 'PROJECT' as const, id: 7 }, kind: 'IMAGE' as const, file, name: file.name, size: file.size };
  }));
  const unsubscribe = queue.subscribe(() => { for (const row of queue.getSnapshot()) if (row.progress) events.push({ id: row.id, loaded: row.progress.uploadedBytes, percent: row.progress.percent }); });
  Object.assign(window, { uploadProbe: { queue, events, putUploadPart } });
  return () => { unsubscribe(); detach(); };
 }, [queue]);
 return <ProjectUploadDialog open busy title="파일 업로드" description="브라우저 전송 검증" total={3} completed={rows.filter(row => row.phase === 'ready').length}
  actions={<><button onClick={() => void queue.start()}>전송 시작</button><button onClick={() => void queue.cancelAll()}>전체 업로드 중단</button></>}>
  <FileUploadRows queue={queue} />
 </ProjectUploadDialog>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
