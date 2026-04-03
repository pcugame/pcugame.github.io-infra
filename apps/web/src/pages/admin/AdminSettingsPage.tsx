import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminSettingsApi, getApiErrorMessage } from '../../lib/api';
import type { SiteSettingsData } from '../../lib/api';
import { queryKeys } from '../../lib/query';
import { LoadingSpinner, ErrorMessage } from '../../components/common';

export default function AdminSettingsPage() {
  const qc = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: queryKeys.adminSettings,
    queryFn: adminSettingsApi.get,
  });

  const [form, setForm] = useState<SiteSettingsData>({ maxGameFileMb: 5120, maxChunkSizeMb: 10 });
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setForm(data);
      setDirty(false);
    }
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: (body: Partial<SiteSettingsData>) => adminSettingsApi.update(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminSettings });
      setDirty(false);
    },
  });

  const handleChange = (field: keyof SiteSettingsData, value: string) => {
    const num = parseInt(value, 10);
    if (isNaN(num)) return;
    setForm((prev) => ({ ...prev, [field]: num }));
    setDirty(true);
  };

  const handleSave = () => {
    updateMutation.mutate(form);
  };

  if (isLoading) return <LoadingSpinner />;
  if (error) return <ErrorMessage error={error} onReset={() => refetch()} />;

  const maxGameGb = (form.maxGameFileMb / 1024).toFixed(1);

  return (
    <div className="admin-settings-page">
      <div className="admin-page-header">
        <div className="admin-page-header__text">
          <span className="admin-page-header__eyebrow">Site Settings</span>
          <h1>사이트 설정</h1>
        </div>
      </div>

      <p style={{ marginBottom: '1.5rem', opacity: 0.7, fontSize: '0.9em' }}>
        서버 재시작 없이 즉시 적용됩니다. 새로 만드는 업로드 세션부터 적용됩니다.
      </p>

      <fieldset>
        <legend>업로드 제한</legend>

        <div className="form-field">
          <label htmlFor="maxGameFileMb">
            최대 게임 파일 크기 (MB)
          </label>
          <input
            id="maxGameFileMb"
            type="number"
            min={1}
            step={1024}
            value={form.maxGameFileMb}
            onChange={(e) => handleChange('maxGameFileMb', e.target.value)}
          />
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em', opacity: 0.6 }}>
            현재: {form.maxGameFileMb} MB ({maxGameGb} GB)
          </p>
        </div>

        <div className="form-field">
          <label htmlFor="maxChunkSizeMb">
            청크 크기 (MB)
          </label>
          <input
            id="maxChunkSizeMb"
            type="number"
            min={1}
            max={100}
            value={form.maxChunkSizeMb}
            onChange={(e) => handleChange('maxChunkSizeMb', e.target.value)}
          />
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85em', opacity: 0.6 }}>
            큰 값 = 적은 요청 수, 작은 값 = 불안정한 네트워크에 유리
          </p>
        </div>
      </fieldset>

      {updateMutation.error && (
        <div className="error-box" role="alert" style={{ marginTop: '1rem' }}>
          <p>{getApiErrorMessage(updateMutation.error)}</p>
        </div>
      )}
      {updateMutation.isSuccess && !dirty && (
        <p className="success-message">저장되었습니다.</p>
      )}

      <div className="form-actions" style={{ marginTop: '1rem' }}>
        <button
          className="btn btn--primary"
          onClick={handleSave}
          disabled={!dirty || updateMutation.isPending}
        >
          {updateMutation.isPending ? '저장 중…' : '설정 저장'}
        </button>
      </div>
    </div>
  );
}
