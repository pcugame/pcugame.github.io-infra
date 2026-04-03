import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminBannedIpApi, getApiErrorMessage } from '../../lib/api';
import type { BannedIpItem } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';

export default function AdminBannedIpsPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.adminBannedIps,
    queryFn: adminBannedIpApi.list,
  });

  const unbanMutation = useMutation({
    mutationFn: (id: string) => adminBannedIpApi.unban(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminBannedIps });
    },
  });

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

  const items: BannedIpItem[] = data?.items ?? [];

  return (
    <div className="admin-banned-ips-page">
      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <span className="admin-page-header__eyebrow">IP Management</span>
          <h1>차단된 IP 관리</h1>
        </div>
      </div>

      <p style={{ marginBottom: '1rem', opacity: 0.7, fontSize: '0.9em' }}>
        게임 파일을 15분 내 30회 이상 다운로드한 IP는 자동 차단됩니다.
      </p>

      {items.length === 0 ? (
        <EmptyState message="차단된 IP가 없습니다." />
      ) : (
        <>
          {/* Desktop: table */}
          <div className="admin-card admin-desktop-only">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>IP 주소</th>
                  <th>사유</th>
                  <th>차단 일시</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><code>{item.ip}</code></td>
                    <td>{item.reason || '-'}</td>
                    <td className="text-muted">
                      {new Date(item.createdAt).toLocaleString('ko-KR')}
                    </td>
                    <td>
                      <button
                        className="btn btn--small btn--secondary"
                        onClick={() => {
                          if (confirm(`${item.ip} 차단을 해제하시겠습니까?`)) {
                            unbanMutation.mutate(item.id);
                          }
                        }}
                        disabled={unbanMutation.isPending}
                      >
                        차단 해제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: card list */}
          <div className="admin-mobile-cards">
            {items.map((item) => (
              <div key={item.id} className="admin-pcard">
                <div className="admin-pcard__top">
                  <h3 className="admin-pcard__title"><code>{item.ip}</code></h3>
                </div>
                <div className="admin-pcard__meta">
                  <span>{item.reason || '-'}</span>
                  <span className="admin-pcard__dot">&middot;</span>
                  <span>{new Date(item.createdAt).toLocaleString('ko-KR')}</span>
                </div>
                <div style={{ marginTop: '0.5rem' }}>
                  <button
                    className="btn btn--small btn--secondary"
                    onClick={() => {
                      if (confirm(`${item.ip} 차단을 해제하시겠습니까?`)) {
                        unbanMutation.mutate(item.id);
                      }
                    }}
                    disabled={unbanMutation.isPending}
                  >
                    차단 해제
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {unbanMutation.error && (
        <div className="error-box" role="alert" style={{ marginTop: '1rem' }}>
          <p>{getApiErrorMessage(unbanMutation.error)}</p>
        </div>
      )}
    </div>
  );
}
