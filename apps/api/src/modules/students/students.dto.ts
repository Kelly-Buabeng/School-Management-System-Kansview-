// Owner: Agent B. Strict request schemas for students (from AdmitStudentRequest etc. in openapi.yaml).
import { z } from 'zod';
import { PageQuery } from '../../common/pagination';
import { zDate, zGhanaPhone, zUuid } from '../settings/common/http';
import { GuardianInput, GuardianLinkInput } from '../guardians/guardians.dto';

const opt = (max: number) => z.string().trim().max(max).optional();
const nul = (max: number) => z.string().trim().max(max).nullable().optional();

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'] as const;

export const StudentMedicalInput = z.strictObject({
  bloodGroup: z.enum(BLOOD_GROUPS).optional(),
  allergies: opt(1000),
  chronicConditions: opt(1000),
  medicationNotes: opt(1000),
  specialNeeds: opt(1000),
  doctorName: opt(120),
  clinicName: opt(150),
  clinicPhone: zGhanaPhone.optional(),
  alertSummary: opt(200),
});
export type StudentMedicalInput = z.infer<typeof StudentMedicalInput>;

export const EmergencyContactInput = z.strictObject({
  priority: z.number().int().min(1).max(50).optional(),
  guardianId: zUuid.optional(),
  name: opt(120),
  relationship: opt(60),
  phone: zGhanaPhone.optional(),
  notes: opt(300),
});
export type EmergencyContactInput = z.infer<typeof EmergencyContactInput>;

export const AdmitStudentBody = z.strictObject({
  firstName: z.string().trim().min(1).max(80),
  middleNames: opt(120),
  lastName: z.string().trim().min(1).max(80),
  preferredName: opt(80),
  dateOfBirth: zDate,
  gender: z.enum(['male', 'female']),
  nationality: z.string().trim().max(60).default('Ghanaian'),
  homeAddress: opt(300),
  previousSchool: opt(150),
  admissionDate: zDate,
  classId: zUuid,
  birthCertNo: opt(50),
  religion: opt(50),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  guardians: z.array(GuardianLinkInput).min(1, 'Add at least one parent or guardian').max(6),
  medical: StudentMedicalInput.optional(),
  emergencyContacts: z.array(EmergencyContactInput).max(10).optional(),
  confirmNotDuplicate: z.boolean().optional(),
  duplicateOverrideReason: z.string().trim().max(300).optional(),
});
export type AdmitStudentBody = z.infer<typeof AdmitStudentBody>;

export const DuplicateCheckBody = z.strictObject({
  firstName: z.string().trim().min(1).max(80),
  middleNames: opt(120),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: zDate,
  guardianPhones: z.array(zGhanaPhone).max(10).default([]),
  guardianIds: z.array(zUuid).max(10).default([]),
});
export type DuplicateCheckBody = z.infer<typeof DuplicateCheckBody>;

export const UpdateStudentBody = z.strictObject({
  firstName: z.string().trim().min(1).max(80).optional(),
  middleNames: nul(120),
  lastName: z.string().trim().min(1).max(80).optional(),
  preferredName: nul(80),
  dateOfBirth: zDate.optional(),
  gender: z.enum(['male', 'female']).optional(),
  nationality: nul(60),
  homeAddress: nul(300),
  previousSchool: nul(150),
  admissionDate: zDate.optional(),
  birthCertNo: nul(50),
  religion: nul(50),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});
export type UpdateStudentBody = z.infer<typeof UpdateStudentBody>;

export const STUDENT_STATUSES = ['applicant', 'active', 'withdrawn', 'transferred_out', 'alumni', 'deceased'] as const;
export const ListStudentsQuery = PageQuery.extend({
  q: z.string().trim().max(100).optional(),
  classId: zUuid.optional(),
  levelId: zUuid.optional(),
  status: z.enum(STUDENT_STATUSES).optional(),
  sort: z.enum(['lastName', '-lastName', 'admissionDate', '-admissionDate', 'studentCode']).optional(),
});
export type ListStudentsQuery = z.infer<typeof ListStudentsQuery>;

export const ArchiveBody = z.strictObject({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(300) });

export const DOCUMENT_TYPES = ['birth_certificate', 'previous_report', 'passport_photo', 'other'] as const;
export const UploadDocumentBody = z.strictObject({ docType: z.enum(DOCUMENT_TYPES), notes: opt(500) });

export { GuardianInput };
