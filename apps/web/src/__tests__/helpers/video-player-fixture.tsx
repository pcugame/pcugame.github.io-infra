import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectVideo as VideoInfo, PublicProjectDetailResponse } from '@pcu/contracts';
import { ProjectModal } from '../../components/project/ProjectModal';
import { queryKeys } from '../../lib/query';
import { ProjectVideo } from '../../components/project/ProjectVideo';

const video: VideoInfo = {
	assetId: 1, sortOrder: 0, role: 'MAIN', mimeType: 'video/mp4', playbackStatus: 'READY',
	url: '/video-test/native.mp4', originalDownloadUrl: '/video-test/original.mp4',
	playbacks: (['max', '720p'] as const).flatMap(quality => [120, 60, 30].map((frameRate, index) => ({
        profile: (['native', 'cap60', 'cap30'] as const)[index]!, quality,
        url: `/video-test/${(['native', 'cap60', 'cap30'] as const)[index]}${quality === 'max' ? '' : '-720p'}.mp4`,
        mimeType: 'video/mp4', frameRate, width: quality === 'max' ? 1920 : 1280, height: quality === 'max' ? 1080 : 720, status: 'READY' as const,
    }))),
};

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
client.setQueryData(queryKeys.me, { authenticated: false });
const project: PublicProjectDetailResponse = {
    id: 1, slug: 'video-browser-check', year: 2026, title: '모바일 영상 재생 확인',
    visibility: 'PUBLIC', exhibitionVisibility: 'PUBLIC', canChangeVisibility: false,
    platforms: ['WEB'], isIncomplete: false, status: 'PUBLISHED', members: [], images: [],
    video, videos: [video], description: '영상 재생과 설정, 전체화면을 확인합니다.',
};
client.setQueryData([...queryKeys.projectDetail(project.year, project.slug), { viewer: 'anonymous' }], project);

export function Preview() {
    const [open, setOpen] = useState(true);
    if (new URLSearchParams(location.search).has('modal')) {
        return <QueryClientProvider client={client}><MemoryRouter>
            {open ? <ProjectModal slug={project.slug} year={project.year} onClose={() => setOpen(false)} /> : <p>작품 닫힘</p>}
        </MemoryRouter></QueryClientProvider>;
    }
    return <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div className="modal-visual__frame modal-visual__frame--video"><ProjectVideo title="Frame rate browser check" video={video} /></div>
    </div>;
}
