import { describe, expect, it } from 'vitest';
import { PlatformsSchema, HardwareRequirementsSchema } from './project-requirements.js';
import { SubmitProjectPayloadBaseSchema, UpdateProjectBaseSchema } from './schemas.js';
import { ProjectChangeValuesSchema } from './project-change-schemas.js';
import { AdminProjectDetailSchema, PublicProjectDetailResponseSchema } from './response-schemas.js';

const baseSubmission = { exhibitionId: 1, title: 'Game', members: [{ name: 'Student', studentId: '20260001' }] };

describe('project platform and hardware contracts', () => {
 it('uses the same values for submissions, updates and change requests', () => {
  const values = { platforms: ['PC', 'MOBILE', 'WEB'], hardwareRequirements: '  VR 헤드셋\n전용 컨트롤러  ' };
  for (const [schema, input] of [
   [SubmitProjectPayloadBaseSchema, { ...baseSubmission, ...values }],
   [UpdateProjectBaseSchema, values],
   [ProjectChangeValuesSchema, values],
  ] as const) {
   expect(schema.parse(input)).toMatchObject({ platforms: values.platforms, hardwareRequirements: 'VR 헤드셋\n전용 컨트롤러' });
   expect(schema.safeParse({ ...input, platforms: ['CONSOLE'] }).success).toBe(false);
   expect(schema.safeParse({ ...input, hardwareRequirements: 'a'.repeat(1001) }).success).toBe(false);
  }
 });
 it('preserves omission and explicit clearing separately', () => {
  for (const schema of [UpdateProjectBaseSchema, ProjectChangeValuesSchema]) {
   expect(schema.parse({})).toEqual({});
   expect(schema.parse({ platforms: [], hardwareRequirements: '   ' })).toEqual({ platforms: [], hardwareRequirements: '' });
  }
  const legacy = SubmitProjectPayloadBaseSchema.parse(baseSubmission);
  expect(legacy).not.toHaveProperty('platforms');
  expect(legacy).not.toHaveProperty('hardwareRequirements');
 });
 it('accepts empty platforms and hardware up to the boundary', () => {
  expect(PlatformsSchema.parse([])).toEqual([]);
  expect(PlatformsSchema.safeParse(['PC', 'MOBILE', 'WEB', 'PC']).success).toBe(false);
  expect(HardwareRequirementsSchema.parse('a'.repeat(1000))).toHaveLength(1000);
 });
 it('defaults missing hardware in legacy detail response fields', () => {
  for (const schema of [AdminProjectDetailSchema, PublicProjectDetailResponseSchema]) {
   expect(schema.shape.hardwareRequirements.parse(undefined)).toBe('');
   expect(schema.shape.hardwareRequirements.parse('VR 헤드셋')).toBe('VR 헤드셋');
  }
 });
});
