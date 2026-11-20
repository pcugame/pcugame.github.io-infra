import '../../styles/features/term-origins.css';
import { LAB_PAGE_SIZE } from '@pcu/contracts';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, TextField } from '../../components/ui';
import { LabError } from '../../features/term-origins/common';
import { labApi, type LabBetaUser } from '../../lib/api/lab';
import { useViewerKey } from '../../lib/query/visibility';

export default function BetaUsersPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const viewerKey = useViewerKey();
  const client = useQueryClient();
  const users = useQuery({ queryKey: viewerKey(['lab-users', q, page]), queryFn: () => labApi.betaUsers(q, page) });
  const edit = useMutation({
    mutationFn: (user: LabBetaUser) => labApi.changeBeta(user.id, user.role === 'USER' ? 'BETA_TESTER' : 'USER'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['lab-users'] }),
  });
  return <section className="lab-page">
    <h1>베타 테스터 관리</h1>
    <p>베타 테스터로 지정한 사용자는 어구 평가 실험실을 이용할 수 있습니다.</p>
    <TextField label="사용자 검색" type="search" placeholder="이름, 이메일 또는 사용자 ID" value={q} maxLength={120} onChange={e => { setQ(e.target.value); setPage(1); }} />
    <LabError error={users.error || edit.error} />
    {users.isLoading && <p>사용자를 불러오는 중…</p>}
    {users.isSuccess && <ul className="lab-users">{users.data.items.map(user => <li key={user.id}>
      <span><strong>{user.name}</strong> · {user.email}</span>
      <span>{user.role}</span>
      <Button variant="secondary" size="small" disabled={edit.isPending || (user.role !== 'USER' && user.role !== 'BETA_TESTER')}
        onClick={() => edit.mutate(user)}>{user.role === 'BETA_TESTER' ? '베타 권한 회수' : '베타 권한 부여'}</Button>
    </li>)}</ul>}
    {users.isSuccess && !users.data.items.length && <p>일치하는 사용자가 없습니다.</p>}
    {users.isSuccess && (page > 1 || users.data.items.length === LAB_PAGE_SIZE) && <div className="lab-actions">
      <Button variant="secondary" size="small" disabled={page === 1} onClick={() => setPage(page - 1)}>이전</Button>
      <span>{page} 페이지</span>
      <Button variant="secondary" size="small" disabled={users.data.items.length < LAB_PAGE_SIZE} onClick={() => setPage(page + 1)}>다음</Button>
    </div>}
    {edit.data && <p role="status">{edit.data.email}의 역할을 {edit.data.role}로 저장했습니다.</p>}
  </section>;
}
