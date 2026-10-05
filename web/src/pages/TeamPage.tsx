import { ROLE_LABELS, WORKSPACE_ROLES, type WorkspaceRole } from '@shared/authorization';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Callout,
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  Spinner,
  Table,
  Td,
  Th,
} from '../components/ui';
import { get, patch } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';

interface TeamMember {
  id: string;
  displayName: string;
  email: string | null;
  role: WorkspaceRole;
  lastLoginAt: string | null;
  authProvider: string;
  isYou: boolean;
  isLastAdmin: boolean;
}

/**
 * Who is in this workspace, and what each of them may do.
 *
 * This page exists because the roles did not have anywhere to be assigned. Four workspace roles were
 * defined and enforced on every request, and nothing in the product could set one: the first member became
 * an administrator by being first, everybody after them a migration operator, and `VALIDATOR` and
 * `READ_ONLY` could not be reached at all. A permission model nobody can configure is two hard-coded roles
 * with extra names.
 *
 * Readable by anybody in the workspace, deliberately — knowing who else can see your data is not
 * privileged information, and a member who cannot tell whom to ask for access has a dead end. Changing a
 * role is an administrator's, and the two controls that are **fixed** rather than merely disabled are the
 * ones this product cannot undo: nobody changes their own role, and the last administrator stays.
 */
export function TeamPage() {
  const { user } = useSession();
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ['team'], queryFn: () => get<TeamMember[]>('/api/team') });
  const setRole = useMutation({
    mutationFn: (input: { id: string; role: WorkspaceRole }) =>
      patch(`/api/team/${input.id}`, { role: input.role }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['team'] }),
  });

  const isAdmin = user.role === 'ADMIN';

  return (
    <>
      <PageHeader
        title="Team"
        description="Everybody in this workspace and what each of them may do. Only an administrator can change a role."
      />

      {setRole.error && (
        <Callout tone="danger" title="That role was not changed">
          {setRole.error instanceof Error ? setRole.error.message : 'The role change failed.'}
        </Callout>
      )}

      <Card className="mt-4">
        {team.isLoading && (
          <div className="p-8">
            <Spinner />
          </div>
        )}
        {team.error && <ErrorState error={team.error} onRetry={() => team.refetch()} />}
        {team.data && team.data.length === 0 && (
          <EmptyState title="Nobody else is here yet" description="People appear once they sign in." />
        )}
        {team.data && team.data.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>What that allows</Th>
                <Th>Last signed in</Th>
              </tr>
            </thead>
            <tbody>
              {team.data.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <div className="font-medium text-slate-900">
                      {m.displayName}
                      {m.isYou && <span className="ml-2 text-xs font-normal text-slate-500">(you)</span>}
                    </div>
                    {m.email && <div className="text-xs text-slate-500">{m.email}</div>}
                  </Td>
                  <Td>
                    {/*
                      Fixed rather than merely disabled in two cases, and the title says which: an
                      administrator who demotes themselves, or the last one who is demoted, has locked the
                      workspace — and this product has no support tool to unlock it.
                    */}
                    {isAdmin && !m.isYou && !m.isLastAdmin ? (
                      <select
                        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm"
                        value={m.role}
                        disabled={setRole.isPending}
                        onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as WorkspaceRole })}
                      >
                        {WORKSPACE_ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role].label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span
                        title={
                          m.isYou
                            ? 'You cannot change your own role. Ask another administrator, so a workspace cannot be locked by one person.'
                            : m.isLastAdmin
                              ? 'The only administrator in the workspace. Make somebody else an administrator first.'
                              : 'Only an administrator can change a role.'
                        }
                      >
                        <Pill tone={m.role === 'ADMIN' ? 'amber' : 'slate'}>{ROLE_LABELS[m.role].label}</Pill>
                      </span>
                    )}
                  </Td>
                  <Td className="max-w-md text-sm text-slate-600">{ROLE_LABELS[m.role].summary}</Td>
                  <Td className="text-sm text-slate-500">
                    {m.lastLoginAt ? fmtDate(m.lastLoginAt) : 'Never'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {!isAdmin && (
        <p className="mt-3 text-sm text-slate-500">
          You are signed in as {ROLE_LABELS[user.role as WorkspaceRole]?.label ?? user.role}. An administrator
          can change what you may do.
        </p>
      )}
    </>
  );
}
