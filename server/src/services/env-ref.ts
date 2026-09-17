import { classifyEnvironment, type EnvRef } from '../../../shared/domain';

/** The environment reference every DTO carries, including its safety classification. */
export const envRef = (e: {
  id: string;
  displayName: string;
  url: string;
  environmentType: string | null;
}): EnvRef => ({
  id: e.id,
  displayName: e.displayName,
  url: e.url,
  environmentClass: classifyEnvironment(e.environmentType),
});
