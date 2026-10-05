import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { EnvRef, ProjectDto } from '@shared/domain';
import { get } from './api';

/**
 * The two ends of a migration, read from the migration that has them.
 *
 * ## What this replaces
 *
 * A per-user, application-wide "current source and current target", stored in `user_preferences` and read
 * by every screen that needed two environments. It is why Connections offered "Set as source", why a
 * `SOURCE → TARGET` strip hung above Audit and Connections and everything else, and why starting a
 * migration meant going to Connections first and choosing two things before the product would let you do
 * anything.
 *
 * It also made a whole class of question unanswerable. Two migrations at once meant two global states, so
 * there could only be one. Opening a screen told you nothing about which migration you were looking at.
 *
 * ## The rule
 *
 * A migration's source and target belong to **that migration**. They travel in the URL as `projectId` and
 * are read from the project. A screen with no project has no sides, and says so rather than quietly
 * operating on whatever was selected last.
 */
export interface MigrationContext {
  projectId: string | null;
  project: ProjectDto | null;
  source: EnvRef | null;
  target: EnvRef | null;
  /** Both ends known, so the screen can do its work. */
  ready: boolean;
  isLoading: boolean;
}

export function useMigrationContext(): MigrationContext {
  const [params] = useSearchParams();
  const projectId = params.get('projectId');
  const query = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => get<ProjectDto>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
  const project = query.data ?? null;
  const source = project?.sourceEnvironment ?? null;
  const target = project?.targetEnvironment ?? null;
  return {
    projectId,
    project,
    source,
    target,
    ready: Boolean(source && target),
    isLoading: Boolean(projectId) && query.isLoading,
  };
}
