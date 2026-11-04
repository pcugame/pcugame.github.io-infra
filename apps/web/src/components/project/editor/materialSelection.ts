import { classifyProjectFile, type ProjectUploadKind } from '../../../lib/upload/project-files';
import type { MaterialGroup } from './materialGroups';

export function classifyMaterialSelection(group: MaterialGroup, files: File[]): { kind: ProjectUploadKind; file: File }[] {
 const single = ['poster', 'native', 'web'].includes(group.id);
 if (single && files.length !== 1) throw new Error('파일 한 개만 선택하세요.');
 return files.map(file => {
  const kind = classifyProjectFile(file, group.id === 'poster' ? 'poster' : 'files');
  if (group.id === 'poster') {
   if (kind !== 'POSTER') throw new Error('포스터는 JPG·PNG·WebP·PDF 파일만 선택하세요.');
   return { kind: 'POSTER', file };
  }
  if (single) {
   if (kind !== 'ZIP') throw new Error('빌드는 ZIP 파일만 선택하세요.');
   return { kind: group.id === 'native' ? 'GAME' : 'WEBGL', file };
  }
  if (group.id === 'video') {
   if (kind !== 'VIDEO') throw new Error('지원하는 동영상 파일만 선택하세요.');
   return { kind, file };
  }
  if (kind === 'VIDEO' || file.type.startsWith('video/')) throw new Error('영상은 동영상 영역에서 선택하세요.');
  return { kind: kind === 'IMAGE' || kind === 'DOCUMENT' ? kind : 'ATTACHMENT', file };
 });
}
