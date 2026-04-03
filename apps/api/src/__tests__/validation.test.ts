import { describe, it, expect } from 'vitest';
import {
  CreateYearBody,
  UpdateYearBody,
  UpdateProjectBody,
  SubmitProjectPayload,
  AddMemberBody,
  UpdateMemberBody,
  SetPosterBody,
  GoogleLoginBody,
  ProjectStatusEnum,
  DownloadPolicyEnum,
  AssetKindEnum,
} from '../shared/validation.js';

// ── Enum schemas ─────────────────────────────────────────────

describe('ProjectStatusEnum', () => {
  it('accepts valid statuses', () => {
    expect(ProjectStatusEnum.parse('DRAFT')).toBe('DRAFT');
    expect(ProjectStatusEnum.parse('PUBLISHED')).toBe('PUBLISHED');
    expect(ProjectStatusEnum.parse('ARCHIVED')).toBe('ARCHIVED');
  });

  it('rejects invalid status', () => {
    expect(() => ProjectStatusEnum.parse('DELETED')).toThrow();
    expect(() => ProjectStatusEnum.parse('')).toThrow();
    expect(() => ProjectStatusEnum.parse(123)).toThrow();
  });
});

describe('DownloadPolicyEnum', () => {
  it('accepts valid policies', () => {
    for (const v of ['NONE', 'PUBLIC', 'SCHOOL_ONLY', 'ADMIN_ONLY']) {
      expect(DownloadPolicyEnum.parse(v)).toBe(v);
    }
  });

  it('rejects invalid policy', () => {
    expect(() => DownloadPolicyEnum.parse('PRIVATE')).toThrow();
  });
});

describe('AssetKindEnum', () => {
  it('accepts valid kinds', () => {
    for (const v of ['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME']) {
      expect(AssetKindEnum.parse(v)).toBe(v);
    }
  });

  it('rejects invalid kind', () => {
    expect(() => AssetKindEnum.parse('VIDEO')).toThrow();
  });
});

// ── Year schemas ─────────────────────────────────────────────

describe('CreateYearBody', () => {
  it('accepts valid input with defaults', () => {
    const result = CreateYearBody.parse({ year: 2025 });
    expect(result).toEqual({
      year: 2025,
      title: '',
      isUploadEnabled: true,
      sortOrder: 0,
    });
  });

  it('accepts full input', () => {
    const result = CreateYearBody.parse({
      year: 2026,
      title: '졸업전시',
      isUploadEnabled: false,
      sortOrder: 5,
    });
    expect(result.year).toBe(2026);
    expect(result.title).toBe('졸업전시');
    expect(result.isUploadEnabled).toBe(false);
    expect(result.sortOrder).toBe(5);
  });

  it('rejects year below 2021', () => {
    expect(() => CreateYearBody.parse({ year: 2020 })).toThrow();
  });

  it('rejects year above 2100', () => {
    expect(() => CreateYearBody.parse({ year: 2101 })).toThrow();
  });

  it('rejects non-integer year', () => {
    expect(() => CreateYearBody.parse({ year: 2025.5 })).toThrow();
  });

  it('rejects missing year', () => {
    expect(() => CreateYearBody.parse({})).toThrow();
  });

  it('rejects negative sortOrder', () => {
    expect(() => CreateYearBody.parse({ year: 2025, sortOrder: -1 })).toThrow();
  });

  it('rejects title over 100 chars', () => {
    expect(() =>
      CreateYearBody.parse({ year: 2025, title: 'a'.repeat(101) }),
    ).toThrow();
  });
});

describe('UpdateYearBody', () => {
  it('accepts empty object (all optional)', () => {
    const result = UpdateYearBody.parse({});
    expect(result).toEqual({});
  });

  it('accepts partial update', () => {
    const result = UpdateYearBody.parse({ title: '수정', sortOrder: 3 });
    expect(result.title).toBe('수정');
    expect(result.sortOrder).toBe(3);
    expect(result.isUploadEnabled).toBeUndefined();
  });
});

// ── Project update schema ────────────────────────────────────

describe('UpdateProjectBody', () => {
  it('accepts empty object', () => {
    expect(UpdateProjectBody.parse({})).toEqual({});
  });

  it('accepts valid status', () => {
    const result = UpdateProjectBody.parse({ status: 'PUBLISHED' });
    expect(result.status).toBe('PUBLISHED');
  });

  it('rejects invalid status', () => {
    expect(() => UpdateProjectBody.parse({ status: 'INVALID' })).toThrow();
  });

  it('accepts valid downloadPolicy', () => {
    const result = UpdateProjectBody.parse({ downloadPolicy: 'SCHOOL_ONLY' });
    expect(result.downloadPolicy).toBe('SCHOOL_ONLY');
  });

  it('rejects invalid downloadPolicy', () => {
    expect(() =>
      UpdateProjectBody.parse({ downloadPolicy: 'EVERYONE' }),
    ).toThrow();
  });

  it('rejects title over 120 chars', () => {
    expect(() =>
      UpdateProjectBody.parse({ title: 'x'.repeat(121) }),
    ).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => UpdateProjectBody.parse({ title: '' })).toThrow();
  });

  it('accepts videoUrl as empty string', () => {
    const result = UpdateProjectBody.parse({ videoUrl: '' });
    expect(result.videoUrl).toBe('');
  });

  it('accepts videoUrl as null', () => {
    const result = UpdateProjectBody.parse({ videoUrl: null });
    expect(result.videoUrl).toBeNull();
  });

  it('accepts isLegacy boolean', () => {
    const result = UpdateProjectBody.parse({ isLegacy: true });
    expect(result.isLegacy).toBe(true);
  });

  it('rejects negative sortOrder', () => {
    expect(() => UpdateProjectBody.parse({ sortOrder: -1 })).toThrow();
  });
});

// ── Submit project payload ───────────────────────────────────

describe('SubmitProjectPayload', () => {
  const validPayload = {
    year: 2025,
    title: 'My Game',
    members: [{ name: '홍길동', studentId: '2021001' }],
  };

  it('accepts valid minimal payload', () => {
    const result = SubmitProjectPayload.parse(validPayload);
    expect(result.year).toBe(2025);
    expect(result.title).toBe('My Game');
    expect(result.summary).toBe('');
    expect(result.autoPublish).toBe(false);
    expect(result.members).toHaveLength(1);
  });

  it('rejects missing title', () => {
    expect(() =>
      SubmitProjectPayload.parse({ ...validPayload, title: undefined }),
    ).toThrow();
  });

  it('rejects empty members array', () => {
    expect(() =>
      SubmitProjectPayload.parse({ ...validPayload, members: [] }),
    ).toThrow();
  });

  it('rejects member with empty name', () => {
    expect(() =>
      SubmitProjectPayload.parse({
        ...validPayload,
        members: [{ name: '', studentId: '123' }],
      }),
    ).toThrow();
  });

  it('rejects member with empty studentId', () => {
    expect(() =>
      SubmitProjectPayload.parse({
        ...validPayload,
        members: [{ name: 'Test', studentId: '' }],
      }),
    ).toThrow();
  });
});

// ── Member schemas ───────────────────────────────────────────

describe('AddMemberBody', () => {
  it('accepts valid input', () => {
    const result = AddMemberBody.parse({ name: '김철수', studentId: '2022001' });
    expect(result.sortOrder).toBe(0);
  });

  it('rejects missing name', () => {
    expect(() => AddMemberBody.parse({ studentId: '123' })).toThrow();
  });

  it('rejects name over 50 chars', () => {
    expect(() =>
      AddMemberBody.parse({ name: 'a'.repeat(51), studentId: '123' }),
    ).toThrow();
  });
});

describe('UpdateMemberBody', () => {
  it('accepts empty object', () => {
    expect(UpdateMemberBody.parse({})).toEqual({});
  });

  it('accepts partial name update', () => {
    expect(UpdateMemberBody.parse({ name: '새이름' }).name).toBe('새이름');
  });
});

// ── Poster / Auth schemas ────────────────────────────────────

describe('SetPosterBody', () => {
  it('accepts valid UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(SetPosterBody.parse({ assetId: uuid }).assetId).toBe(uuid);
  });

  it('rejects non-UUID', () => {
    expect(() => SetPosterBody.parse({ assetId: 'not-a-uuid' })).toThrow();
  });

  it('rejects missing assetId', () => {
    expect(() => SetPosterBody.parse({})).toThrow();
  });
});

describe('GoogleLoginBody', () => {
  it('accepts valid credential', () => {
    expect(GoogleLoginBody.parse({ credential: 'token123' }).credential).toBe(
      'token123',
    );
  });

  it('rejects empty credential', () => {
    expect(() => GoogleLoginBody.parse({ credential: '' })).toThrow();
  });

  it('rejects missing credential', () => {
    expect(() => GoogleLoginBody.parse({})).toThrow();
  });
});
