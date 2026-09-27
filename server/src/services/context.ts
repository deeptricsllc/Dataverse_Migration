export interface RequestContext {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'MEMBER';
  isDemoOrg: boolean;
  displayName: string;
  requestId: string;
  /**
   * Operates the deployment itself (ADMIN_EMAILS), as opposed to administering one organization
   * inside it. Separate from `role` on purpose: a customer administrator is not an operator.
   */
  platformOperator: boolean;
}
