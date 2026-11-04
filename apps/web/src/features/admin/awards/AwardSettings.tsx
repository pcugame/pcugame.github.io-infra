import { AwardColorEditor } from './AwardColorEditor';
import { awardStyle, awardTone } from '../../../components/project/awardTone';
import { matchesSearch } from '../../../lib/utils/search';
import { useMe } from '../../auth';
import { IconPlus } from '@tabler/icons-react';
import { ProjectUploadDialog } from '../../../components/common/ProjectUploadDialog';
import { useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AwardState } from '@pcu/contracts';
import {
	Button,
	CheckboxField,
	TextField,
} from '../../../components/ui';
import { awardApi } from '../../../lib/api/awards';
import { getApiErrorMessage } from '../../../lib/api';
import DirectImageUploadWidget from '../../../components/DirectImageUploadWidget';
import { AwardIcon } from '../../../components/project/AwardIcon';
import { laurelIcons } from '../../../components/project/awardIcons';

type Save = (
	action: () => Promise<AwardState>,
) => Promise<AwardState | undefined>;
export function AwardSettings(props: { exhibitionId: number; projectId?: number }) {
	const { user } = useMe();
	if (user?.role !== 'OPERATOR' && user?.role !== 'ADMIN') return null;
	return <AuthorizedAwardSettings {...props} />;
}

function AuthorizedAwardSettings({
	exhibitionId,
	projectId,
}: {
	exhibitionId: number;
	projectId?: number;
}) {
	const qc = useQueryClient();
	const query = useQuery({
		queryKey: ['awards', exhibitionId],
		queryFn: () => awardApi.read(exhibitionId),
	});
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [busy, setBusy] = useState(false);
	const [name, setName] = useState('');
	const [adding, setAdding] = useState(false);
	const [expanded, setExpanded] = useState<number | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const save: Save = async (action) => {
		setBusy(true);
		setError('');
		setNotice('');
		try {
			const result = await action();
			qc.setQueryData(['awards', exhibitionId], result);
			setNotice('변경사항을 저장했습니다.');
			await qc.invalidateQueries();
			return result;
		} catch (e) {
			setError(getApiErrorMessage(e));
		} finally {
			setBusy(false);
		}
	};
	if (!query.data)
		return (
			<p className={query.error ? 'field-error' : 'field-hint'} role={query.error ? 'alert' : 'status'}>
				{query.error ? getApiErrorMessage(query.error) : '수상 설정 조회 중…'}
			</p>
		);
	const state = {
		...query.data,
		items: [...query.data.items].sort(
			(a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
		),
	};
	async function add() {
		if (!name.trim() || busy) return;
		const result = await save(() =>
			awardApi.create(exhibitionId, state.version, name),
		);
		if (result) {
			const created = result.items.find(
				(a) => !state.items.some((old) => old.id === a.id),
			);
			setName('');
			setAdding(false);
			if (created) setExpanded(created.id);
			setNotice(`${name.trim()}을 추가했습니다. 수상작을 선택해 주세요.`);
			addButton.current?.focus();
		}
	}
	return (
		<section aria-label="상 및 수상작" className={`award-settings${projectId ? ' award-settings--project' : ''}`}>
			<div className="award-settings__heading">
				<h3>{projectId ? '받은 상' : '상 및 수상작'}</h3>
				{!projectId && <span className="award-settings__count">{state.items.length}개</span>}
			</div>
			<p className="field-hint">
				{projectId
					? '이 작품이 받은 상을 선택하세요.'
					: '위에 있는 상이 더 높은 상입니다. ↑ ↓ 버튼으로 순위를 조정하세요.'}
			</p>
			{error && (
				<div className="field-error" role="alert">
					{error}{' '}
					<Button
						size="small"
						variant="secondary"
						onClick={() => {
							void query.refetch();
						}}
					>
						다시 조회
					</Button>
				</div>
			)}
			{notice && (
				<p className="award-settings__notice" role="status">
					{notice}
				</p>
			)}
			<fieldset
				className="award-settings__controls"
				disabled={busy}
				aria-label={projectId ? '수상 선택' : '상 구성'}
			>
				{projectId ? (
					<ProjectAwards
						key={`${projectId}:${state.version}`}
						state={state}
						projectId={projectId}
						save={save}
					/>
				) : (
					<>
						<ol className="award-settings__list" aria-label="상 순위">
							{state.items.map((award, index) => (
								<AwardCard
									error={error}
									busy={busy}
									key={award.id}
									exhibitionId={exhibitionId}
									state={state}
									award={award}
									index={index}
									save={save}
									expanded={expanded === award.id}
									onToggle={() =>
										setExpanded(expanded === award.id ? null : award.id)
									}
								/>
							))}
						</ol>
						{!state.items.length && (
							<div className="award-settings__empty">
								<strong>첫 번째 상을 만들어 보세요</strong>
								<p className="field-hint">
									대상, 최우수상, 특별상 등 전시회에 맞는 상을 추가할 수
									있습니다.
								</p>
							</div>
						)}
						{(adding || !state.items.length) && (
							<div className="award-settings__create">
								<TextField
									label="새 상 이름"
									placeholder="예: 대상, 최우수상, 관객상"
									value={name}
									onChange={(e) => setName(e.target.value)}
									maxLength={100}
									autoFocus={adding}
									onKeyDown={(e) => {
										if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
											e.preventDefault();
											void add();
										}
									}}
									hint="새 상은 맨 아래에 추가됩니다. 추가 후 순위를 바꿀 수 있습니다."
								/>
								<div className="award-settings__actions">
									<Button disabled={!name.trim()} onClick={() => void add()}>
										추가
									</Button>
									{!!state.items.length && (
										<Button
											variant="secondary"
											onClick={() => {
												setAdding(false);
												setName('');
												addButton.current?.focus();
											}}
										>
											취소
										</Button>
									)}
								</div>
							</div>
						)}
						{!!state.items.length && (
							<Button
								ref={addButton}
								variant="secondary"
								className="award-settings__add"
								disabled={adding}
								onClick={() => setAdding(true)}
							>
								＋ 상 추가
							</Button>
						)}
						<p className="field-hint">
							상 설정·수상작은 각각 저장하며, 이미지 선택·순위 변경은 즉시
							반영됩니다.
						</p>
					</>
				)}
			</fieldset>
		</section>
	);
}
function ProjectAwards({
	state,
	projectId,
	save,
}: {
	state: AwardState;
	projectId: number;
	save: Save;
}) {
	const [ids, setIds] = useState(
		state.items
			.filter((a) => a.projectIds.includes(projectId))
			.map((a) => a.id),
	);
	if (!state.items.length)
		return <p className="field-hint">전시회 설정에서 상을 먼저 등록해 주세요.</p>;
	return (
		<>
			<div className="project-award-tiles">
				{state.items.map((award) => (
					<label key={award.id} className="btn btn--secondary btn--small award-card__icon-tile project-award-tile" title={award.name}>
						<input type="checkbox" checked={ids.includes(award.id)} onChange={(event) =>
							setIds(event.target.checked ? [...ids, award.id] : ids.filter(id => id !== award.id))
						} />
						<AwardIcon award={award} />
						<span>{award.name}</span>
					</label>
				))}
			</div>
			<div className="project-award-picker__footer">
				<span>{ids.length ? `${ids.length}개 선택` : '선택한 상 없음'}</span>
			<Button
				onClick={() =>
					void save(() => awardApi.project(projectId, state.version, ids))
				}
			>
				수상 선택 저장
			</Button>
			</div>
		</>
	);
}
type CardProps = {
	error: string;
	busy: boolean;
	exhibitionId: number;
	state: AwardState;
	award: AwardState['items'][number];
	index: number;
	save: Save;
	expanded: boolean;
	onToggle: () => void;
};
function AwardCard({
	error,
	busy,
	exhibitionId,
	state,
	award,
	index,
	save,
	expanded,
	onToggle,
}: CardProps) {
	const panelId = useId();
	const [uploadOpen, setUploadOpen] = useState(false);
	const [iconMode, setIconMode] = useState<'laurel' | 'photo'>(award.builtinKey ? 'laurel' : 'photo');
	const [uploadFiles, setUploadFiles] = useState<File[]>([]);
	const [uploadActive, setUploadActive] = useState(false);
	const [uploadAttempt, setUploadAttempt] = useState(0);
	const imageInput = useRef<HTMLInputElement>(null);
	const qc = useQueryClient();
	const move = async (delta: number) => {
		const ids = state.items.map((a) => a.id);
		[ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
		await save(() => awardApi.order(exhibitionId, state.version, ids));
	};
	const names = state.projects
		.filter((p) => award.projectIds.includes(p.id))
		.map((p) => p.title);
	return (
		<li className={`award-card${expanded ? ' award-card--expanded' : ''}`}>
			<div className="award-card__header">
				<span className="award-card__rank" aria-label={`${index + 1}순위`}>
					{String(index + 1).padStart(2, '0')}
				</span>
				<div className="award-card__identity">
					<div className="award-badge" data-award-tone={awardTone(award)} style={awardStyle(award)}>
						<AwardIcon award={award} />
						{expanded ? (
							<AwardNameEditor exhibitionId={exhibitionId} state={state} award={award} save={save} busy={busy} />
						) : <span>{award.name}</span>}
					</div>
					<p>
						{index === 0 && <span className="award-card__highest">최상위</span>}
						수상작 {award.projectIds.length}개
					</p>
				</div>

				<div className="award-card__actions">
					<div className="award-card__order">
						<Button
							variant="secondary"
							size="small"
							aria-label={`${award.name} 순위 올리기`}
							disabled={index === 0}
							onClick={() => void move(-1)}
						>
							↑
						</Button>
						<Button
							variant="secondary"
							size="small"
							aria-label={`${award.name} 순위 내리기`}
							disabled={index === state.items.length - 1}
							onClick={() => void move(1)}
						>
							↓
						</Button>
					</div>
					<Button
						variant="secondary"
						size="small"
						aria-expanded={expanded}
						aria-controls={panelId}
						onClick={onToggle}
					>
						{expanded ? '편집 닫기' : '수정'}
					</Button>
				</div>
			</div>
			<div className="award-card__icon-picker">
				<div className="award-card__icon-modes" role="group" aria-label={`${award.name} 아이콘 방식`}>
					<Button variant="secondary" size="small" aria-pressed={iconMode === 'laurel'} disabled={busy || uploadActive} onClick={() => {
						if (laurelIcons.some(icon => icon.key === award.builtinKey)) { setIconMode('laurel'); return; }
						void save(() => awardApi.edit(exhibitionId, state.version, { id: award.id, name: award.name, builtinKey: 'laurel-gold', assetId: null })).then(result => { if (result) setIconMode('laurel'); });
					}}>월계관</Button>
					<Button variant="secondary" size="small" aria-pressed={iconMode === 'photo'} disabled={busy || uploadActive} onClick={() => setIconMode('photo')}>커스텀</Button>
				</div>
				{iconMode === 'photo' && (
					<div className="award-card__photos" role="group" aria-label={`${award.name} 커스텀 아이콘`}>
						<Button className="award-card__icon-tile" variant="secondary" size="small" disabled={busy || uploadActive} onClick={() => imageInput.current?.click()}>
							<IconPlus aria-hidden="true" /><span>업로드</span>
						</Button>
						{state.assets.map(asset => (
							<div className="award-card__photo" key={asset.id}>
								<Button className="award-card__icon-tile" variant="secondary" size="small" title={asset.name} aria-label={`${asset.name} 적용`} aria-pressed={award.assetId === asset.id} disabled={busy || uploadActive} onClick={() => {
									if (award.assetId === asset.id) return;
									void save(() => awardApi.edit(exhibitionId, state.version, { id: award.id, name: award.name, builtinKey: null, assetId: asset.id }));
								}}>
									<AwardIcon award={{ ...award, builtinKey: null, assetId: asset.id, imageUrl: asset.imageUrl }} />
									<span>{asset.name}</span>
								</Button>
								<Button className="award-card__photo-delete" variant="secondary" size="small" aria-label={`${asset.name} 삭제`} disabled={busy || uploadActive || state.items.some(item => item.assetId === asset.id)} onClick={() => {
									if (window.confirm('이 이미지를 삭제하시겠습니까?')) void save(() => awardApi.deleteImage(exhibitionId, state.version, asset.id));
								}}><span aria-hidden="true">×</span></Button>
							</div>
						))}
					</div>
				)}
				<AwardColorEditor key={`${award.id}:${award.color ?? "default"}:${award.builtinKey}`} exhibitionId={exhibitionId} state={state} award={award} busy={busy || uploadActive} save={save} />
			</div>

			<ProjectUploadDialog
				open={uploadOpen}
				title={`${award.name} · 커스텀 아이콘 업로드`}
				description="커스텀 아이콘으로 사용할 이미지를 업로드합니다."
				total={uploadFiles.length}
				completed={uploadActive ? 0 : uploadFiles.length}
				busy={uploadActive || busy}
				actions={
					<>
						<Button
							variant="secondary"
							disabled={uploadActive || busy}
							onClick={() => imageInput.current?.click()}
						>
							＋ 파일 선택
						</Button>
						<Button
							disabled={uploadActive || busy}
							onClick={() => setUploadOpen(false)}
						>
							닫기
						</Button>
					</>
				}
			>
				<input
					ref={imageInput}
					type="file"
					accept="image/png,image/webp,image/jpeg"
					hidden
					aria-label={`${award.name} 이미지 파일`}
					onChange={(event) => {
						const files = Array.from(event.target.files ?? []);
						if (!files.length) return;
						setUploadFiles(files);
						setUploadAttempt((value) => value + 1);
						setUploadActive(true);
						setUploadOpen(true);
						event.target.value = '';
					}}
				/>
				<div className="award-upload-popup">
					{error && (
						<p className="field-error" role="alert">
							{error}
						</p>
					)}
					<p className="field-hint">
						업로드가 끝나면 커스텀 목록에서 이미지를 선택할 수 있습니다.
					</p>
					{uploadFiles.length > 0 && (
						<DirectImageUploadWidget
							key={uploadAttempt}
							initialFiles={uploadFiles}
							autoStart
							onCancelled={() => {
								setUploadActive(false);
								setUploadOpen(false);
								setUploadFiles([]);
							}}
							owner={{ type: 'EXHIBITION', id: exhibitionId }}
							kind="IMAGE"
							operationKey={`award-${award.id}`}
							hideTitle
							onComplete={() => {
								void qc.invalidateQueries({ queryKey: ['awards', exhibitionId] }).finally(() => {
									setUploadActive(false);
									setUploadOpen(false);
								});
							}}
						/>
					)}
					{!uploadFiles.length && (
						<div className="award-upload-popup__empty">
							파일을 선택하면 업로드가 시작됩니다.
						</div>
					)}
				</div>
			</ProjectUploadDialog>

			<div id={panelId} className="award-card__recipients">
				{expanded ? (
					<AwardRecipientsEditor
						key={JSON.stringify([award.id, award.projectIds])}
						exhibitionId={exhibitionId}
						state={state}
						award={award}
						save={save}
					/>
				) : <p>{names.length ? names.join(' · ') : '아직 수상작이 없습니다. 수정에서 작품을 선택하세요.'}</p>}
			</div>
		</li>
	);
}
function AwardNameEditor({ exhibitionId, state, award, save, busy }: Pick<CardProps, 'exhibitionId' | 'state' | 'award' | 'save' | 'busy'>) {
	const [name, setName] = useState(award.name);
	const changed = name !== award.name;
	const saveName = async () => {
		if (busy || !name.trim() || !changed) return;
		const result = await save(() => awardApi.edit(exhibitionId, state.version, {
			id: award.id, name, builtinKey: award.builtinKey, assetId: award.assetId,
		}));
		const saved = result?.items.find(item => item.id === award.id);
		if (saved) setName(saved.name);
	};
	return <div className="award-card__name-editor">
		<TextField label={<span className="sr-only">상 이름</span>} value={name} maxLength={100} autoFocus disabled={busy}
			onChange={event => setName(event.target.value)}
			onKeyDown={event => {
				if (event.nativeEvent.isComposing) return;
				if (event.key === 'Enter') { event.preventDefault(); void saveName(); }
				if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setName(award.name); }
			}} />
		<Button size="small" disabled={busy || !name.trim() || !changed} onClick={() => void saveName()}>이름 저장</Button>
	</div>;
}

function AwardRecipientsEditor({
	exhibitionId,
	state,
	award,
	save,
}: Pick<CardProps, 'exhibitionId' | 'state' | 'award' | 'save'>) {
	const [selected, setSelected] = useState(award.projectIds);
	const [search, setSearch] = useState('');
	const [page, setPage] = useState(0);
	const added = selected.filter((id) => !award.projectIds.includes(id));
	const removed = award.projectIds.filter((id) => !selected.includes(id));
	const candidates = state.projects.filter((p) =>
		matchesSearch([p.title, ...(p.members ?? []).flatMap(member => [member.name, member.studentId])], search),
	);
	return (
		<div className="award-card__recipients-editor">
			<div className="award-card__selection">
				<div className="award-settings__heading">
					<h4>수상작 선택</h4>
					<span className="award-settings__count">
						{selected.length}개 선택
					</span>
				</div>
				<TextField
					label="작품 검색"
					type="search"
					placeholder="작품명, 학생 이름, 학번으로 검색"
					value={search}
					onChange={(e) => {
						setSearch(e.target.value);
						setPage(0);
					}}
				/>
				<div className="award-card__projects">
					{candidates.slice(page * 20, (page + 1) * 20).map((p) => (
						<CheckboxField
							key={p.id}
							label={<AwardCandidateLabel project={p} search={search} />}
							checked={selected.includes(p.id)}
							onChange={(e) =>
								setSelected(
									e.target.checked
										? [...selected, p.id]
										: selected.filter((id) => id !== p.id),
								)
							}
						/>
					))}
					{!candidates.length && (
						<p className="field-hint">
							{state.projects.length
								? '검색 결과가 없습니다.'
								: '선택할 수 있는 작품이 없습니다.'}
						</p>
					)}
				</div>
				{candidates.length > 20 && (
					<div className="award-settings__actions">
						<Button
							size="small"
							variant="secondary"
							disabled={page === 0}
							onClick={() => setPage(page - 1)}
						>
							이전
						</Button>
						<span className="field-hint">
							{page + 1} / {Math.max(1, Math.ceil(candidates.length / 20))}
						</span>
						<Button
							size="small"
							variant="secondary"
							disabled={(page + 1) * 20 >= candidates.length}
							onClick={() => setPage(page + 1)}
						>
							다음
						</Button>
					</div>
				)}
				{(added.length > 0 || removed.length > 0) && (
					<div className="award-card__changes" role="status">
						<p>
							추가 {added.length}개 · 해제 {removed.length}개
						</p>
						{added.length > 0 && (
							<p>
								추가:{' '}
								{state.projects
									.filter((p) => added.includes(p.id))
									.map((p) => p.title)
									.join(', ')}
							</p>
						)}
						{removed.length > 0 && (
							<p>
								해제:{' '}
								{state.projects
									.filter((p) => removed.includes(p.id))
									.map((p) => p.title)
									.join(', ')}
							</p>
						)}
					</div>
				)}
				<Button
					disabled={!added.length && !removed.length}
					onClick={() =>
						void save(() =>
							awardApi.recipients(
								exhibitionId,
								state.version,
								award.id,
								added,
								removed,
							),
						)
					}
				>
					수상작 변경 저장
				</Button>
			</div>
			<div className="award-card__delete">
				<Button
					size="small"
					variant="danger"
					onClick={() => {
						if (
							window.confirm(
								`${award.name}을 삭제하면 ${award.projectIds.length}개 작품의 수상 연결이 해제됩니다. 삭제하시겠습니까?`,
							)
						)
							void save(() =>
								awardApi.remove(exhibitionId, state.version, award.id),
							);
					}}
				>
					상 삭제
				</Button>
				<span className="field-hint">
					삭제하면 이 상의 수상 연결도 해제됩니다.
				</span>
			</div>
		</div>
	);
}

function AwardCandidateLabel({ project, search }: { project: AwardState['projects'][number]; search: string }) {
	const members = project.members ?? [];
	const ordered = search.trim()
		? [...members].sort((a, b) => Number(matchesSearch([b.name, b.studentId], search)) - Number(matchesSearch([a.name, a.studentId], search)))
		: members;
	const memberText = (member: typeof members[number]) => member.studentId ? `${member.studentId} ${member.name}` : member.name;
	return (
		<span className="award-card__project-label">
			<span className="award-card__project-title" title={project.title}>{project.title}</span>
			<span className="award-card__project-members" title={members.map(memberText).join(' · ')}>
				{ordered.slice(0, 2).map((member, index) => (
					<span key={index} className="archive-card__member-pill" title={memberText(member)}>{memberText(member)}</span>
				))}
				{members.length > 2 && <span className="archive-card__member-pill award-card__project-more" aria-label={`참여자 ${members.length - 2}명 더 있음`}>+{members.length - 2}</span>}
			</span>
		</span>
	);
}
