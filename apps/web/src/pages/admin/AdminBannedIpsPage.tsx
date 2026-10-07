import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminBannedIpApi, getApiErrorMessage } from '../../lib/api';
import type { BannedIpItem } from '../../lib/api';
import { normalizeIpTarget } from '../../contracts';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage, EmptyState } from '../../components/common';
import { Button, FormSection, TextField } from '../../components/ui';

export default function AdminBannedIpsPage() {
  const qc = useQueryClient();
  const [ip, setIp] = useState('');
  const [reason, setReason] = useState('');

  const normalizedIp = useMemo(() => {
    if (!ip.trim()) return { value: null, error: null };
    try {
      return { value: normalizeIpTarget(ip), error: null };
    } catch {
      return { value: null, error: 'IPv4, IPv6 또는 CIDR 형식의 주소를 입력하세요. 포트와 호스트명은 사용할 수 없습니다.' };
    }
  }, [ip]);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.adminBannedIps,
    queryFn: adminBannedIpApi.list,
  });

  const unbanMutation = useMutation({
    mutationFn: (id: number) => adminBannedIpApi.unban(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminBannedIps });
    },
  });

  const createMutation = useMutation({
    mutationFn: (body: { ip: string; reason: string }) => adminBannedIpApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminBannedIps });
      setIp('');
      setReason('');
    },
  });

  const handleCreate = () => {
    if (!normalizedIp.value || !reason.trim()) return;
    if (window.confirm(`보호 자산 다운로드에 ${normalizedIp.value} 대역을 차단하시겠습니까?`)) {
      createMutation.mutate({ ip: normalizedIp.value, reason: reason.trim() });
    }
  };

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

      <p className="field-hint" style={{ marginBottom: '1rem' }}>
        수동 차단은 보호된 게임 파일 등 자산 다운로드에만 적용됩니다. 일반 조회, 로그인, 관리 API에는 적용되지 않습니다.
        자동 IP 차단은 현재 중단되어 있으며, 사용자·파일별 일시 제한과 다운로드 서버의 동시 연결 제한은 계속 적용됩니다.
        이미 발급된 서명 URL은 만료 전까지 사용할 수 있습니다.
      </p>

      <div className="admin-card" style={{ marginBottom: '1.5rem' }}>
        <FormSection legend="수동 IP/CIDR 차단 등록">
          <TextField
            id="banned-ip"
            label="IP 주소 또는 CIDR"
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            placeholder="203.0.113.42 또는 2001:db8::/32"
            autoComplete="off"
            hint={normalizedIp.value ? <>등록될 차단 대역: <code>{normalizedIp.value}</code></> : undefined}
            error={normalizedIp.error}
          />
          <TextField
            id="banned-ip-reason"
            label="사유"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            required
            placeholder="차단 사유를 입력하세요"
          />
          {createMutation.error && <div className="error-box" role="alert"><p>{getApiErrorMessage(createMutation.error)}</p></div>}
          {createMutation.isSuccess && <p className="success-message">수동 차단을 등록했습니다.</p>}
          <div className="form-actions">
            <Button onClick={handleCreate} disabled={!normalizedIp.value || !reason.trim() || createMutation.isPending}>
              {createMutation.isPending ? '등록 중…' : '차단 등록'}
            </Button>
          </div>
        </FormSection>
      </div>

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
                  <th>생성 구분</th>
                  <th>상태</th>
                  <th>차단 일시</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><code>{item.ip}</code></td>
                    <td>{item.reason || '-'}</td>
                    <td>{sourceLabel(item.source)}</td>
                    <td>{statusLabel(item)}</td>
                    <td className="text-muted">
                      {new Date(item.createdAt).toLocaleString('ko-KR')}
                    </td>
                    <td>{item.active && <Button
                        size="small" variant="secondary"
                        onClick={() => {
                          if (confirm(`${item.ip} 차단을 해제하시겠습니까?`)) {
                            unbanMutation.mutate(item.id);
                          }
                        }}
                        disabled={unbanMutation.isPending}
                      >
                        차단 해제
                      </Button>}</td>
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
                  <span>{sourceLabel(item.source)}</span>
                  <span className="admin-pcard__dot">&middot;</span>
                  <span>{statusLabel(item)}</span>
                  <span className="admin-pcard__dot">&middot;</span>
                  <span>{new Date(item.createdAt).toLocaleString('ko-KR')}</span>
                </div>
                {item.active && <div style={{ marginTop: '0.5rem' }}>
                  <Button
                    size="small" variant="secondary"
                    onClick={() => {
                      if (confirm(`${item.ip} 차단을 해제하시겠습니까?`)) {
                        unbanMutation.mutate(item.id);
                      }
                    }}
                    disabled={unbanMutation.isPending}
                  >
                    차단 해제
                  </Button>
                </div>}
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

function sourceLabel(source: BannedIpItem['source']): string {
  return source === 'MANUAL' ? '수동' : source === 'AUTO' ? '자동' : '기존 기록';
}

function statusLabel(item: BannedIpItem): string {
  if (item.active) return '활성';
  return item.source === 'AUTO' ? '자동 차단 효력 해제' : '비활성';
}
