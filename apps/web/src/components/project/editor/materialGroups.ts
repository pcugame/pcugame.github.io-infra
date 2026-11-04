export const materialGroups = [
 { id: 'poster', label: '포스터', kinds: ['POSTER'] },
 { id: 'native', label: '네이티브', kinds: ['GAME'] },
 { id: 'web', label: '웹 빌드', kinds: ['WEBGL'] },
 { id: 'video', label: '동영상', kinds: ['VIDEO'] },
 { id: 'materials', label: '기타 자료', kinds: ['IMAGE', 'DOCUMENT', 'ATTACHMENT'] },
] as const;
export type MaterialGroup = typeof materialGroups[number];
export type MaterialGroupId = MaterialGroup['id'];
