import { describe, expect, it } from 'vitest';
import { RoleFieldPolicy } from './field-policy.impl';
import { permissionsForRoles, type Role } from './permissions';
import type { AuthUser } from './auth-user';

const user = (roles: Role[], id = 'u1'): AuthUser => ({
  id, username: 'x', fullName: 'X', roles, permissions: permissionsForRoles(roles), sessionId: 's', staffId: null, mfaVerified: true,
});
const policy = new RoleFieldPolicy();

const student = {
  id: 's1', studentCode: 'KSV-26-00417-7', fullName: 'Ama Owusu', className: 'P3 A', dateOfBirth: '2017-03-12',
  homeAddress: 'Hse 12, Adenta', hasMedicalAlert: true, allergies: 'peanuts', balancePesewas: 125000, arrearsPesewas: 50000, guardians: [],
};

describe('RoleFieldPolicy', () => {
  it('ADMIN and HEADTEACHER see the whole student', () => {
    expect(policy.apply('student', student, user(['ADMIN']))).toEqual(student);
    expect(policy.apply('student', student, user(['HEADTEACHER']))).toEqual(student);
  });

  it('BURSAR sees billing fields only: no address, no date of birth, no medical', () => {
    const r = policy.apply('student', student, user(['BURSAR']));
    expect(r).toEqual({ id: 's1', studentCode: 'KSV-26-00417-7', fullName: 'Ama Owusu', className: 'P3 A', hasMedicalAlert: true, balancePesewas: 125000, arrearsPesewas: 50000, guardians: [] });
  });

  it('REGISTRAR sees address and the balance total only', () => {
    const r = policy.apply('student', student, user(['REGISTRAR']));
    expect(r.homeAddress).toBeDefined();
    expect(r.balancePesewas).toBe(125000);
    expect(r.arrearsPesewas).toBeUndefined();
    expect(r.allergies).toBe('peanuts');
  });

  it('TEACHER sees no address, no money, no medical detail', () => {
    const r = policy.apply('student', student, user(['TEACHER']));
    expect(r).not.toHaveProperty('homeAddress');
    expect(r).not.toHaveProperty('balancePesewas');
    expect(r).not.toHaveProperty('allergies');
    expect(r.hasMedicalAlert).toBe(true);
  });

  it('roles combine as a union (BURSAR + REGISTRAR sees address and all money)', () => {
    const r = policy.apply('student', student, user(['BURSAR', 'REGISTRAR']));
    expect(r.homeAddress).toBeDefined();
    expect(r.arrearsPesewas).toBe(50000);
  });

  it('full Ghana Card and SSNIT never leave through normal responses', () => {
    const g = { id: 'g1', firstName: 'Kofi', ghanaCard: 'GHA-123456789-0', ghanaCardLast4: '7890', phonePrimary: '+233240000101', homeAddress: 'Tema', isFeePayer: true };
    expect(policy.apply('guardian', g, user(['ADMIN']))).not.toHaveProperty('ghanaCard');
    expect(policy.apply('guardian', g, user(['ADMIN'])).ghanaCardLast4).toBe('7890');
    expect(policy.apply('guardian', g, user(['BURSAR']))).toEqual({ id: 'g1', firstName: 'Kofi', phonePrimary: '+233240000101', isFeePayer: true });
    expect(policy.apply('guardian', g, user(['TEACHER']))).toEqual({ id: 'g1', firstName: 'Kofi', phonePrimary: '+233240000101' });
    const s = { id: 'st1', firstName: 'Yaw', jobTitle: 'Teacher', phone: '+233240000102', ssnitNo: 'C123', ghanaCard: 'GHA-1' };
    expect(policy.apply('staff', s, user(['ADMIN']))).toEqual({ id: 'st1', firstName: 'Yaw', jobTitle: 'Teacher', phone: '+233240000102' });
    expect(policy.apply('staff', s, user(['BURSAR']))).toEqual({ id: 'st1', firstName: 'Yaw', jobTitle: 'Teacher' });
    expect(policy.apply('staff', s, user(['REGISTRAR']))).toEqual({ id: 'st1', firstName: 'Yaw', jobTitle: 'Teacher', phone: '+233240000102' });
  });

  it('medical detail only for ADMIN, HEADTEACHER, REGISTRAR; others get the alert summary', () => {
    const m = { studentId: 's1', alertSummary: 'Severe peanut allergy', hasAlert: true, allergies: 'peanuts', medicationNotes: 'EpiPen' };
    expect(policy.apply('medical', m, user(['REGISTRAR']))).toEqual(m);
    expect(policy.apply('medical', m, user(['TEACHER']))).toEqual({ studentId: 's1', alertSummary: 'Severe peanut allergy', hasAlert: true });
    expect(policy.apply('medical', m, user(['BURSAR']))).toEqual({ studentId: 's1', alertSummary: 'Severe peanut allergy', hasAlert: true });
  });

  it('incidents: ADMIN, HEADTEACHER and the author only', () => {
    const i = { id: 'i1', description: 'Fight at break', reportedBy: 'teacher-1' };
    expect(policy.apply('incident', i, user(['HEADTEACHER']))).toEqual(i);
    expect(policy.apply('incident', i, user(['TEACHER'], 'teacher-1'))).toEqual(i);
    expect(policy.apply('incident', i, user(['TEACHER'], 'teacher-2'))).toEqual({ id: 'i1' });
    expect(policy.apply('incident', i, user(['REGISTRAR']))).toEqual({ id: 'i1' });
  });

  it('student finance: REGISTRAR total only, TEACHER nothing', () => {
    const f = { studentId: 's1', balancePesewas: 100, invoicedPesewas: 500, paidPesewas: 400 };
    expect(policy.apply('student_finance', f, user(['BURSAR']))).toEqual(f);
    expect(policy.apply('student_finance', f, user(['REGISTRAR']))).toEqual({ studentId: 's1', balancePesewas: 100 });
    expect(policy.apply('student_finance', f, user(['TEACHER']))).toEqual({});
  });
});
