# Microsoft Entra ID & Dataverse setup

This guide enables **Continue with Microsoft**, real environment discovery, metadata reads and
delegated migrations. About 10 minutes in the Microsoft Entra admin center.

The application never asks for or stores Dataverse passwords. It uses the OAuth 2.0
authorization code flow with PKCE as a **confidential client**. Tokens stay on the server.

---

## 1. Create the app registration

1. Open <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
2. **Name:** `DeepTrics Dataverse Migration` (any name).
3. **Supported account types**
   - SaaS for many customers: **Accounts in any organizational directory (Multitenant)**, with `ENTRA_TENANT_ID=organizations`.
   - DeepTrics only: **Single tenant**, with `ENTRA_TENANT_ID=<your tenant GUID>`.
4. **Redirect URI:** platform **Web**, value:
   - Local (built app, `npm start`): `http://localhost:3000/api/auth/callback`
   - Local dev server (`npm run dev`): `http://localhost:5173/api/auth/callback` (also set `APP_BASE_URL=http://localhost:5173`)
   - Production: `https://<your-domain>/api/auth/callback`

   You can register several redirect URIs. The one the app uses is `ENTRA_REDIRECT_URI`, or
   `${APP_BASE_URL}/api/auth/callback` when that isn't set. It must match the registered value exactly.

5. Click **Register**. Copy the **Application (client) ID** into `ENTRA_CLIENT_ID`.

## 2. Create a client secret

**Certificates & secrets → Client secrets → New client secret.** Copy the secret **Value**
(not the Secret ID) into `ENTRA_CLIENT_SECRET`. Store it in your secret manager and never in Git.
Put a rotation reminder on the expiry date.

## 3. API permissions (delegated)

**API permissions → Add a permission**:

| API                                                                                         | Type      | Permission                                     | Why                                                                                                | Admin consent                                                                                             |
| ------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Dynamics CRM** (Microsoft APIs tab)                                                       | Delegated | `user_impersonation`                           | Access Dataverse as the signed-in user: Global Discovery Service and each environment's Web API    | Not required by Microsoft, but many tenants block user consent. **Grant admin consent** to avoid prompts. |
| Microsoft Graph                                                                             | Delegated | `openid`, `profile`, `email`, `offline_access` | Sign-in, user identity, refresh tokens                                                             | Not required                                                                                              |
| _(optional)_ **PowerApps Service** (APIs my organization uses → search "PowerApps Service") | Delegated | `User`                                         | Only if `POWER_PLATFORM_ENRICHMENT=true`: environment SKU/region from the Power Platform admin API | Usually required                                                                                          |

Then click **Grant admin consent for <tenant>** (requires a Global/Privileged Role/Cloud Application administrator).

> Why one Dataverse permission covers every environment: the Global Discovery Service
> (`https://globaldisco.crm.dynamics.com`) and every environment (`https://<org>.crm.dynamics.com`)
> are resources of the **Dynamics CRM** first-party application. The server requests
> `https://globaldisco.crm.dynamics.com/user_impersonation` at sign-in. It then silently exchanges
> the refresh token for `https://<org>.crm.dynamics.com/user_impersonation` for each selected environment.

## 4. Configure the server

```dotenv
ENTRA_CLIENT_ID=<application (client) id>
ENTRA_CLIENT_SECRET=<client secret value>
ENTRA_TENANT_ID=organizations        # or your tenant GUID
APP_BASE_URL=http://localhost:3000   # must match the redirect URI host
SESSION_SECRET=<48+ random characters>   # openssl rand -base64 48
# Optional hardening
ALLOWED_TENANT_IDS=<deeptrics tenant guid>
ADMIN_EMAILS=srinivas@deeptrics.com
```

Restart the server. The login page now shows **Continue with Microsoft**. Demo mode can stay
enabled alongside it (`DEMO_MODE=true`) or be turned off.

## 5. Dataverse permissions for users

Discovery lists only environments where the signed-in user has access. For each environment:

- **Source:** a security role with **Read** on the tables to migrate and on metadata
  (e.g. _Basic User_ plus table read privileges). Detecting plug-ins/flows requires read access to
  `sdkmessageprocessingstep` and `workflow`. Without it the plan shows "detection unavailable" instead of failing.
- **Target:** **Create**, **Write** and **Read** on the migrated tables, plus **Append / Append To**
  for lookups. Preserving record IDs (the default) needs no extra privilege.
- **Bypass custom business logic** (optional, off by default): the target user needs
  `prvBypassCustomBusinessLogic`. The server also requires `ALLOW_BUSINESS_LOGIC_BYPASS=true`
  and the app **ADMIN** role, and every use is audited.

The platform never changes security roles, plug-in registrations or flows.

## 6. How the pieces work

1. **Sign-in:** `/api/auth/login` builds an authorization request with PKCE, `state` and `nonce`,
   stored server-side and single-use. Microsoft redirects to `/api/auth/callback`. The server
   redeems the code, validates the nonce and optional tenant allow-list, creates or updates the
   organization (by `tid`) and user (by `oid`), and sets an HttpOnly session cookie.
2. **Token storage:** the MSAL token cache (including the refresh token) is encrypted with
   AES-256-GCM (key derived from `SESSION_SECRET`) and stored per user in `token_caches`. Tokens
   are never sent to the browser, stored in localStorage or written to logs.
3. **Environment discovery:** `GET https://globaldisco.crm.dynamics.com/api/discovery/v2.0/Instances`
   with the user's delegated token returns each Dataverse instance: name, URL, organization ID,
   environment ID, region, version and state. With `POWER_PLATFORM_ENRICHMENT=true` the admin API
   (`api.bap.microsoft.com`) adds SKU and region.
4. **Delegated Dataverse access:** for each environment the server acquires a token silently for
   `https://<org>.crm.dynamics.com/user_impersonation` and calls the Web API `v9.2`. Background
   migrations run on the authority of the user who executed (or retried) the run. If the refresh
   token expires, the run fails with "sign in again" instead of stalling.

## 7. Sovereign clouds

Set `DATAVERSE_DISCOVERY_URL` (and `ENTRA_AUTHORITY_HOST` where needed):

| Cloud            | Discovery URL                                  | Authority                           |
| ---------------- | ---------------------------------------------- | ----------------------------------- |
| Commercial       | `https://globaldisco.crm.dynamics.com`         | `https://login.microsoftonline.com` |
| GCC              | `https://globaldisco.crm9.dynamics.com`        | `https://login.microsoftonline.com` |
| GCC High         | `https://globaldisco.crm.microsoftdynamics.us` | `https://login.microsoftonline.us`  |
| China (21Vianet) | `https://globaldisco.crm.dynamics.cn`          | `https://login.chinacloudapi.cn`    |

Verify these against current Microsoft documentation before production use in sovereign clouds.

## 8. Troubleshooting

| Symptom                                             | Cause / fix                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AADSTS50011` redirect URI mismatch                 | The registered redirect URI must exactly equal `ENTRA_REDIRECT_URI` / `${APP_BASE_URL}/api/auth/callback`. |
| `AADSTS65001` / consent required                    | Grant admin consent for Dynamics CRM `user_impersonation`.                                                 |
| Login succeeds, no environments                     | The user has no Dataverse security role in any environment, or the tenant has no Dataverse environments.   |
| Test connection: "not a member of the organization" | Add the user to the environment with a security role.                                                      |
| "Sign in again" errors in runs                      | The refresh token expired or was revoked (password reset, Conditional Access). Sign in and use **Retry**.  |
