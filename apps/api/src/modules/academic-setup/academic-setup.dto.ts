// Owner: Agent B. Strict request schemas for academic setup.
import { z } from 'zod';
import { zDate, zUuid } from '../settings/common/http';

const TermInput = z.strictObject({
  number: z.number().int().min(1).max(3),
  name: z.string().trim().min(1).max(40).optional(),
  startDate: zDate,
  endDate: zDate,
});

export const CreateAcademicYearBody = z.strictObject({
  name: z.string().regex(/^\d{4}\/\d{4}$/, 'Use the format 2026/2027'),
  startDate: zDate,
  endDate: zDate,
  terms: z.array(TermInput).length(3, 'An academic year has exactly 3 terms'),
});
export type CreateAcademicYearBody = z.infer<typeof CreateAcademicYearBody>;

export const UpdateAcademicYearBody = z.strictObject({
  name: z.string().regex(/^\d{4}\/\d{4}$/).optional(),
  startDate: zDate.optional(),
  endDate: zDate.optional(),
  status: z.enum(['planned', 'closed']).optional(),
});
export type UpdateAcademicYearBody = z.infer<typeof UpdateAcademicYearBody>;

export const UpdateTermBody = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  startDate: zDate.optional(),
  endDate: zDate.optional(),
  status: z.enum(['planned', 'current', 'closed']).optional(),
});
export type UpdateTermBody = z.infer<typeof UpdateTermBody>;

export const CreateLevelBody = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{1,10}$/, 'Capital letters and digits only, e.g. P4 or JHS1'),
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(1000),
  isFinalLevel: z.boolean().default(false),
  nextLevelId: zUuid.nullable().optional(),
  classScoreWeight: z.number().int().min(0).max(100).optional(),
  examScoreWeight: z.number().int().min(0).max(100).optional(),
});
export type CreateLevelBody = z.infer<typeof CreateLevelBody>;

export const UpdateLevelBody = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{1,10}$/).optional(),
  name: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isFinalLevel: z.boolean().optional(),
  nextLevelId: zUuid.nullable().optional(),
  isActive: z.boolean().optional(),
  classScoreWeight: z.number().int().min(0).max(100).optional(),
  examScoreWeight: z.number().int().min(0).max(100).optional(),
});
export type UpdateLevelBody = z.infer<typeof UpdateLevelBody>;

export const CreateClassBody = z.strictObject({
  academicYearId: zUuid,
  levelId: zUuid,
  stream: z.string().regex(/^[A-Z]{1,3}$/, 'Stream is 1-3 capital letters, e.g. A').nullable().optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  classTeacherStaffId: zUuid.nullable().optional(),
});
export type CreateClassBody = z.infer<typeof CreateClassBody>;

export const UpdateClassBody = z.strictObject({
  stream: z.string().regex(/^[A-Z]{1,3}$/).nullable().optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  classTeacherStaffId: zUuid.nullable().optional(),
});
export type UpdateClassBody = z.infer<typeof UpdateClassBody>;

export const ListClassesQuery = z.strictObject({ academicYearId: zUuid.optional(), levelId: zUuid.optional() });

export const CreateSubjectBody = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9_-]{1,20}$/i).transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(80),
  isActive: z.boolean().default(true),
});
export const UpdateSubjectBody = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9_-]{1,20}$/i).transform((s) => s.toUpperCase()).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
});

export const SetLevelSubjectsBody = z.strictObject({ subjectIds: z.array(zUuid).max(40) });

const BandInput = z.strictObject({
  minScore: z.number().int().min(0).max(100),
  maxScore: z.number().int().min(0).max(100),
  grade: z.string().trim().min(1).max(10),
  remark: z.string().trim().max(60).nullable().optional(),
});
export const GradingScaleBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  appliesToLevelIds: z.array(zUuid).max(30).default([]),
  isDefault: z.boolean().default(false),
  bands: z.array(BandInput).min(1).max(20),
});
export type GradingScaleBody = z.infer<typeof GradingScaleBody>;
