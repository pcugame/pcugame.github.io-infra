import { SelectControl } from '../../../components/ui/SelectControl';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AwardState } from '@pcu/contracts';
import { awardApi } from '../../../lib/api/awards';
import { getApiErrorMessage } from '../../../lib/api';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import { AwardImage } from '../../../components/awards/AwardImage';

export function AwardSettings({ exhibitionId, projectId }: { exhibitionId: number; projectId?: number }) {
 const qc = useQueryClient();
 const query = useQuery({ queryKey: ['awards', exhibitionId], queryFn: () => awardApi.read(exhibitionId) });
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const [name, setName] = useState('');
 async function save(action: () => Promise<AwardState>) {
  setBusy(true); setError('');
  try { const result = await action(); qc.setQueryData(['awards', exhibitionId], result); setName(''); await qc.invalidateQueries({ predicate: q => { const [root, id] = q.queryKey; if (root === 'adminProject' || root === 'projectDetailById') return result.projects.some(p => p.id === id); if (root === 'exhibitionProjects') return id === exhibitionId; return ['adminProjects', 'yearProjects', 'projectDetail'].includes(String(root)); } }); }
  catch (e) { setError(getApiErrorMessage(e)); await query.refetch(); }
  finally { setBusy(false); }
 }
 if (!query.data) return <p role={query.error ? 'alert' : undefined}>{query.error ? getApiErrorMessage(query.error) : '수상 설정 조회 중…'}</p>;
 const state = query.data;
 return <section aria-label="상 및 수상작" className="award-settings">
  <h3>{projectId ? '받은 상' : '상 및 수상작'}</h3>
  <p>저장하면 현재 작품 공개 범위 안에서 즉시 반영됩니다. 작품을 다른 전시회로 이동하면 수상 연결이 해제됩니다.</p>
  {error && <p role="alert">{error} <button type="button" onClick={() => { void query.refetch(); }}>다시 조회</button></p>}
  <fieldset disabled={busy}>
   {projectId ? <ProjectAwards key={`${projectId}:${state.version}`} state={state} projectId={projectId} save={save} /> : <>
    <label>새 상 이름 <input value={name} onChange={e => setName(e.target.value)} maxLength={100} /></label>
    <button type="button" disabled={!name.trim()} onClick={() => void save(() => awardApi.create(exhibitionId, state.version, name))}>상 추가</button>
    {state.items.map((award, index) => <AwardEditor key={`${award.id}:${state.version}`} exhibitionId={exhibitionId} state={state} award={award} index={index} save={save} />)}
    <h4>표시 이미지 업로드</h4><p>PNG·WebP·JPEG. 업로드 완료 후 상에서 이미지를 선택하고 저장해 주세요.</p>
    <DirectImageUploadWidget owner={{ type: 'EXHIBITION', id: exhibitionId }} kind="IMAGE" onComplete={() => { void query.refetch(); }} />
    {state.assets.map(asset => <div key={asset.id}>{asset.name} <button type="button" onClick={() => { if (window.confirm('이 이미지를 삭제하시겠습니까?')) void save(() => awardApi.deleteImage(exhibitionId, state.version, asset.id)); }}>이미지 삭제</button></div>)}
   </>}
  </fieldset>
 </section>;
}
type Save = (action: () => Promise<AwardState>) => Promise<void>;
function ProjectAwards({ state, projectId, save }: { state: AwardState; projectId: number; save: Save }) {
 const [ids, setIds] = useState(state.items.filter(a => a.projectIds.includes(projectId)).map(a => a.id));
 if (!state.items.length) return <p>전시회 설정에서 상을 먼저 등록해 주세요.</p>;
 return <>{state.items.map(a => <label key={a.id}><input type="checkbox" checked={ids.includes(a.id)} onChange={e => setIds(e.target.checked ? [...ids, a.id] : ids.filter(id => id !== a.id))} />{a.name}</label>)}<button type="button" onClick={() => void save(() => awardApi.project(projectId, state.version, ids))}>수상 선택 저장</button></>;
}
function AwardEditor({ exhibitionId, state, award, index, save }: { exhibitionId: number; state: AwardState; award: AwardState['items'][number]; index: number; save: Save }) {
 const [name, setName] = useState(award.name);
 const [asset, setAsset] = useState(award.builtinKey ?? String(award.assetId));
 const [selected, setSelected] = useState(award.projectIds);
 const [search, setSearch] = useState('');
 const [page, setPage] = useState(0);
 const added = selected.filter(id => !award.projectIds.includes(id));
 const removed = award.projectIds.filter(id => !selected.includes(id));
 const candidates = state.projects.filter(p => p.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
 const move = (delta: number) => { const ids = state.items.map(a => a.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; void save(() => awardApi.order(exhibitionId, state.version, ids)); };
 const builtinKey = ['medal', 'trophy', 'ribbon'].includes(asset) ? asset as 'medal' | 'trophy' | 'ribbon' : null;
 return <details><summary>{award.name} · 수상작 {award.projectIds.length}개</summary>
  <AwardImage award={{ ...award, name, builtinKey, assetId: builtinKey ? null : Number(asset), imageUrl: builtinKey ? undefined : state.assets.find(a => a.id === Number(asset))?.imageUrl }} />
  <label>상 이름 <input value={name} onChange={e => setName(e.target.value)} /></label>
  <label>표시 에셋 <SelectControl value={asset} onChange={e => setAsset(e.target.value)}><option value="medal">메달</option><option value="trophy">트로피</option><option value="ribbon">리본</option>{state.assets.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</SelectControl></label>
  <button type="button" onClick={() => void save(() => awardApi.edit(exhibitionId, state.version, { id: award.id, name, builtinKey, assetId: builtinKey ? null : Number(asset) }))}>상 설정 저장</button>
  <button type="button" disabled={index === 0} onClick={() => move(-1)}>위로</button><button type="button" disabled={index === state.items.length - 1} onClick={() => move(1)}>아래로</button>
  <button type="button" onClick={() => { if (window.confirm(`${award.name}을 삭제하면 ${award.projectIds.length}개 작품의 수상 연결이 해제됩니다. 삭제하시겠습니까?`)) void save(() => awardApi.remove(exhibitionId, state.version, award.id)); }}>상 삭제</button>
  <label>작품 검색 <input value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} /></label>
  {candidates.slice(page * 20, (page + 1) * 20).map(p => <label key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={e => setSelected(e.target.checked ? [...selected, p.id] : selected.filter(id => id !== p.id))} />{p.title} (#{p.id})</label>)}
  <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>이전</button><span>{page + 1} / {Math.max(1, Math.ceil(candidates.length / 20))}</span><button type="button" disabled={(page + 1) * 20 >= candidates.length} onClick={() => setPage(page + 1)}>다음</button>
  <p>추가 {added.length}개: {state.projects.filter(p => added.includes(p.id)).map(p => p.title).join(', ') || '없음'}<br />해제 {removed.length}개: {state.projects.filter(p => removed.includes(p.id)).map(p => p.title).join(', ') || '없음'}</p>
  <button type="button" disabled={!added.length && !removed.length} onClick={() => void save(() => awardApi.recipients(exhibitionId, state.version, award.id, added, removed))}>수상작 변경 저장</button>
 </details>;
}
