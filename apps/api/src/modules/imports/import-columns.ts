/**
 * Column catalogue for the three import types. One source of truth for:
 * - the downloadable templates (header text, help text, dropdowns, example rows),
 * - header matching when reading a school's own spreadsheet (synonyms),
 * - the error report (column order).
 *
 * All example values are FAKE (made-up names, +23320000xxxx / +23324000xxxx test numbers).
 */

export const IMPORT_TYPES = ['students_guardians', 'staff', 'opening_balances'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export type ColumnKind = 'text' | 'name' | 'date' | 'gender' | 'phone' | 'email' | 'yesno' | 'relationship' | 'class' | 'amount' | 'staff_type' | 'term';

export interface ColumnSpec {
  /** Stable key used in normalised rows. */
  key: string;
  /** Header text written in the template. */
  header: string;
  kind: ColumnKind;
  required: boolean;
  /** Plain-English help shown on the Instructions sheet. */
  help: string;
  /** Extra header spellings accepted when reading a file (compared after normaliseHeader). */
  synonyms?: string[];
  /** Fixed dropdown values (the template adds data validation). */
  options?: readonly string[];
  width?: number;
  /** Accepted when reading a school's own file but not written to the template (e.g. a single "Name" column). */
  readOnly?: boolean;
}

export interface TemplateSpec {
  type: ImportType;
  title: string;
  dataSheetName: string;
  columns: ColumnSpec[];
  examples: Array<Record<string, string | number>>;
  /** Paragraphs for the Instructions sheet (before the column table). */
  intro: string[];
}

export const GENDER_OPTIONS = ['Male', 'Female'] as const;
export const YES_NO_OPTIONS = ['Yes', 'No'] as const;
export const RELATIONSHIP_OPTIONS = ['Mother', 'Father', 'Grandparent', 'Aunt', 'Uncle', 'Sibling', 'Guardian', 'Other'] as const;
export const STAFF_TYPE_OPTIONS = ['Teaching', 'Non-teaching'] as const;
/** Seeded level codes (schema.md). The live template replaces this with the current year's real classes. */
export const DEFAULT_CLASS_OPTIONS = [
  'Creche', 'Nursery', 'KG1', 'KG2',
  'P1 A', 'P1 B', 'P2 A', 'P2 B', 'P3 A', 'P3 B', 'P4 A', 'P4 B', 'P5 A', 'P5 B', 'P6 A', 'P6 B',
  'JHS1 A', 'JHS1 B', 'JHS2 A', 'JHS2 B', 'JHS3 A', 'JHS3 B',
] as const;

/** Lower-case, letters and digits only: "Date of Birth" → "dateofbirth", "D.O.B" → "dob". */
export function normaliseHeader(h: string): string {
  return h
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // drop "(DD/MM/YYYY)" style hints
    .replace(/[*]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function guardianColumns(n: 1 | 2): ColumnSpec[] {
  const req = n === 1;
  const prefixes = n === 1 ? ['guardian1', 'guardian', 'parent1', 'parent', 'g1', 'parentguardian', 'parentguardian1', 'firstguardian'] : ['guardian2', 'parent2', 'g2', 'parentguardian2', 'secondguardian', 'otherguardian'];
  const syn = (...fields: string[]) => prefixes.flatMap((p) => fields.map((f) => p + f));
  const g = `Guardian ${n}`;
  return [
    { key: `g${n}FullName`, header: `${g} Name`, kind: 'name', required: false, readOnly: true, help: 'Only used when your file has one name column for the guardian.', synonyms: syn('name', 'fullname', 'names') },
    { key: `g${n}FirstName`, header: `${g} First Name`, kind: 'name', required: req, help: `First name of guardian ${n}.${n === 2 ? ' Leave all Guardian 2 columns empty if there is no second guardian.' : ''}`, synonyms: syn('firstname', 'forename', 'givenname', 'othernames') },
    { key: `g${n}LastName`, header: `${g} Last Name`, kind: 'name', required: req, help: `Surname of guardian ${n}.`, synonyms: syn('lastname', 'surname', 'familyname') },
    { key: `g${n}Relationship`, header: `${g} Relationship`, kind: 'relationship', required: req, help: 'How this person is related to the child (pick from the list).', options: RELATIONSHIP_OPTIONS, synonyms: syn('relationship', 'relation', 'relationshiptostudent', 'relationshiptochild') },
    { key: `g${n}Phone`, header: `${g} Phone`, kind: 'phone', required: req, help: 'Main mobile number, e.g. 024 400 0123 or +233244000123. Guardians with the same phone number are treated as the same person, so brothers and sisters are linked automatically.', synonyms: syn('phone', 'phonenumber', 'mobile', 'mobilenumber', 'contact', 'contactnumber', 'tel', 'telephone', 'phone1', 'primaryphone') },
    { key: `g${n}OtherPhone`, header: `${g} Other Phone`, kind: 'phone', required: false, help: 'A second number (optional).', synonyms: syn('otherphone', 'phone2', 'secondphone', 'alternativephone', 'altphone', 'secondaryphone') },
    { key: `g${n}Whatsapp`, header: `${g} WhatsApp`, kind: 'phone', required: false, help: 'WhatsApp number if different (optional).', synonyms: syn('whatsapp', 'whatsappnumber') },
    { key: `g${n}Email`, header: `${g} Email`, kind: 'email', required: false, help: 'Email address (optional).', synonyms: syn('email', 'emailaddress', 'mail') },
    { key: `g${n}Occupation`, header: `${g} Occupation`, kind: 'text', required: false, help: 'Job (optional).', synonyms: syn('occupation', 'job', 'profession', 'work') },
    { key: `g${n}FeePayer`, header: `${g} Pays Fees`, kind: 'yesno', required: false, help: 'Yes if this person pays school fees. If both are empty, Guardian 1 is marked as the fee payer.', options: YES_NO_OPTIONS, synonyms: syn('paysfees', 'feepayer', 'isfeepayer', 'payer') },
    { key: `g${n}CanPickUp`, header: `${g} Can Pick Up`, kind: 'yesno', required: false, help: 'Yes if this person may collect the child from school. Empty means Yes.', options: YES_NO_OPTIONS, synonyms: syn('canpickup', 'pickup', 'cancollect') },
  ];
}

export const STUDENTS_GUARDIANS_SPEC: TemplateSpec = {
  type: 'students_guardians',
  title: 'Students and guardians',
  dataSheetName: 'Students',
  intro: [
    'Use this sheet to bring your existing students and their parents or guardians into the system.',
    'Put ONE student on each row. A student can have up to two guardians on the same row.',
    'If two children share a parent, type the parent with the SAME phone number on both rows. The system will create the parent once and link the children as brothers and sisters.',
    'Columns marked with * must be filled in. Other columns can be left empty.',
    'Dates: type them as day/month/year, for example 12/03/2015 or 12 March 2015.',
    'Delete the three example rows (rows 2 to 4) before you upload, or the three made-up children will be imported too.',
    'You can also copy your own columns into this sheet. Common headings such as "DOB", "Surname" or "Parent Phone" are recognised.',
  ],
  columns: [
    { key: 'legacyId', header: 'Old Student ID', kind: 'text', required: false, help: 'The number from your old records (optional). Every student gets a new permanent ID; the old one is kept so you can match opening fee balances.', synonyms: ['legacyid', 'oldid', 'oldstudentid', 'studentid', 'admissionno', 'admissionnumber', 'admno', 'regno', 'registrationnumber', 'id', 'studentno', 'studentnumber'], width: 16 },
    { key: 'fullName', header: 'Full Name', kind: 'name', required: false, readOnly: true, help: 'Only used when your file has one name column instead of separate first and last names.', synonyms: ['name', 'fullname', 'studentname', 'pupilname', 'nameofstudent', 'nameofpupil', 'studentsname', 'pupilsname'] },
    { key: 'firstName', header: 'First Name', kind: 'name', required: true, help: "The child's first (given) name.", synonyms: ['firstname', 'forename', 'givenname', 'studentfirstname', 'pupilfirstname', 'fname'], width: 16 },
    { key: 'middleNames', header: 'Middle Names', kind: 'name', required: false, help: 'Any other names (optional).', synonyms: ['middlename', 'middlenames', 'othername', 'othernames', 'studentmiddlename'], width: 16 },
    { key: 'lastName', header: 'Last Name', kind: 'name', required: true, help: "The child's surname.", synonyms: ['lastname', 'surname', 'familyname', 'studentlastname', 'studentsurname', 'pupilsurname', 'lname'], width: 16 },
    { key: 'preferredName', header: 'Preferred Name', kind: 'name', required: false, help: 'The name the child is usually called (optional).', synonyms: ['preferredname', 'nickname', 'calledname', 'knownas'], width: 14 },
    { key: 'dateOfBirth', header: 'Date of Birth', kind: 'date', required: true, help: 'Day/month/year, e.g. 12/03/2015.', synonyms: ['dateofbirth', 'dob', 'birthdate', 'birthday', 'datebirth', 'dateofbirthddmmyyyy'], width: 14 },
    { key: 'gender', header: 'Gender', kind: 'gender', required: true, help: 'Male or Female (Boy/Girl, M/F are also understood).', options: GENDER_OPTIONS, synonyms: ['gender', 'sex', 'boygirl', 'mf'], width: 10 },
    { key: 'class', header: 'Class', kind: 'class', required: true, help: 'The class this year: level and stream, e.g. P3 A, JHS1 B or KG2. Pick from the list.', synonyms: ['class', 'currentclass', 'classname', 'form', 'grade', 'level', 'classstream', 'stage'], width: 12 },
    { key: 'admissionDate', header: 'Admission Date', kind: 'date', required: false, help: 'When the child first joined the school (optional). Empty means the start of this academic year.', synonyms: ['admissiondate', 'dateofadmission', 'datejoined', 'joined', 'enrolmentdate', 'enrollmentdate'], width: 14 },
    { key: 'nationality', header: 'Nationality', kind: 'text', required: false, help: 'Optional. Empty means Ghanaian.', synonyms: ['nationality', 'country'], width: 12 },
    { key: 'religion', header: 'Religion', kind: 'text', required: false, help: 'Optional.', synonyms: ['religion', 'faith', 'denomination'], width: 12 },
    { key: 'homeAddress', header: 'Home Address', kind: 'text', required: false, help: 'Optional. House number, area and town, or digital address.', synonyms: ['homeaddress', 'address', 'residentialaddress', 'residence', 'location', 'digitaladdress'], width: 24 },
    { key: 'previousSchool', header: 'Previous School', kind: 'text', required: false, help: 'Optional.', synonyms: ['previousschool', 'lastschool', 'formerschool', 'schoolattendedpreviously'], width: 18 },
    { key: 'medicalAlert', header: 'Medical Alert', kind: 'text', required: false, help: 'Optional. A SHORT note staff must see in an emergency, e.g. "Asthma, inhaler in school bag". Leave empty if none.', synonyms: ['medicalalert', 'medical', 'medicalcondition', 'medicalconditions', 'healthcondition', 'health', 'healthissues', 'allergiesconditions'], width: 26 },
    { key: 'allergies', header: 'Allergies', kind: 'text', required: false, help: 'Optional.', synonyms: ['allergies', 'allergy'], width: 16 },
    { key: 'bloodGroup', header: 'Blood Group', kind: 'text', required: false, help: 'Optional, e.g. O+.', synonyms: ['bloodgroup', 'bloodtype'], width: 10 },
    ...guardianColumns(1),
    ...guardianColumns(2),
  ],
  examples: [
    {
      legacyId: 'OLD-0101', firstName: 'Abena', middleNames: 'Serwaa', lastName: 'Owusu', preferredName: '', dateOfBirth: '14/02/2018', gender: 'Female', class: 'P2 A',
      admissionDate: '05/09/2023', nationality: 'Ghanaian', religion: 'Christian', homeAddress: 'Hse 12, Adenta Housing, Accra', previousSchool: '', medicalAlert: 'Asthma, inhaler in school bag', allergies: '', bloodGroup: 'O+',
      g1FirstName: 'Akosua', g1LastName: 'Owusu', g1Relationship: 'Mother', g1Phone: '0244000101', g1OtherPhone: '', g1Whatsapp: '', g1Email: 'akosua.owusu@example.com', g1Occupation: 'Trader', g1FeePayer: 'Yes', g1CanPickUp: 'Yes',
      g2FirstName: 'Kwabena', g2LastName: 'Owusu', g2Relationship: 'Father', g2Phone: '0200000102', g2OtherPhone: '', g2Whatsapp: '', g2Email: '', g2Occupation: 'Teacher', g2FeePayer: 'No', g2CanPickUp: 'Yes',
    },
    {
      legacyId: 'OLD-0102', firstName: 'Kofi', middleNames: '', lastName: 'Owusu', preferredName: 'Kofi Jnr', dateOfBirth: '03/07/2015', gender: 'Male', class: 'P5 B',
      admissionDate: '', nationality: '', religion: '', homeAddress: 'Hse 12, Adenta Housing, Accra', previousSchool: 'Sunrise Preparatory', medicalAlert: '', allergies: '', bloodGroup: '',
      g1FirstName: 'Akosua', g1LastName: 'Owusu', g1Relationship: 'Mother', g1Phone: '0244000101', g1OtherPhone: '', g1Whatsapp: '', g1Email: '', g1Occupation: '', g1FeePayer: 'Yes', g1CanPickUp: 'Yes',
      g2FirstName: '', g2LastName: '', g2Relationship: '', g2Phone: '', g2OtherPhone: '', g2Whatsapp: '', g2Email: '', g2Occupation: '', g2FeePayer: '', g2CanPickUp: '',
    },
    {
      legacyId: 'OLD-0230', firstName: 'Selorm', middleNames: 'Delali', lastName: 'Agbeko', preferredName: '', dateOfBirth: '21/11/2012', gender: 'Male', class: 'JHS1 A',
      admissionDate: '10/01/2020', nationality: 'Ghanaian', religion: 'Christian', homeAddress: 'Plot 7, Community 25, Tema', previousSchool: '', medicalAlert: 'Severe peanut allergy', allergies: 'Peanuts', bloodGroup: '',
      g1FirstName: 'Edem', g1LastName: 'Agbeko', g1Relationship: 'Father', g1Phone: '0244000230', g1OtherPhone: '0200000231', g1Whatsapp: '', g1Email: '', g1Occupation: 'Engineer', g1FeePayer: 'Yes', g1CanPickUp: 'Yes',
      g2FirstName: 'Mawuena', g2LastName: 'Dzifa', g2Relationship: 'Aunt', g2Phone: '0244000232', g2OtherPhone: '', g2Whatsapp: '', g2Email: '', g2Occupation: 'Nurse', g2FeePayer: 'No', g2CanPickUp: 'Yes',
    },
  ],
};

export const STAFF_SPEC: TemplateSpec = {
  type: 'staff',
  title: 'Staff',
  dataSheetName: 'Staff',
  intro: [
    'Use this sheet to bring your teaching and non-teaching staff into the system. One person per row.',
    'Columns marked with * must be filled in. Other columns can be left empty.',
    'Ghana Card and SSNIT numbers are NOT imported from a spreadsheet, to keep them safe. Add them on each staff record afterwards.',
    'This does not create user accounts. The administrator creates log-ins separately.',
    'Delete the three example rows (rows 2 to 4) before you upload.',
  ],
  columns: [
    { key: 'staffCode', header: 'Staff ID', kind: 'text', required: false, help: 'Your staff number (optional). Must not repeat.', synonyms: ['staffid', 'staffcode', 'staffno', 'staffnumber', 'employeeid', 'employeeno', 'id'], width: 12 },
    { key: 'firstName', header: 'First Name', kind: 'name', required: true, help: 'First name.', synonyms: ['firstname', 'forename', 'givenname', 'othernames'], width: 16 },
    { key: 'lastName', header: 'Last Name', kind: 'name', required: true, help: 'Surname.', synonyms: ['lastname', 'surname', 'familyname'], width: 16 },
    { key: 'gender', header: 'Gender', kind: 'gender', required: true, help: 'Male or Female.', options: GENDER_OPTIONS, synonyms: ['gender', 'sex'], width: 10 },
    { key: 'dateOfBirth', header: 'Date of Birth', kind: 'date', required: false, help: 'Day/month/year (optional).', synonyms: ['dateofbirth', 'dob', 'birthdate'], width: 14 },
    { key: 'phone', header: 'Phone', kind: 'phone', required: true, help: 'Mobile number, e.g. 024 400 0123.', synonyms: ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'contact', 'telephone', 'tel'], width: 16 },
    { key: 'email', header: 'Email', kind: 'email', required: false, help: 'Optional.', synonyms: ['email', 'emailaddress'], width: 24 },
    { key: 'address', header: 'Address', kind: 'text', required: false, help: 'Optional.', synonyms: ['address', 'homeaddress', 'residentialaddress'], width: 24 },
    { key: 'staffType', header: 'Staff Type', kind: 'staff_type', required: true, help: 'Teaching or Non-teaching.', options: STAFF_TYPE_OPTIONS, synonyms: ['stafftype', 'type', 'category', 'teachingnonteaching'], width: 14 },
    { key: 'jobTitle', header: 'Job Title', kind: 'text', required: false, help: 'e.g. Class Teacher, Accountant, Driver (optional).', synonyms: ['jobtitle', 'title', 'position', 'role', 'designation'], width: 18 },
    { key: 'employmentDate', header: 'Employment Date', kind: 'date', required: false, help: 'Date they started at the school (optional).', synonyms: ['employmentdate', 'datejoined', 'startdate', 'dateofemployment', 'dateofappointment'], width: 14 },
    { key: 'emergencyName', header: 'Emergency Contact Name', kind: 'name', required: false, help: 'Someone to call in an emergency (optional).', synonyms: ['emergencycontactname', 'emergencycontact', 'nextofkin', 'nextofkinname'], width: 20 },
    { key: 'emergencyRelationship', header: 'Emergency Contact Relationship', kind: 'text', required: false, help: 'e.g. Wife, Brother (optional).', synonyms: ['emergencycontactrelationship', 'nextofkinrelationship'], width: 16 },
    { key: 'emergencyPhone', header: 'Emergency Contact Phone', kind: 'phone', required: false, help: 'Optional.', synonyms: ['emergencycontactphone', 'emergencyphone', 'nextofkinphone'], width: 16 },
  ],
  examples: [
    { staffCode: 'ST-001', firstName: 'Yaa', lastName: 'Asantewaa', gender: 'Female', dateOfBirth: '02/05/1988', phone: '0244000501', email: 'yaa.asantewaa@example.com', address: 'Madina, Accra', staffType: 'Teaching', jobTitle: 'Class Teacher', employmentDate: '01/09/2015', emergencyName: 'Kojo Asante', emergencyRelationship: 'Husband', emergencyPhone: '0200000501' },
    { staffCode: 'ST-002', firstName: 'Ibrahim', lastName: 'Mahama', gender: 'Male', dateOfBirth: '17/10/1979', phone: '0200000502', email: '', address: 'Nima, Accra', staffType: 'Non-teaching', jobTitle: 'Driver', employmentDate: '15/01/2012', emergencyName: 'Amina Mahama', emergencyRelationship: 'Wife', emergencyPhone: '0244000503' },
    { staffCode: 'ST-003', firstName: 'Elikem', lastName: 'Kpodo', gender: 'Male', dateOfBirth: '', phone: '0244000504', email: '', address: '', staffType: 'Teaching', jobTitle: 'Mathematics Teacher', employmentDate: '', emergencyName: '', emergencyRelationship: '', emergencyPhone: '' },
  ],
};

export const OPENING_BALANCES_SPEC: TemplateSpec = {
  type: 'opening_balances',
  title: 'Opening fee balances',
  dataSheetName: 'Balances',
  intro: [
    'Use this sheet to bring in what each family owed (or had paid in advance) on the day you start using the system.',
    'Import students FIRST. Then identify each student by the new Student ID (e.g. KSV-26-00417-7) or by the Old Student ID you used in the student import.',
    'Amount in Ghana cedis. A positive amount means the family OWES the school. Put a minus sign for money paid in advance (credit), e.g. -150.00.',
    'Each student may appear only once. Only the administrator can commit this import; it creates "opening balance" entries in each student\'s fee account.',
    'Delete the three example rows (rows 2 to 4) before you upload.',
  ],
  columns: [
    { key: 'studentCode', header: 'Student ID', kind: 'text', required: false, help: 'New permanent Student ID. Fill this OR Old Student ID.', synonyms: ['studentid', 'studentcode', 'newstudentid', 'code'], width: 18 },
    { key: 'legacyId', header: 'Old Student ID', kind: 'text', required: false, help: 'The old ID used in the student import. Fill this OR Student ID.', synonyms: ['oldstudentid', 'legacyid', 'oldid', 'admissionno', 'admissionnumber', 'admno'], width: 16 },
    { key: 'studentName', header: 'Student Name', kind: 'text', required: false, help: 'Optional, only used to double-check you have the right child.', synonyms: ['studentname', 'name', 'fullname', 'pupilname'], width: 24 },
    { key: 'amount', header: 'Amount (GH₵)', kind: 'amount', required: true, help: 'e.g. 1,250.00 owed, or -150.00 for credit.', synonyms: ['amount', 'balance', 'amountowed', 'arrears', 'outstanding', 'openingbalance', 'balanceghs', 'amountghs', 'amountgh'], width: 14 },
    { key: 'asOfTerm', header: 'As of Term', kind: 'term', required: true, help: 'The term the balance belongs to, e.g. "2026/2027 Term 1" (pick from the list).', synonyms: ['asofterm', 'term', 'asat', 'asof', 'period'], width: 18 },
    { key: 'note', header: 'Note', kind: 'text', required: false, help: 'Optional note, e.g. "Arrears from 2025/2026".', synonyms: ['note', 'notes', 'comment', 'comments', 'remark', 'remarks', 'description'], width: 28 },
  ],
  examples: [
    { studentCode: '', legacyId: 'OLD-0101', studentName: 'Abena Owusu', amount: '1,250.00', asOfTerm: '2026/2027 Term 1', note: 'Arrears from 2025/2026' },
    { studentCode: 'KSV-26-00002-9', legacyId: '', studentName: 'Kofi Owusu', amount: '-150.00', asOfTerm: '2026/2027 Term 1', note: 'Paid in advance' },
    { studentCode: '', legacyId: 'OLD-0230', studentName: 'Selorm Agbeko', amount: '480.5', asOfTerm: '2026/2027 Term 1', note: '' },
  ],
};

export const TEMPLATE_SPECS: Record<ImportType, TemplateSpec> = {
  students_guardians: STUDENTS_GUARDIANS_SPEC,
  staff: STAFF_SPEC,
  opening_balances: OPENING_BALANCES_SPEC,
};

/** Columns written to the template (read-only synonym columns excluded). */
export function templateColumns(type: ImportType): ColumnSpec[] {
  return TEMPLATE_SPECS[type].columns.filter((c) => !c.readOnly);
}

/** Normalised header → column key, built once per type from header text, key and synonyms. */
export function headerLookup(type: ImportType): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of TEMPLATE_SPECS[type].columns) {
    for (const h of [c.header, c.key, ...(c.synonyms ?? [])]) {
      const n = normaliseHeader(h);
      if (n && !map.has(n)) map.set(n, c.key);
    }
  }
  return map;
}
