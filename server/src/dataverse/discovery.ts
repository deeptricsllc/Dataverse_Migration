import type { Logger } from 'pino';
import { organizationTypeName } from './normalize';
import { classifyHttpError, toDataverseError } from './errors';
import { withRetry } from './retry';
import type { DiscoveredEnvironment } from './types';

export interface EnvironmentDiscoveryProvider {
  discover(): Promise<DiscoveredEnvironment[]>;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const normalizeEnvironmentUrl = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

async function getJson(fetchImpl: typeof fetch, url: string, token: string, logger: Logger): Promise<Raw> {
  return withRetry(
    async () => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        throw toDataverseError(err);
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw classifyHttpError(res.status, data, res.headers.get('Retry-After'));
      return data;
    },
    { logger, context: { operation: 'environment-discovery' } },
  );
}

/**
 * Discovers Dataverse environments the signed-in user can access via the Dataverse Global
 * Discovery Service (delegated). Optionally enriches environment type/region using the
 * Power Platform admin (BAP) API when POWER_PLATFORM_ENRICHMENT is enabled and consented.
 */
export class GlobalDiscoveryProvider implements EnvironmentDiscoveryProvider {
  constructor(
    private readonly opts: {
      discoveryUrl: string;
      getDiscoveryToken: () => Promise<string>;
      getPowerPlatformToken?: () => Promise<string>;
      logger: Logger;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async discover(): Promise<DiscoveredEnvironment[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const token = await this.opts.getDiscoveryToken();
    const data = await getJson(
      fetchImpl,
      `${this.opts.discoveryUrl.replace(/\/+$/, '')}/api/discovery/v2.0/Instances`,
      token,
      this.opts.logger,
    );
    const envs: DiscoveredEnvironment[] = ((data.value ?? []) as Raw[]).map((i) => ({
      provider: 'dataverse',
      displayName: i.FriendlyName || i.UniqueName || i.Url,
      url: normalizeEnvironmentUrl(i.Url),
      apiUrl: i.ApiUrl ?? null,
      organizationId: i.Id ?? null,
      environmentId: i.EnvironmentId ?? null,
      uniqueName: i.UniqueName ?? null,
      environmentType: organizationTypeName(i.OrganizationType),
      region: i.Region ?? null,
      version: i.Version ?? null,
      state: i.State === 0 ? 'Enabled' : i.State === 1 ? 'Disabled' : (i.State?.toString() ?? null),
      dataverseAvailable: i.State === 0 || i.State === undefined,
    }));

    if (this.opts.getPowerPlatformToken) {
      try {
        const ppToken = await this.opts.getPowerPlatformToken();
        const bap = await getJson(
          fetchImpl,
          'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments?api-version=2020-10-01',
          ppToken,
          this.opts.logger,
        );
        const byUrl = new Map<string, Raw>();
        for (const e of (bap.value ?? []) as Raw[]) {
          const instanceUrl = e.properties?.linkedEnvironmentMetadata?.instanceUrl;
          if (instanceUrl) byUrl.set(normalizeEnvironmentUrl(instanceUrl), e);
        }
        for (const env of envs) {
          const match = byUrl.get(env.url);
          if (!match) continue;
          env.environmentType = match.properties?.environmentSku ?? env.environmentType;
          env.region = match.properties?.azureRegion ?? match.location ?? env.region;
          env.environmentId = env.environmentId ?? match.name ?? null;
        }
      } catch (err) {
        this.opts.logger.warn(
          { errorCode: toDataverseError(err).code },
          'Power Platform enrichment unavailable; using discovery data only',
        );
      }
    }
    return envs.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
