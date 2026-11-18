// Name and place lists for the FAKE seed data. Combinations are random; no record describes a real person.

// Akan day names (Twi / Fante variants) by gender
export const AKAN_DAY = {
  male: ['Kwasi', 'Kwadwo', 'Kwabena', 'Kwaku', 'Yaw', 'Kofi', 'Kwame', 'Akwasi', 'Kojo'],
  female: ['Akosua', 'Adwoa', 'Abenaa', 'Akua', 'Yaa', 'Afua', 'Ama', 'Afia', 'Adjoa'],
};
export const FANTE_DAY = {
  male: ['Kwesi', 'Kweku', 'Ekow', 'Kobina', 'Kwamena', 'Kojo', 'Fiifi', 'Ato', 'Paa Kwesi'],
  female: ['Esi', 'Efua', 'Ekua', 'Araba', 'Aba', 'Adwoa', 'Ewurabena', 'Ewuraesi', 'Kukua'],
};
export const EWE = {
  male: ['Kodzo', 'Kwami', 'Komla', 'Yao', 'Koku', 'Kofi', 'Elikem', 'Mawuli', 'Edem', 'Selorm', 'Senyo', 'Delali', 'Etornam'],
  female: ['Adzo', 'Abla', 'Afi', 'Yawa', 'Esinam', 'Dzifa', 'Enyonam', 'Akpene', 'Sena', 'Elinam', 'Xorlali', 'Mawunyo'],
};
export const GA = {
  male: ['Nii Ayi', 'Nii Armah', 'Ayitey', 'Tettey', 'Kpakpo', 'Odartey', 'Nii Okai', 'Lartey', 'Nii Kwei', 'Ashitey'],
  female: ['Naa Ayeley', 'Naa Adjeley', 'Ayele', 'Adoley', 'Odarley', 'Lamiley', 'Okailey', 'Naa Dedei', 'Korkor', 'Dzama'],
};
export const DAGBANI = {
  male: ['Mahama', 'Iddrisu', 'Abukari', 'Alhassan', 'Fuseini', 'Sulemana', 'Wumbei', 'Mohammed', 'Shaibu', 'Yakubu'],
  female: ['Amina', 'Mariama', 'Fati', 'Rashida', 'Hawa', 'Lamisi', 'Sanatu', 'Ayishetu', 'Memunatu', 'Wumpini'],
};
export const HAUSA = {
  male: ['Musa', 'Ibrahim', 'Yusif', 'Abubakar', 'Haruna', 'Usman', 'Sadiq', 'Bashiru', 'Aminu', 'Nuhu'],
  female: ['Aisha', 'Zainab', 'Hadiza', 'Safiya', 'Hauwa', 'Halima', 'Rukaya', 'Jamila', 'Maryam', 'Nafisa'],
};
// Common English/Christian or Arabic given names used as first or middle names
export const CHRISTIAN = {
  male: ['Emmanuel', 'Daniel', 'Samuel', 'Joseph', 'Michael', 'Prince', 'Bright', 'Eric', 'Richard', 'Isaac', 'Godfred', 'Nana', 'Benjamin', 'David', 'Ebenezer', 'Felix', 'Jeffrey', 'Kelvin', 'Nathaniel', 'Solomon'],
  female: ['Grace', 'Elizabeth', 'Priscilla', 'Gifty', 'Abigail', 'Deborah', 'Princess', 'Eunice', 'Mercy', 'Comfort', 'Patience', 'Josephine', 'Linda', 'Vida', 'Rita', 'Charity', 'Nana Ama', 'Esther', 'Lydia', 'Hannah'],
};
export const MUSLIM = {
  male: ['Abdul-Rahman', 'Ismail', 'Rashid', 'Faisal', 'Kamal', 'Nasir', 'Zakaria', 'Umar'],
  female: ['Fatima', 'Khadija', 'Sakina', 'Rahinatu', 'Salma', 'Sumaya', 'Asana', 'Barikisu'],
};

export const SURNAMES = {
  akan: ['Mensah', 'Owusu', 'Agyeman', 'Boateng', 'Asante', 'Osei', 'Appiah', 'Amoah', 'Darko', 'Ofori', 'Antwi', 'Frimpong', 'Gyamfi', 'Sarpong', 'Opoku', 'Bonsu', 'Acheampong', 'Asamoah', 'Kyei', 'Nkansah', 'Adjei', 'Agyei', 'Oppong', 'Danso'],
  fante: ['Aidoo', 'Quansah', 'Eshun', 'Arthur', 'Essel', 'Ansah', 'Baidoo', 'Bentsi', 'Mensah', 'Hayford', 'Sam', 'Annan', 'Ackah', 'Amissah'],
  ewe: ['Dogbe', 'Amegah', 'Agbeko', 'Kpodo', 'Tsikata', 'Adzaho', 'Ahiable', 'Dzokoto', 'Fiagbe', 'Klutse', 'Agbenyega', 'Kudjoe', 'Amedzro', 'Gadzekpo', 'Mensah'],
  ga: ['Tetteh', 'Quaye', 'Addo', 'Lamptey', 'Quartey', 'Nortey', 'Ankrah', 'Odoi', 'Armah', 'Laryea', 'Sowah', 'Aryee', 'Okine', 'Tagoe', 'Allotey'],
  dagbani: ['Abdulai', 'Iddrisu', 'Alhassan', 'Mahama', 'Seidu', 'Yakubu', 'Fuseini', 'Issahaku', 'Mohammed', 'Sulemana', 'Wumbei'],
  hausa: ['Musa', 'Abubakar', 'Ibrahim', 'Bello', 'Sani', 'Garba', 'Usman', 'Yusuf', 'Haruna', 'Adamu'],
};

// Ethnic mix of families (weights)
export const ETHNIC_WEIGHTS = [
  ['akan', 34], ['fante', 12], ['ewe', 18], ['ga', 20], ['dagbani', 9], ['hausa', 7],
];

export const LANGUAGES = {
  akan: ['English', 'Twi'], fante: ['English', 'Fante'], ewe: ['English', 'Ewe'],
  ga: ['English', 'Ga'], dagbani: ['English', 'Dagbani'], hausa: ['English', 'Hausa'],
};

export const PLACES = [
  ['Dzorwulu', 'Accra'], ['Abelemkpe', 'Accra'], ['East Legon', 'Accra'], ['Achimota', 'Accra'], ['Dansoman', 'Accra'],
  ['Kaneshie', 'Accra'], ['Madina', 'Accra'], ['Adenta', 'Accra'], ['Spintex Road', 'Accra'], ['Teshie', 'Accra'],
  ['Osu', 'Accra'], ['Haatso', 'Accra'], ['Dome', 'Accra'], ['Lapaz', 'Accra'], ['Kasoa', 'Central Region'],
  ['Community 4', 'Tema'], ['Community 11', 'Tema'], ['Community 25', 'Tema'], ['Sakumono', 'Tema'], ['Tema New Town', 'Tema'],
  ['Ahodwo', 'Kumasi'], ['Bantama', 'Kumasi'], ['Asokwa', 'Kumasi'], ['Nhyiaeso', 'Kumasi'],
];
export const STREETS = ['Mango Street', 'Palm Avenue', 'Lane 3', 'Cedar Close', 'Oak Road', 'Baobab Lane', 'Liberation Link', 'Independence Avenue', 'Akosombo Road', 'Neem Tree Close', 'Coconut Grove', 'Odum Street'];

export const OCCUPATIONS = ['Trader', 'Teacher', 'Nurse', 'Accountant', 'Engineer', 'Civil servant', 'Driver', 'Banker', 'Pharmacist', 'Seamstress', 'Caterer', 'Mechanic', 'Electrician', 'Lawyer', 'Doctor', 'Businessman', 'Businesswoman', 'IT officer', 'Police officer', 'Hairdresser', 'Farmer', 'Carpenter'];
export const WORKPLACES = ['Makola Market', 'Ministry of Health', 'Korle Bu Teaching Hospital', 'Tema Harbour', 'Kotoka Airport', 'Ridge Hospital', 'GES District Office', 'Accra Mall', 'Kejetia Market', 'Self-employed', 'Tema Oil Refinery', 'A private bank'];

export const PREVIOUS_SCHOOLS = ['Bright Stars Academy', 'Little Lambs Montessori', 'Rising Sun Basic School', 'Golden Gate Preparatory', 'Hope Christian School', 'Royal Kids International', 'Unity Basic School'];

export const MEDICAL_ALERTS = [
  'Severe peanut allergy, carries EpiPen',
  'Asthma, inhaler kept in school bag',
  'Sickle cell (SS): keep hydrated, call parent if in pain',
  'Epilepsy: see seizure care plan',
  'Allergic to penicillin',
  'Type 1 diabetes: insulin before lunch',
  'Severe egg allergy',
  'Hearing aid (left ear), sit near the front',
];
export const MINOR_MEDICAL = ['Mild dust allergy', 'Wears glasses', 'Occasional nosebleeds', 'Lactose intolerant'];

export const SUBJECTS = [
  ['ENG', 'English Language'], ['MATH', 'Mathematics'], ['SCI', 'Science'], ['OWOP', 'Our World Our People'],
  ['SOC', 'Social Studies'], ['RME', 'Religious and Moral Education'], ['GHL', 'Ghanaian Language'],
  ['CAD', 'Creative Arts and Design'], ['COMP', 'Computing'], ['FRE', 'French'], ['CTECH', 'Career Technology'],
  ['PE', 'Physical and Health Education'], ['LIT', 'Literacy'], ['NUM', 'Numeracy'],
];
