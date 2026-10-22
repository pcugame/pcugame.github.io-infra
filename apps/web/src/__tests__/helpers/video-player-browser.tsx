import { createRoot } from 'react-dom/client';
import '../../styles/index.css';
import { ProjectVideo } from '../../components/project/ProjectVideo';

createRoot(document.getElementById('root')!).render(<div style={{ maxWidth: 960, margin: '0 auto' }}><div className="modal-visual__frame"><ProjectVideo title="Frame rate browser check" video={{
	assetId: 1, sortOrder: 0, role: 'MAIN', mimeType: 'video/mp4', playbackStatus: 'READY',
	url: '/video-test/native.mp4', originalDownloadUrl: '/video-test/original.mp4',
	playbacks: (['max', '720p'] as const).flatMap(quality => [120, 60, 30].map((frameRate, index) => ({
        profile: (['native', 'cap60', 'cap30'] as const)[index]!, quality,
        url: `/video-test/${(['native', 'cap60', 'cap30'] as const)[index]}${quality === 'max' ? '' : '-720p'}.mp4`,
        mimeType: 'video/mp4', frameRate, width: quality === 'max' ? 1920 : 1280, height: quality === 'max' ? 1080 : 720, status: 'READY' as const,
    }))),
}} /></div></div>);
