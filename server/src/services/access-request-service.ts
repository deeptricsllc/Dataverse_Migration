import { desc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AccessRequestDto } from '../../../shared/domain';
import type { AppDb } from '../db/client';
import { accessRequests, users } from '../db/schema';
import { forbidden, notFound } from '../lib/errors';
import type { RequestContext } from './context';

/**
 * The public sign-up path.
 *
 * There is no local password account in this product: a workspace is created the first time someone
 * from a Microsoft tenant signs in. That leaves two kinds of visitor unserved — somebody whose
 * tenant is not allow-listed, and somebody evaluating the platform before involving their IT team.
 * This is what "Sign up" means for them: tell us who you are, and a human answers.
 *
 * It is the only endpoint in the product that an unauthenticated stranger may write to, so it is
 * written defensively: every field is length-bounded, one row per address, and nothing it stores is
 * ever rendered as anything but text.
 */

const trimmed = (max: number) => z.string().trim().max(max);

export const accessRequestSchema = z.object({
  name: trimmed(120).min(1, 'Please tell us your name'),
  // Not a full RFC 5322 validator: this decides whether we can reply, and `.email()` plus a length
  // bound is the honest limit of what a form can know.
  email: trimmed(200).email('That does not look like an email address'),
  company: trimmed(160).optional(),
  useCase: trimmed(2000).optional(),
  /**
   * Honeypot. The field is hidden from people and ignored by them; a bot fills every input it finds.
   * A filled one is accepted with a normal response and stored nowhere, because telling a script it
   * was detected is how it learns to stop tripping the trap.
   */
  website: trimmed(200).optional(),
});

/** An address that could not be replied to anyway, and is the standard smoke-test payload. */
const isUnreachable = (email: string) => email.endsWith('@example.com') || email.endsWith('@test.com');

export class AccessRequestService {
  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
  ) {}

  /**
   * Records an ask. Unauthenticated by design.
   *
   * Returns nothing about what is stored — not whether this address had asked before, not a row id.
   * A public endpoint that answers "we already know that address" is an account-enumeration oracle.
   */
  async submit(input: z.infer<typeof accessRequestSchema>, requestId: string): Promise<void> {
    if (input.website) {
      this.logger.info({ requestId }, 'Access request rejected by honeypot');
      return;
    }
    const email = input.email.toLowerCase();
    if (isUnreachable(email)) {
      this.logger.info({ requestId }, 'Access request discarded: unreachable address');
      return;
    }
    await this.db
      .insert(accessRequests)
      .values({
        email,
        name: input.name,
        company: input.company || null,
        useCase: input.useCase || null,
      })
      .onConflictDoUpdate({
        target: accessRequests.email,
        set: {
          name: input.name,
          company: input.company || null,
          useCase: input.useCase || null,
          submissions: sql`${accessRequests.submissions} + 1`,
          updatedAt: new Date(),
          // Asking again after we closed it out reopens it. Otherwise a second ask disappears.
          handledAt: null,
          handledByUserId: null,
        },
      });
    this.logger.info({ requestId, company: input.company ?? null }, 'Access request received');
  }

  /**
   * Who may read these.
   *
   * Not "an administrator": an administrator of a customer organization would then be reading the
   * names and email addresses of everyone else who asked for access, which is other people's data in
   * someone else's product. A platform operator is a specific person named in ADMIN_EMAILS.
   */
  private requireOperator(ctx: RequestContext): void {
    if (ctx.platformOperator) return;
    throw forbidden(
      'Inbound access requests are visible to the operators of this deployment only. They are not part of your organization data.',
    );
  }

  async list(ctx: RequestContext): Promise<AccessRequestDto[]> {
    this.requireOperator(ctx);
    const rows = await this.db
      .select({ r: accessRequests, handledBy: users.displayName })
      .from(accessRequests)
      .leftJoin(users, eq(users.id, accessRequests.handledByUserId))
      .orderBy(desc(accessRequests.updatedAt))
      .limit(500);
    return rows.map(({ r, handledBy }) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      company: r.company,
      useCase: r.useCase,
      submissions: r.submissions,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      handledAt: r.handledAt?.toISOString() ?? null,
      handledBy: r.handledAt ? (handledBy ?? 'Someone who has since been removed') : null,
    }));
  }

  async setHandled(ctx: RequestContext, id: string, handled: boolean): Promise<void> {
    this.requireOperator(ctx);
    const [row] = await this.db
      .update(accessRequests)
      .set({
        handledAt: handled ? new Date() : null,
        handledByUserId: handled ? ctx.userId : null,
      })
      .where(eq(accessRequests.id, id))
      .returning({ id: accessRequests.id });
    if (!row) throw notFound('Access request');
  }
}
