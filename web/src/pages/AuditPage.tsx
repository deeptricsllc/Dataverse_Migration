import { AuditTrailCard, useAuditTrail } from '../components/AuditTrail';
import { PageHeader } from '../components/ui';

/**
 * The audit trail, as a destination.
 *
 * It lived inside Settings, which is where a feature goes when nobody has decided what it is. An audit
 * trail is not a setting — it is the record somebody consults when they are asked what happened, and a
 * reader told "the platform keeps an audit trail" looks for it in the navigation.
 *
 * This is step one of the information-architecture recommendation: Audit and Team become destinations and
 * nothing else moves. Settings keeps a pointer rather than a second copy, so there is one audit view.
 */
export function AuditPage() {
  const { filters, setFilters, page } = useAuditTrail();
  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every recorded action in this workspace: the actor, the time, the environment and the outcome."
      />
      <AuditTrailCard
        page={page.data}
        loading={page.isLoading}
        fetching={page.isFetching}
        error={page.error}
        filters={filters}
        onFilters={setFilters}
      />
    </>
  );
}
