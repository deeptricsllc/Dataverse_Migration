export interface RequestContext {
  userId: string;
  organizationId: string;
  role: 'ADMIN' | 'MEMBER';
  isDemoOrg: boolean;
  displayName: string;
  requestId: string;
}
