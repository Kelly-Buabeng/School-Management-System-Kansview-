# Bringing your old records into the system

This guide is for the school administrator. It explains how to move your existing students, parents, staff and
fee balances from Excel (or from another program that can save Excel or CSV files) into the system.

You do this **once**, when you start using the system. It takes about one afternoon for a school of 1,000 children,
most of it spent tidying the old spreadsheet.

## The three templates

| File | What it is for | Who can do it |
|---|---|---|
| `students-guardians-import-template.xlsx` | Students and up to two parents or guardians each | Registrar or administrator |
| `staff-import-template.xlsx` | Teaching and non-teaching staff | Administrator |
| `opening-balances-import-template.xlsx` | What each family owed (or had paid ahead) on your start date | Bursar prepares it, administrator commits it |

You can download the same templates inside the system (**Imports → Download template**). The copy from the system
already lists **your** classes and terms in the drop-down lists, so use that one if you can.

Every template has an **Instructions** sheet. Read it first. It explains each column in plain words.

## Do things in this order

1. Set up the current academic year, its terms and its classes (with a capacity for each class) in **Settings / Classes**.
2. Import **students and guardians**.
3. Import **staff** (any time).
4. Import **opening balances** last, because they are matched to students that are already in the system.

## Step 1: Prepare the old records

1. Open the template. Delete the three example rows (they are made-up children shown in grey).
2. Copy your old list into the template, one child per row. You can also keep your own spreadsheet: the system
   understands common headings such as "Surname", "DOB", "D.O.B", "Sex", "Parent Phone" and "Admission No".
3. Check these things, because they cause most problems:
   - **Dates** are written day/month/year, for example `12/03/2015` or `12 March 2015`.
   - **Class** is the level and stream, for example `P3 A`, `JHS1 B` or `KG2`. It must match a class you set up.
   - **Phone numbers** are Ghana numbers such as `024 400 0123`. If Excel removed the first 0, that is fine.
   - **Brothers and sisters**: type the parent with the **same phone number** on each child's row. The system then
     creates that parent once and links the children together. Two different parents must never share one number.
   - Put the **Old Student ID** (your old admission number) on every child if you have one. It is needed later to
     match opening fee balances, and it stops the same child being imported twice.
4. Save the file as Excel (`.xlsx`). CSV also works. Old `.xls` files must be saved again as `.xlsx`.

A file can have up to 2,000 rows. If your school is bigger, split it (for example one file per level).

## Step 2: Upload and do a dry run ("Check file")

1. Go to **Imports → New import**, choose the kind of import and upload the file.
2. Click **Check file**. This is a dry run: **nothing is saved to the school records yet.**
3. You will see how many rows are:
   - **Valid**: ready to import.
   - **Warning**: will be imported, but please read the note (for example "Age 13 is unusual for P2", or
     "This parent is already in the system; the child will be linked to them").
   - **Error**: will **not** be imported until it is fixed (for example a date that does not exist, a missing phone
     number, a class that does not exist, or a class that would be over its capacity).
   - **Possible duplicate**: this child (or staff member) seems to be in the system already.

## Step 3: Fix problems

- Click **Download error report**. It is your own rows with an **Errors** column added on the right.
- Fix the rows in the error report (or in your original file).
- Upload the corrected rows as a **new import** and check it again. Rows that were already imported will show up
  as possible duplicates, so you will not import anyone twice by mistake.
- If a class is too small, raise its capacity under **Classes** and click **Check file** again on the same import.

For each **possible duplicate**, choose one of:

- **Link to existing**: it is the same child; nothing new is created (the old ID is remembered for balances).
- **Create new**: it is a different child who happens to look similar.
- **Skip**: leave this row out.

You can also skip any other row you do not want. **Include** undoes a skip.

## Step 4: Commit

Only the administrator can commit. Click **Commit**. The system saves the rows in small groups of 200.

- If the power or the network goes off during a commit, just click **Commit** again when it is back. It continues
  where it stopped. Nobody is imported twice.
- If some rows could not be saved, the import shows **failed** with a short explanation. Download the error report,
  fix the cause and click **Commit** again; only the rows that are still missing are tried again.
- Every commit is recorded in the audit log.

After the commit, open a few children to check their class, parents and medical alert, and check that brothers and
sisters appear together on the parent's page.

## Opening fee balances

1. The bursar fills in the opening balances template: the **Student ID** (new) or the **Old Student ID** used in the
   student import, the **amount in cedis**, and the **term** (for example `2026/2027 Term 1`).
2. A positive amount means the family **owes** the school. A minus sign (or brackets) means money **paid in advance**.
3. The bursar uploads it and clicks **Check file**. The system shows each child's name next to the amount so you can
   compare it with your old books.
4. The administrator commits it. Each balance becomes an "opening balance" line in the child's fee account.
5. A child can have only one opening balance. To correct it later, the bursar records an adjustment in Finance.

## Staff

Fill in the staff template and import it the same way. Ghana Card and SSNIT numbers are **not** imported from a
spreadsheet (to keep them safe); add them on each staff record afterwards. Importing staff does not create log-ins.

## Good practice

- Keep a copy of the old spreadsheet somewhere safe (not on a shared computer), then delete extra copies once the
  import is checked. They contain children's personal and medical details.
- Do the import on a quiet day, not during admissions or fee collection.
