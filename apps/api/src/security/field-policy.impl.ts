import { Injectable } from '@nestjs/common';
import type { AuthUser } from './auth-user';
import type { FieldPolicy, PolicyResource } from './field-policy';
import type { Role } from './permissions';

/**
 * Field-level rules from docs/contracts/rbac.md ("Field-level rules" and the matrix notes).
 * Each role yields a rule for a resource; a user with several roles sees the union of what each role may see.
 * Keys are the camelCase API field names. Unknown fields are kept unless a rule is an allow-list,
 * so sensitive groups are named explicitly here and BURSAR/TEACHER use allow-lists (least privilege).
 *
 * Never returned by any normal response (only by the audited reveal endpoints): full Ghana Card, SSNIT.
 */
type Rule = { kind: 'all' } | { kind: 'deny'; keys: (key: string) => boolean } | { kind: 'allow'; keys: (key: string) => boolean } | { kind: 'none' };

const ALL: Rule = { kind: 'all' };
const NONE: Rule = { kind: 'none' };
const allow = (...keys: string[]): Rule => ({ kind: 'allow', keys: (k) => keys.includes(k) });
const deny = (pred: (k: string) => boolean): Rule => ({ kind: 'deny', keys: pred });

const ALWAYS_HIDDEN = new Set(['ghanaCard', 'ghanaCardNumber', 'ghanaCardEnc', 'ghanaCardBidx', 'ssnitNo', 'ssnitNoEnc', 'passwordHash', 'mfaSecretEnc', 'mfaRecoveryCodesHash']);
const ADDRESS = (k: string) => k === 'homeAddress' || k === 'workAddress' || k === 'address';
const MONEY = (k: string) => k.endsWith('Pesewas') || k === 'balance' || k === 'finance';
const MEDICAL_DETAIL = (k: string) => k === 'medical' || k === 'allergies' || k === 'chronicConditions' || k === 'medicationNotes' || k === 'specialNeeds' || k === 'bloodGroup' || k === 'doctorName' || k === 'clinicName' || k === 'clinicPhone';

const STUDENT_IDENTITY = ['id', 'studentCode', 'fullName', 'firstName', 'middleNames', 'lastName', 'preferredName', 'className', 'classId', 'rollNumber', 'status', 'photoUrl', 'hasMedicalAlert', 'version'];

function studentRule(role: Role): Rule {
  switch (role) {
    case 'ADMIN':
    case 'HEADTEACHER':
      return ALL;
    case 'REGISTRAR': // balance total only, no other money fields
      return deny((k) => MONEY(k) && k !== 'balancePesewas');
    case 'BURSAR': // name, code, class, guardians for billing, finance
      return { kind: 'allow', keys: (k) => STUDENT_IDENTITY.includes(k) || k === 'guardians' || MONEY(k) };
    case 'TEACHER': // own classes (ScopeService), no address, no finance, no medical detail
      return { kind: 'allow', keys: (k) => [...STUDENT_IDENTITY, 'dateOfBirth', 'gender', 'guardians', 'medicalAlertSummary', 'alertSummary'].includes(k) };
  }
}

function guardianRule(role: Role): Rule {
  switch (role) {
    case 'ADMIN':
    case 'HEADTEACHER':
    case 'REGISTRAR':
      return ALL;
    case 'BURSAR':
      return allow('id', 'title', 'firstName', 'lastName', 'fullName', 'phonePrimary', 'phoneSecondary', 'whatsappNumber', 'email', 'isFeePayer', 'relationship', 'isPrimary', 'version');
    case 'TEACHER':
      return allow('id', 'title', 'firstName', 'lastName', 'fullName', 'phonePrimary', 'phoneSecondary', 'relationship', 'isPrimary', 'canPickUp');
  }
}

function staffRule(role: Role): Rule {
  switch (role) {
    case 'ADMIN':
    case 'HEADTEACHER':
      return ALL;
    case 'BURSAR':
      return allow('id', 'staffCode', 'firstName', 'lastName', 'fullName', 'jobTitle', 'staffType', 'status');
    case 'REGISTRAR':
      return allow('id', 'staffCode', 'firstName', 'lastName', 'fullName', 'jobTitle', 'staffType', 'status', 'phone');
    case 'TEACHER':
      return allow('id', 'firstName', 'lastName', 'fullName');
  }
}

function medicalRule(role: Role): Rule {
  if (role === 'ADMIN' || role === 'HEADTEACHER' || role === 'REGISTRAR') return ALL;
  return allow('studentId', 'alertSummary', 'hasAlert');
}

function financeRule(role: Role): Rule {
  if (role === 'ADMIN' || role === 'BURSAR' || role === 'HEADTEACHER') return ALL;
  if (role === 'REGISTRAR') return allow('studentId', 'balancePesewas');
  return NONE;
}

function incidentRule(role: Role, dto: Record<string, unknown>, user: AuthUser): Rule {
  if (role === 'ADMIN' || role === 'HEADTEACHER') return ALL;
  const author = dto.reportedBy ?? dto.reportedByUserId ?? dto.createdBy;
  if (author !== undefined && author === user.id) return ALL;
  return allow('id');
}

function ruleFor(resource: PolicyResource, role: Role, dto: Record<string, unknown>, user: AuthUser): Rule {
  switch (resource) {
    case 'student': return studentRule(role);
    case 'guardian': return guardianRule(role);
    case 'staff': return staffRule(role);
    case 'medical': return medicalRule(role);
    case 'student_finance': return financeRule(role);
    case 'incident': return incidentRule(role, dto, user);
  }
}

function visible(rule: Rule, key: string): boolean {
  switch (rule.kind) {
    case 'all': return true;
    case 'none': return false;
    case 'allow': return rule.keys(key);
    case 'deny': return !rule.keys(key);
  }
}

@Injectable()
export class RoleFieldPolicy implements FieldPolicy {
  apply<T extends Record<string, unknown>>(resource: PolicyResource, dto: T, user: AuthUser): Partial<T> {
    const rules = user.roles.map((r) => ruleFor(resource, r, dto, user));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(dto) as Array<keyof T & string>) {
      if (ALWAYS_HIDDEN.has(key)) continue;
      if (resource === 'student' && MEDICAL_DETAIL(key) && !user.permissions.has('medical:read')) continue;
      if (resource === 'student' && ADDRESS(key) && !user.roles.some((r) => r === 'ADMIN' || r === 'HEADTEACHER' || r === 'REGISTRAR')) continue;
      if (resource === 'guardian' && ADDRESS(key) && !user.roles.some((r) => r === 'ADMIN' || r === 'HEADTEACHER' || r === 'REGISTRAR')) continue;
      if (rules.some((rule) => visible(rule, key))) out[key] = dto[key];
    }
    return out as Partial<T>;
  }
}
