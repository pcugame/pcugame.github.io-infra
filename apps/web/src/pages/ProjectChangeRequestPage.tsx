import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectChangeManifestItem } from '@pcu/contracts';

import DirectImageUploadWidget from '../components/DirectImageUploadWidget';
import DirectVideoUploadWidget from '../components/DirectVideoUploadWidget';
import GameUploadWidget from '../components/GameUploadWidget';
import { ErrorMessage, LoadingSpinner } from '../components/common';
import { useMe } from '../features/auth';
import { adminProjectApi, changeRequestApi, getApiErrorMessage, type ChangeRequestChanges, type ChangeRequestKind } from '../lib/api';
import { queryKeys } from '../lib/query';

const stateLabel: Record<string, string> = {
  DRAFT: '작성 중', PENDING: '검토 대기', APPLYING: '반영 중', COMPLETED: '완료',
  REJECTED: '반려', CANCELLED: '취소', CONFLICT: '충돌', FAILED: '반영 실패',
};
type ChangeRequestMember = { name: string; studentId: string };
type UploadFiles = Record<ProjectChangeManifestItem['kind'], File[]>;
const emptyUploadFiles = (): UploadFiles => ({ POSTER: [], IMAGE: [], VIDEO: [], DOCUMENT: [], ATTACHMENT: [], GAME: [], WEBGL: [] });

function makeUploadManifest(files: UploadFiles): { manifest: ProjectChangeManifestItem[]; files: Array<{ kind: ProjectChangeManifestItem['kind']; file: File }> } {
  const slotFor = (kind: ProjectChangeManifestItem['kind'], index: number) => {
    if (kind === 'GAME') return 'game';
    if (kind === 'WEBGL') return 'webgl';
    if (kind === 'POSTER') return 'poster';
    return `${kind.toLowerCase()}:${index}`;
  };
  const uploads = (Object.entries(files) as Array<[ProjectChangeManifestItem['kind'], File[]]>).flatMap(([kind, selected]) => selected.map((file, index) => ({ kind, file, slot: slotFor(kind, index), clientToken: crypto.randomUUID().replaceAll('-', '') })));
  return { files: uploads.map(({ kind, file }) => ({ kind, file })), manifest: uploads.map(({ kind, slot, clientToken }) => ({ kind, slot, clientToken })) };
}

export default function ProjectChangeRequestPage() {
  const { id: rawId } = useParams<{ id: string }>();
  const projectId = Number(rawId);
  const { user } = useMe();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: queryKeys.adminProject(projectId), queryFn: () => adminProjectApi.getDetail(projectId), enabled: Number.isFinite(projectId) });
  const requestsQuery = useQuery({ queryKey: queryKeys.projectChangeRequests(projectId), queryFn: () => changeRequestApi.listForProject(projectId), enabled: Number.isFinite(projectId) });
  const activeSummary = requestsQuery.data?.items.find((request) => request.state === 'DRAFT' || request.state === 'PENDING' || request.state === 'APPLYING' || request.state === 'FAILED');
  const activeDetailQuery = useQuery({ queryKey: queryKeys.changeRequest(activeSummary?.id ?? ''), queryFn: () => changeRequestApi.get(activeSummary!.id), enabled: Boolean(activeSummary), refetchInterval: (query) => { const request = query.state.data; return request?.state === 'APPLYING' || (request?.state === 'DRAFT' && request.items.some((item) => item.state !== 'READY')) ? 1500 : false; } });
  const active = activeDetailQuery.data;
  const [kind, setKind] = useState<ChangeRequestKind>('EDIT');
  const [reason, setReason] = useState('');
  const [changes, setChanges] = useState<ChangeRequestChanges>({});
  const [members, setMembers] = useState<ChangeRequestMember[]>([]);
  const [membersTouched, setMembersTouched] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<UploadFiles>(emptyUploadFiles);
  const [uploadManifest, setUploadManifest] = useState<ProjectChangeManifestItem[] | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectChangeRequests(projectId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.changeRequests });
  };
  const create = useMutation({ mutationFn: () => changeRequestApi.create(projectId, { kind, reason }), onSuccess: invalidate });
  const project = projectQuery.data;
  const initialChanges: ChangeRequestChanges = { ...(project ? { title: project.title, summary: project.summary ?? '', description: project.description ?? '', githubUrl: project.githubUrl ?? '', platforms: [...project.platforms], posterAssetId: project.posterAssetId ?? null } : {}), ...(active?.changes ?? {}) };
  const formChanges = { ...initialChanges, ...changes };
  const formMembers = membersTouched ? members : (initialChanges.members ?? project?.members.map(({ name, studentId }) => ({ name, studentId })) ?? []);
  const formReason = reason || active?.reason || '';
  const videoAssetIds = formChanges.videoAssetIds ?? project?.videos.map((video) => video.assetId) ?? [];
  const stagedPoster = active?.stagedAssets.find((asset) => asset.kind === 'POSTER');
  const selectedPosterId = formChanges.posterAssetId ?? null;
  const effectivePosterId = stagedPoster && selectedPosterId === (project?.posterAssetId ?? null)
    ? stagedPoster.id : (formChanges.removeAssetIds ?? []).includes(selectedPosterId ?? -1) ? null : selectedPosterId;
  const effectiveVideoAssetIds = [...new Set(videoAssetIds
    .filter((assetId) => !(formChanges.removeAssetIds ?? []).includes(assetId))
    .concat((active?.stagedAssets ?? []).filter((asset) => asset.kind === 'VIDEO').map((asset) => asset.id)))];
  const save = useMutation({ mutationFn: () => active ? changeRequestApi.update(active.id, { reason: formReason, changes: { ...formChanges, members: formMembers, posterAssetId: effectivePosterId, videoAssetIds: effectiveVideoAssetIds } }) : Promise.reject(new Error('작성 중인 요청이 없습니다.')), onSuccess: invalidate });
  const prepareUploads = useMutation({
    mutationFn: (manifest: ProjectChangeManifestItem[]) => {
      if (!active) return Promise.reject(new Error('작성 중인 요청이 없습니다.'));
      return changeRequestApi.update(active.id, { manifest });
    },
    onSuccess: (_detail, manifest) => { setUploadManifest(manifest); invalidate(); },
  });
  const submit = useMutation({ mutationFn: async () => { if (!active) throw new Error('작성 중인 요청이 없습니다.'); if (active.kind === 'EDIT') await changeRequestApi.update(active.id, { reason: formReason, changes: { ...formChanges, members: formMembers, posterAssetId: effectivePosterId, videoAssetIds: effectiveVideoAssetIds } }); else await changeRequestApi.update(active.id, { reason: formReason }); return changeRequestApi.submit(active.id); }, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => active ? changeRequestApi.cancel(active.id) : Promise.reject(new Error('작성 중인 요청이 없습니다.')), onSuccess: invalidate });

  if (projectQuery.isLoading || requestsQuery.isLoading || (activeSummary && activeDetailQuery.isLoading)) return <LoadingSpinner />;
  if (projectQuery.error) return <ErrorMessage error={projectQuery.error} onReset={() => projectQuery.refetch()} />;
  if (requestsQuery.error) return <ErrorMessage error={requestsQuery.error} onReset={() => requestsQuery.refetch()} />;
  if (activeDetailQuery.error) return <ErrorMessage error={activeDetailQuery.error} onReset={() => activeDetailQuery.refetch()} />;
  if (!project) return null;
  const editable = active?.state === 'DRAFT' && active.actorId === user?.id;
  const busy = create.isPending || save.isPending || prepareUploads.isPending || submit.isPending || cancel.isPending;
  const mutationError = create.error ?? save.error ?? prepareUploads.error ?? submit.error ?? cancel.error;
  const uploadItemsByToken = new Map((active?.items ?? []).map((item) => [item.clientToken, item]));
  const uploadsReady = active ? active.items.every((item) => item.state === 'READY' && (item.kind !== 'VIDEO' || item.playbackState === 'READY')) : true;

  const toggleAssetRemoval = (assetId: number) => {
    const removeAssetIds = new Set(formChanges.removeAssetIds ?? []);
    if (removeAssetIds.has(assetId)) removeAssetIds.delete(assetId);
    else removeAssetIds.add(assetId);
    setChanges({ ...changes, removeAssetIds: [...removeAssetIds] });
  };
  const moveVideo = (assetId: number, direction: -1 | 1) => {
    const index = videoAssetIds.indexOf(assetId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= videoAssetIds.length) return;
    const next = [...videoAssetIds];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setChanges({ ...changes, videoAssetIds: next });
  };

  return <div className="admin-project-edit-page">
    <div className="admin-page-header"><div className="admin-page-header__text"><h1>작품 변경 요청</h1><p>{project.title} · {project.year}년</p></div></div>
    {!active ? <section className="project-form"><fieldset><legend>요청 종류</legend>
      <label><input type="radio" checked={kind === 'EDIT'} onChange={() => setKind('EDIT')} /> 수정 요청</label>{' '}
      <label><input type="radio" checked={kind === 'DELETE'} onChange={() => setKind('DELETE')} /> 삭제 요청</label>
      <div className="form-field"><label htmlFor="change-reason">요청 사유 *</label><textarea id="change-reason" rows={4} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      <button type="button" className="btn btn--primary" disabled={!reason.trim() || busy} onClick={() => create.mutate()}>{create.isPending ? '생성 중…' : '요청 작성 시작'}</button>
    </fieldset></section> : <>
      <p className="edit-meta">상태: <strong>{stateLabel[active.state] ?? active.state}</strong>{active.reviewReason ? ` · 운영자 의견: ${active.reviewReason}` : ''}</p>
	      {active.kind === 'DELETE' ? <section className="project-form"><fieldset disabled={!editable}><legend>삭제 요청</legend><p>승인되면 작품과 연결된 파일이 삭제되며 복구할 수 없습니다.</p><div className="form-field"><label htmlFor="delete-reason">요청 사유 *</label><textarea id="delete-reason" rows={4} value={formReason} onChange={(e) => setReason(e.target.value)} /></div></fieldset></section> : <>
        <section className="project-form"><fieldset disabled={!editable}><legend>기본 정보</legend>
	          <div className="form-field"><label htmlFor="change-title">제목 *</label><input id="change-title" value={formChanges.title ?? ''} onChange={(e) => setChanges({ ...changes, title: e.target.value })} /></div>
	          <div className="form-field"><label htmlFor="change-summary">한줄 소개</label><input id="change-summary" value={formChanges.summary ?? ''} onChange={(e) => setChanges({ ...changes, summary: e.target.value })} /></div>
	          <div className="form-field"><label htmlFor="change-description">상세 설명</label><textarea id="change-description" rows={6} value={formChanges.description ?? ''} onChange={(e) => setChanges({ ...changes, description: e.target.value })} /></div>
	          <div className="form-field"><label htmlFor="change-github">GitHub 주소</label><input id="change-github" value={formChanges.githubUrl ?? ''} onChange={(e) => setChanges({ ...changes, githubUrl: e.target.value })} /></div>
	          <div className="form-field"><label>플랫폼</label>{(['PC', 'MOBILE', 'WEB'] as const).map((platform) => <label key={platform} className="form-field--checkbox"><input type="checkbox" checked={(formChanges.platforms ?? []).includes(platform)} onChange={() => { const platforms = new Set(formChanges.platforms ?? []); if (platforms.has(platform)) platforms.delete(platform); else platforms.add(platform); setChanges({ ...changes, platforms: [...platforms] }); }} /> {platform}</label>)}</div>
        </fieldset></section>
	        <section className="project-form"><fieldset disabled={!editable}><legend>참여 학생</legend>{formMembers.map((member, index) => <div className="member-add-row" key={`${index}-${member.studentId}`}><input aria-label={`참여 학생 ${index + 1} 이름`} value={member.name} onChange={(e) => { setMembersTouched(true); setMembers(formMembers.map((value, memberIndex) => memberIndex === index ? { ...value, name: e.target.value } : value)); }} /><input aria-label={`참여 학생 ${index + 1} 학번`} value={member.studentId} onChange={(e) => { setMembersTouched(true); setMembers(formMembers.map((value, memberIndex) => memberIndex === index ? { ...value, studentId: e.target.value } : value)); }} /><button type="button" className="btn btn--danger btn--small" onClick={() => { setMembersTouched(true); setMembers(formMembers.filter((_, memberIndex) => memberIndex !== index)); }}>삭제</button></div>)}<button type="button" className="btn btn--secondary btn--small" onClick={() => { setMembersTouched(true); setMembers([...formMembers, { name: '', studentId: '' }]); }}>참여 학생 추가</button></fieldset></section>
	        <section className="project-form"><fieldset disabled={!editable}><legend>기존 파일과 배포</legend><p className="field-hint">새 파일은 아래 임시 업로드 영역에 올린 뒤 저장합니다. 승인 전에는 공개 작품에 반영되지 않습니다.</p>{project.assets.map((asset) => <label key={asset.id} className="form-field--checkbox"><input type="checkbox" checked={(formChanges.removeAssetIds ?? []).includes(asset.id)} onChange={() => toggleAssetRemoval(asset.id)} /> {asset.originalName} ({asset.kind})</label>)}<div className="form-field"><label htmlFor="change-poster">포스터</label><select id="change-poster" value={effectivePosterId ?? ''} onChange={(event) => setChanges({ ...changes, posterAssetId: event.target.value ? Number(event.target.value) : null })}><option value="">포스터 없음</option>{[...project.assets, ...(active.stagedAssets ?? [])].filter((asset) => (asset.kind === 'IMAGE' || asset.kind === 'POSTER') && !(formChanges.removeAssetIds ?? []).includes(asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.originalName}</option>)}</select></div>{videoAssetIds.length > 0 && <div className="form-field"><label>영상 순서</label>{videoAssetIds.map((assetId, index) => <div key={assetId} className="member-add-row"><span>{index === 0 ? '메인' : `추가 ${index}`} · {project.assets.find((asset) => asset.id === assetId)?.originalName ?? assetId}</span><button type="button" className="btn btn--secondary btn--small" disabled={index === 0} onClick={() => moveVideo(assetId, -1)}>위로</button><button type="button" className="btn btn--secondary btn--small" disabled={index === videoAssetIds.length - 1} onClick={() => moveVideo(assetId, 1)}>아래로</button></div>)}</div>}{project.webglUrl && <label className="form-field--checkbox"><input type="checkbox" checked={formChanges.removeWebgl === true} onChange={(event) => setChanges({ ...changes, removeWebgl: event.target.checked })} /> 현재 WebGL 빌드 삭제</label>}</fieldset></section>
	        {editable && <section className="project-form"><fieldset><legend>새 파일 임시 업로드</legend>
	          {uploadManifest ? <>
	            {!active.stagingProjectId ? <p className="field-hint">임시 업로드 공간을 준비하고 있습니다.</p> : <>
	              {(['POSTER', 'IMAGE'] as const).map((assetKind) => {
	                const planned = uploadManifest.filter((item) => item.kind === assetKind);
	                return planned.length ? <DirectImageUploadWidget key={assetKind} owner={{ type: 'PROJECT', id: active.stagingProjectId! }} kind={assetKind} initialFiles={uploadFiles[assetKind]} autoStart submissionItems={planned.map((item) => ({ id: uploadItemsByToken.get(item.clientToken)?.id ?? '', clientToken: item.clientToken }))} /> : null;
	              })}
	              {(['VIDEO', 'DOCUMENT', 'ATTACHMENT'] as const).map((assetKind) => {
	                const planned = uploadManifest.filter((item) => item.kind === assetKind);
	                const label = assetKind === 'VIDEO' ? '동영상' : assetKind === 'DOCUMENT' ? '문서' : '첨부자료';
	                return planned.length ? <DirectVideoUploadWidget key={assetKind} projectId={active.stagingProjectId!} kind={assetKind} label={label} initialFiles={uploadFiles[assetKind]} autoStart submissionItems={planned.map((item) => ({ id: uploadItemsByToken.get(item.clientToken)?.id ?? '', clientToken: item.clientToken }))} /> : null;
	              })}
	              {(['GAME', 'WEBGL'] as const).map((assetKind) => {
	                const item = uploadManifest.find((manifest) => manifest.kind === assetKind);
	                return item ? <GameUploadWidget key={assetKind} projectId={active.stagingProjectId!} uploadKind={assetKind} initialFile={uploadFiles[assetKind][0]} autoStart submissionItem={{ id: uploadItemsByToken.get(item.clientToken)?.id ?? '', clientToken: item.clientToken }} /> : null;
	              })}
	            </>}
	            {active.stagedAssets.length > 0 && <p className="field-hint">임시 업로드됨: {active.stagedAssets.map((asset) => asset.originalName).join(', ')}</p>}
	            {!uploadsReady && <p className="field-hint">모든 파일 검증이 완료될 때까지 제출할 수 없습니다.</p>}
	          </> : <>
	            <p className="field-hint">파일을 모두 선택한 뒤 업로드 준비를 누르세요. 준비 후에는 파일 구성을 바꿀 수 없습니다.</p>
	            {(['POSTER', 'IMAGE', 'VIDEO', 'DOCUMENT', 'ATTACHMENT', 'GAME', 'WEBGL'] as const).map((assetKind) => <div className="form-field" key={assetKind}><label htmlFor={`change-upload-${assetKind}`}>{assetKind === 'POSTER' ? '포스터' : assetKind === 'IMAGE' ? '이미지' : assetKind === 'VIDEO' ? '동영상' : assetKind === 'DOCUMENT' ? '문서' : assetKind === 'ATTACHMENT' ? '첨부자료' : assetKind === 'GAME' ? '게임 파일' : 'WebGL 빌드'}</label><input id={`change-upload-${assetKind}`} type="file" multiple={!['POSTER', 'GAME', 'WEBGL'].includes(assetKind)} onChange={(event) => setUploadFiles({ ...uploadFiles, [assetKind]: Array.from(event.target.files ?? []) })} /></div>)}
	            <button type="button" className="btn btn--secondary" disabled={busy || Object.values(uploadFiles).every((files) => files.length === 0)} onClick={() => prepareUploads.mutate(makeUploadManifest(uploadFiles).manifest)}>{prepareUploads.isPending ? '준비 중…' : '업로드 준비'}</button>
	          </>}
	        </fieldset></section>}
      </>}
	      {editable && <section className="project-form"><fieldset><legend>제출</legend><div className="form-field"><label htmlFor="draft-reason">요청 사유 *</label><textarea id="draft-reason" rows={3} value={formReason} onChange={(e) => setReason(e.target.value)} /></div><button type="button" className="btn btn--secondary" disabled={busy} onClick={() => save.mutate()}>{save.isPending ? '저장 중…' : '초안 저장'}</button>{' '}<button type="button" className="btn btn--primary" disabled={busy || !formReason.trim() || !uploadsReady} onClick={() => submit.mutate()}>운영자에게 제출</button>{' '}<button type="button" className="btn btn--danger" disabled={busy} onClick={() => cancel.mutate()}>요청 취소</button></fieldset></section>}
    </>}
    {mutationError && <p className="error-box" role="alert">{getApiErrorMessage(mutationError)}</p>}
    <Link className="btn btn--secondary" to="/me/projects">내 작품으로 돌아가기</Link>
  </div>;
}
