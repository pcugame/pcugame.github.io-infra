import { useState, useMemo } from 'react';
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

  // data의 JSON을 키로 사용하여 서버 데이터가 바뀌면 edits를 자동 리셋
  const dataKey = useMemo(() => (data ? JSON.stringify(data) : ''), [data]);
  const [edits, setEdits] = useState<Partial<SiteSettingsData> | null>(null);
  const [lastDataKey, setLastDataKey] = useState(dataKey);

  if (dataKey && dataKey !== lastDataKey) {
    setLastDataKey(dataKey);
    setEdits(null);
  }

  const dirty = edits !== null;
  const form: SiteSettingsData = data
    ? { ...data, ...edits }
    : { maxGameFileMb: 5120, maxChunkSizeMb: 10, ...edits };

  const updateMutation = useMutation({
    mutationFn: (body: Partial<SiteSettingsData>) => adminSettingsApi.update(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminSettings });
      setEdits(null);
    },
  });

  const handleChange = (field: keyof SiteSettingsData, value: string) => {
    const num = parseInt(value, 10);
    if (isNaN(num)) return;
    setEdits((prev) => ({ ...prev, [field]: num }));
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
          <h1>사이트 설정</h1>
        </div>
      </div>

      <p className="field-hint" style={{ marginBottom: '1.5rem' }}>
        서버 재시작 없이 즉시 적용됩니다. 새로 만드는 업로드 세션부터 적용됩니다.
      </p>

      <div className="project-form">
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
            <p className="field-hint">
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
            <p className="field-hint">
              큰 값 = 적은 요청 수, 작은 값 = 불안정한 네트워크에 유리
            </p>
          </div>
        </fieldset>

        {updateMutation.error && (
          <div className="error-box" role="alert">
            <p>{getApiErrorMessage(updateMutation.error)}</p>
          </div>
        )}
        {updateMutation.isSuccess && !dirty && (
          <p className="success-message">저장되었습니다.</p>
        )}

        <div className="form-actions">
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={!dirty || updateMutation.isPending}
          >
            {updateMutation.isPending ? '저장 중…' : '설정 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
