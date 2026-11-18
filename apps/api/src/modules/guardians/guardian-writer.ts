// Owner: Agent B. Creates guardians and student links. Shared by admission, the guardians API and the import target.
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { ErrorCodes } from '@sms/shared';
import { AppError } from '../../common/app-error';
import type { Tx } from '../../common/db/database.module';
import { FIELD_CRYPTO, type FieldCrypto } from '../../security/field-crypto';
import { ghanaCardLast4 } from '../settings/common/http';
import type { GuardianInput } from './guardians.dto';

export interface LinkValues {
  relationship: string;
  isPrimary: boolean;
  isFeePayer: boolean;
  canPickUp: boolean;
  receivesSms: boolean;
  livesWithStudent: boolean;
}

@Injectable()
export class GuardianWriter {
  constructor(@Inject(FIELD_CRYPTO) private readonly crypto: FieldCrypto) {}

  /** Encrypted Ghana Card columns (write-only in the API). null clears them. */
  ghanaCardColumns(card: string | null | undefined) {
    if (card === undefined) return {};
    if (card === null) return { ghana_card_enc: null, ghana_card_bidx: null, ghana_card_last4: null };
    return { ghana_card_enc: this.crypto.encrypt(card), ghana_card_bidx: this.crypto.blindIndex(card), ghana_card_last4: ghanaCardLast4(card) };
  }

  async create(tx: Tx, g: GuardianInput, actorId: string): Promise<string> {
    const r = await tx.insertInto('guardians').values({
      title: g.title ?? null, first_name: g.firstName, last_name: g.lastName, phone_primary: g.phonePrimary,
      phone_secondary: g.phoneSecondary ?? null, whatsapp_number: g.whatsappNumber ?? null, email: g.email ?? null,
      occupation: g.occupation ?? null, workplace: g.workplace ?? null, home_address: g.homeAddress ?? null, work_address: g.workAddress ?? null,
      ...this.ghanaCardColumns(g.ghanaCardNumber), created_by: actorId, updated_by: actorId,
    }).returning('id').executeTakeFirstOrThrow();
    return r.id;
  }

  async assertExists(tx: Tx, guardianId: string): Promise<{ id: string; phone_primary: string }> {
    const g = await tx.selectFrom('guardians').select(['id', 'phone_primary']).where('id', '=', guardianId).where('archived_at', 'is', null).executeTakeFirst();
    if (!g) throw new AppError(404, ErrorCodes.NOT_FOUND, 'This guardian was not found');
    return g;
  }

  /** Inserts or updates a link. Making a guardian primary removes primary from the student's other guardians. */
  async link(tx: Tx, studentId: string, guardianId: string, v: LinkValues, actorId: string): Promise<void> {
    if (v.isPrimary) {
      await tx.updateTable('student_guardians').set({ is_primary: false, updated_by: actorId })
        .where('student_id', '=', studentId).where('guardian_id', '<>', guardianId).where('is_primary', '=', true).execute();
    }
    const values = {
      relationship: v.relationship as never, is_primary: v.isPrimary, is_fee_payer: v.isFeePayer, can_pick_up: v.canPickUp,
      receives_sms: v.receivesSms, lives_with_student: v.livesWithStudent, updated_by: actorId,
    };
    await tx.insertInto('student_guardians').values({ student_id: studentId, guardian_id: guardianId, ...values, created_by: actorId })
      .onConflict((oc) => oc.columns(['student_id', 'guardian_id']).doUpdateSet({ ...values, updated_at: sql`now()` }))
      .execute();
  }
}
