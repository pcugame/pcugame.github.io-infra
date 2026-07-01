import { describe, it, expect } from 'vitest';
import {
  CreateExhibitionBody,
  UpdateExhibitionBody,
  UpdateProjectBody,
  SubmitProjectPayload,
  AddMemberBody,
  UpdateMemberBody,
  SetPosterBody,
  GoogleLoginBody,
  ProjectStatusEnum,
  AssetKindEnum,
  parseIntParam,
} from '../shared/validation.js';
import type {
  AddMemberRequest,
  AddMemberSchemaInput,
  CreateExhibitionBaseSchemaInput,
  CreateExhibitionRequest,
  SubmitProjectPayload as SubmitProjectPayloadContract,
  SubmitProjectPayloadBaseSchemaInput,
  UpdateExhibitionBaseSchemaInput,
  UpdateExhibitionRequest,
  UpdateMemberBaseSchemaInput,
  UpdateMemberRequest,
  UpdateProjectBaseSchemaInput,
  UpdateProjectRequest,
} from '@pcu/contracts';

type IsExact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
  : false;

const updateMemberBodyMatchesContract: IsExact<
  ReturnType<typeof UpdateMemberBody.parse>,
  UpdateMemberRequest
> = true;
const createExhibitionSchemaMatchesContract: IsExact<
  CreateExhibitionBaseSchemaInput,
  CreateExhibitionRequest
> = true;
const updateExhibitionSchemaMatchesContract: IsExact<
  UpdateExhibitionBaseSchemaInput,
  UpdateExhibitionRequest
> = true;
const updateProjectSchemaMatchesContract: IsExact<
  UpdateProjectBaseSchemaInput,
  UpdateProjectRequest
> = true;
const submitProjectSchemaMatchesContract: IsExact<
  SubmitProjectPayloadBaseSchemaInput,
  SubmitProjectPayloadContract
> = true;
const addMemberSchemaMatchesContract: IsExact<
  AddMemberSchemaInput,
  AddMemberRequest
> = true;
const updateMemberSchemaMatchesContract: IsExact<
  UpdateMemberBaseSchemaInput,
  UpdateMemberRequest
> = true;

// ── Enum schemas ─────────────────────────────────────────────

describe('ProjectStatusEnum', () => {
  it('keeps shared schema inferred types aligned with transport contracts', () => {
    expect(createExhibitionSchemaMatchesContract).toBe(true);
    expect(updateExhibitionSchemaMatchesContract).toBe(true);
    expect(updateProjectSchemaMatchesContract).toBe(true);
    expect(submitProjectSchemaMatchesContract).toBe(true);
    expect(addMemberSchemaMatchesContract).toBe(true);
    expect(updateMemberSchemaMatchesContract).toBe(true);
  });

  it('accepts valid statuses', () => {
    expect(ProjectStatusEnum.parse('PUBLISHED')).toBe('PUBLISHED');
    expect(ProjectStatusEnum.parse('ARCHIVED')).toBe('ARCHIVED');
  });

  it('rejects invalid status', () => {
    expect(() => ProjectStatusEnum.parse('DRAFT')).toThrow();
    expect(() => ProjectStatusEnum.parse('DELETED')).toThrow();
    expect(() => ProjectStatusEnum.parse('')).toThrow();
    expect(() => ProjectStatusEnum.parse(123)).toThrow();
  });
});

describe('AssetKindEnum', () => {
  it('accepts valid kinds', () => {
    for (const v of ['THUMBNAIL', 'IMAGE', 'POSTER', 'GAME', 'VIDEO']) {
      expect(AssetKindEnum.parse(v)).toBe(v);
    }
  });

  it('rejects invalid kind', () => {
    expect(() => AssetKindEnum.parse('AUDIO')).toThrow();
  });
});

// ── Exhibition schemas ──────────────────────────────────────

describe('CreateExhibitionBody', () => {
  it('accepts valid input with defaults', () => {
    const result = CreateExhibitionBody.parse({ year: 2025 });
    expect(result).toEqual({
      year: 2025,
      title: '',
      isUploadEnabled: true,
      sortOrder: 0,
    });
  });

  it('accepts full input', () => {
    const result = CreateExhibitionBody.parse({
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
    expect(() => CreateExhibitionBody.parse({ year: 2020 })).toThrow();
  });

  it('rejects year above 2100', () => {
    expect(() => CreateExhibitionBody.parse({ year: 2101 })).toThrow();
  });

  it('rejects non-integer year', () => {
    expect(() => CreateExhibitionBody.parse({ year: 2025.5 })).toThrow();
  });

  it('rejects missing year', () => {
    expect(() => CreateExhibitionBody.parse({})).toThrow();
  });

  it('rejects negative sortOrder', () => {
    expect(() => CreateExhibitionBody.parse({ year: 2025, sortOrder: -1 })).toThrow();
  });

  it('rejects title over 100 chars', () => {
    expect(() =>
      CreateExhibitionBody.parse({ year: 2025, title: 'a'.repeat(101) }),
    ).toThrow();
  });
});

describe('UpdateExhibitionBody', () => {
  it('accepts empty object (all optional)', () => {
    const result = UpdateExhibitionBody.parse({});
    expect(result).toEqual({});
  });

  it('accepts partial update', () => {
    const result = UpdateExhibitionBody.parse({ title: '수정', sortOrder: 3 });
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

  it('rejects title over 120 chars', () => {
    expect(() =>
      UpdateProjectBody.parse({ title: 'x'.repeat(121) }),
    ).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => UpdateProjectBody.parse({ title: '' })).toThrow();
  });

  it('accepts isIncomplete boolean', () => {
    const result = UpdateProjectBody.parse({ isIncomplete: true });
    expect(result.isIncomplete).toBe(true);
  });

  it('rejects negative sortOrder', () => {
    expect(() => UpdateProjectBody.parse({ sortOrder: -1 })).toThrow();
  });
});

// ── Submit project payload ───────────────────────────────────

describe('SubmitProjectPayload', () => {
  const validPayload = {
    exhibitionId: 1,
    title: 'My Game',
    members: [{ name: '홍길동', studentId: '2021001' }],
  };

  it('accepts valid minimal payload', () => {
    const result = SubmitProjectPayload.parse(validPayload);
    expect(result.exhibitionId).toBe(1);
    expect(result.title).toBe('My Game');
    expect(result.summary).toBe('');
    expect(result.members).toHaveLength(1);
  });

  it('coerces string exhibitionId to number', () => {
    const result = SubmitProjectPayload.parse({ ...validPayload, exhibitionId: '42' });
    expect(result.exhibitionId).toBe(42);
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
  it('matches the shared UpdateMemberRequest contract', () => {
    expect(updateMemberBodyMatchesContract).toBe(true);
  });

  it('accepts empty object', () => {
    expect(UpdateMemberBody.parse({})).toEqual({});
  });

  it('accepts partial name update', () => {
    expect(UpdateMemberBody.parse({ name: '새이름' }).name).toBe('새이름');
  });

  it('accepts profile fields only', () => {
    expect(UpdateMemberBody.parse({
      name: '새이름',
      studentId: '20229999',
      sortOrder: 2,
    })).toEqual({
      name: '새이름',
      studentId: '20229999',
      sortOrder: 2,
    });
  });

  it('rejects userId linking fields', () => {
    expect(() => UpdateMemberBody.parse({ userId: 123 })).toThrow();
    expect(() => UpdateMemberBody.parse({ userId: null })).toThrow();
  });
});

// ── Poster / Auth schemas ────────────────────────────────────

describe('SetPosterBody', () => {
  it('accepts valid integer', () => {
    expect(SetPosterBody.parse({ assetId: 42 }).assetId).toBe(42);
  });

  it('coerces string to number', () => {
    expect(SetPosterBody.parse({ assetId: '7' }).assetId).toBe(7);
  });

  it('rejects non-positive number', () => {
    expect(() => SetPosterBody.parse({ assetId: 0 })).toThrow();
    expect(() => SetPosterBody.parse({ assetId: -1 })).toThrow();
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

// ── parseIntParam ─────────────────────────────────────────────

describe('parseIntParam', () => {
  it('parses valid integer string', () => {
    expect(parseIntParam('42')).toBe(42);
  });

  it('throws on non-numeric string', () => {
    expect(() => parseIntParam('abc')).toThrow();
  });

  it('throws on zero', () => {
    expect(() => parseIntParam('0')).toThrow();
  });

  it('throws on negative', () => {
    expect(() => parseIntParam('-1')).toThrow();
  });

  it('throws on float', () => {
    expect(() => parseIntParam('1.5')).toThrow();
  });
});
