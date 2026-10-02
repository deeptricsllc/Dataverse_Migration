# Microsoft Entra ID & Dataverse setup

This guide enables **Continue with Microsoft**, real environment discovery, metadata reads and
delegated migrations. About 10 minutes in the Microsoft Entra admin center.

The application never asks for or stores Dataverse passwords. It uses the OAuth 2.0
authorization code flow with PKCE as a **confidential client**. Tokens stay on the server.

Connecting to a real tenant for the first time? Follow
[REAL_TENANT_CERTIFICATION.md](REAL_TENANT_CERTIFICATION.md) after this guide: it walks through a
read-only certification (`REAL_TENANT_READ_ONLY=true`) that proves the connection works without
writing anything to Dataverse.

---

## 1. Create the app registration

1. Open <https://entra.microsoft.com> → **Identity → Applications → App registrations → New registration**.
2. **Name:** `DeepTrics Dataverse Migration` (any name).
3. **Supported account types** — this choice and `ENTRA_TENANT_ID` must agree, or sign-in fails at
   Microsoft with `AADSTS700016`:
   - One directory (the usual choice, and the right one for a pilot): **Single tenant**, with
     `ENTRA_TENANT_ID=<this directory's tenant GUID>`. Guests invited into that directory can still
     sign in; people in their own directories cannot.
   - SaaS across many customers: **Accounts in any organizational directory (Multitenant)**, with
     `ENTRA_TENANT_ID=organizations` — and each customer's administrator must grant consent before
     anyone there can sign in.
4. **Redirect URI** — add the platform first. A registration with no **Web** platform has _no_ reply
   address, and sign-in then fails with `AADSTS500113` **after** the user has already consented, which
   looks like a product fault and is not one. **Authentication → Add a platform → Web**, then:
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

Three independent decisions. Treating any two of them as one is the single most common way a
deployment ends up with a sign-in nobody can complete, so they are listed apart.

**Who this application is.** Nothing else identifies it.

```dotenv
ENTRA_CLIENT_ID=<application (client) id>
ENTRA_CLIENT_SECRET=<client secret value>
APP_BASE_URL=https://<your-domain>      # the redirect URI is derived from this
SESSION_SECRET=<48+ random characters>  # openssl rand -base64 48
```

**Which directory Microsoft authenticates against** — the _authority_. This is a question put to
Microsoft and answered before any request reaches this product.

```dotenv
# A single-tenant registration: the directory GUID that OWNS the registration.
ENTRA_TENANT_ID=<directory (tenant) id of the app registration>

# Only for a multi-tenant registration that each customer has admin-consented:
# ENTRA_TENANT_ID=organizations
```

> **`organizations` is not a safe default.** It tells Microsoft to resolve the directory from
> whoever is signing in, not from this deployment. With a **single-tenant** registration, every
> person whose home directory is not the registration's own is refused by Microsoft with
> **`AADSTS700016`** — on Microsoft's own page, before this product sees anything, so no error
> message we write can improve it. Find the right value in **Entra admin center → App registrations
> → your app → Overview → Directory (tenant) ID**.

**Which directories this product then admits** — _admission_. This is our decision, taken after
Microsoft has authenticated somebody, on a tenant id that is already proven.

```dotenv
ACCESS_MODE=GATED                       # the default
ALLOWED_TENANT_IDS=<directory guid>[,<directory guid>...]
ADMIN_EMAILS=you@example.com            # who operates the deployment
```

> **Under `GATED`, `ALLOWED_TENANT_IDS` is required, not hardening.** An empty list admits
> **nobody** — it does not admit everybody. Microsoft will authenticate people successfully and this
> product will then refuse every one of them. Entries must be directory **GUIDs**: a domain name
> such as `contoso.com` can never match the tenant id Microsoft returns, so it silently excludes the
> organization it was meant to admit. Set `ACCESS_MODE=OPEN_BETA` only to deliberately admit any
> work or school directory.

An admission list is never an authority. Listing a customer's directory in `ALLOWED_TENANT_IDS` does
not — and must not — send authentication there; that would ask one customer's directory to vouch for
another customer's user.

Restart the server. The login page now shows **Continue with Microsoft**. Demo mode can stay
enabled alongside it (`DEMO_MODE=true`) or be turned off.

### Check it before anybody tries to sign in

The server describes its own sign-in configuration on startup, worst finding first. A deployment
nobody can sign in to says so on its first line:

```
[BLOCKS_SIGN_IN] GATED_WITH_EMPTY_ALLOW_LIST: ... GATED with an empty list admits nobody ...
[WARNING] AUTHORITY_RESOLVES_USER_HOME_DIRECTORY: ... will be refused with AADSTS700016 ...
```

The same report is available to a platform operator (an address in `ADMIN_EMAILS`) at
`GET /api/platform/auth-configuration`. It states whether each secret is present and never what any
secret is.

For the first connection to a real tenant, also set `REAL_TENANT_READ_ONLY=true`. Every read keeps
working; every Dataverse write is refused by the server, so nothing can be changed while you are
still verifying the setup.

## 5. Dataverse permissions for users

Discovery lists only environments where the signed-in user has access. For each environment:

- **Source:** a security role with **Read** on the tables to migrate and on metadata
  (e.g. _Basic User_ plus table read privileges). Detecting plug-ins/flows requires read access to
  `sdkmessageprocessingstep` and `workflow`. Without it the plan shows "detection unavailable" instead of failing.
- **Target:** **Create**, **Write** and **Read** on the migrated tables, plus **Append / Append To**
  for lookups. Preserving record IDs (the default) needs no extra privilege.
- **Audit policy** (`NONE` by default; chosen per plan):
  - any policy other than `NONE` needs read access to `systemuser`, `team` and `businessunit` in
    **both** environments so the user mapping can be built;
  - `STANDARD` preserves **owner** and **created on**. Created on is written through
    `overriddencreatedon`, which Dataverse only accepts on create and only from a user holding
    "Override Created on or Created by for Records during Data Import"
    (`prvOverrideCreatedOnCreatedBy`) in the target;
  - `PRESERVE_ATTRIBUTION` additionally preserves **created by / modified by** by writing each
    record while impersonating the mapped user. That needs "Act on Behalf of Another User"
    (`prvActOnBehalfOfAnotherUser`) in the target. Microsoft requires this privilege to be assigned
    **directly to the user**: it cannot be inherited through a team. The User mapping page runs a
    read-only check before you execute, and the plan blocks execution until the check passes;
  - **modified on** can never be preserved: Dataverse always stamps it with the migration time.
- **Bypass custom business logic** (optional, off by default): the target user needs
  `prvBypassCustomBusinessLogic`. The server also requires `ALLOW_BUSINESS_LOGIC_BYPASS=true`
  and the app **ADMIN** role, and every use is audited.

The platform never changes security roles, plug-in registrations or flows.

### Read-only deployments

With `REAL_TENANT_READ_ONLY=true` the target privileges above are not exercised at all: the server
refuses every Dataverse write regardless of what the signed-in user is allowed to do. Use it while
you are validating a tenant connection.

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

| Symptom                                                                                      | Cause / fix                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AADSTS700016` "Application with identifier ... was not found in the directory ..."          | The authority is resolving the signing-in user's directory, and the registration is not in it. Set `ENTRA_TENANT_ID` to the registration's own **Directory (tenant) ID**, or make the registration multi-tenant and have that directory grant admin consent. Happens on Microsoft's page, before this product is reached.                         |
| Microsoft sign-in succeeds, then "Your organization is not enabled for this environment yet" | `ACCESS_MODE=GATED` and the directory is not in `ALLOWED_TENANT_IDS`. The refused tenant id is in the server log. An empty list refuses everybody.                                                                                                                                                                                                |
| **Continue with Microsoft** does not appear at all                                           | Only one of `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET` is set, so Microsoft sign-in is off. The startup log says so.                                                                                                                                                                                                                               |
| **`AADSTS500113` "No reply address is registered for the application"**                      | **No redirect URI is registered at all** — not a mismatch. The registration has no **Web** platform. Add one under **Authentication → Add a platform → Web** with `${APP_BASE_URL}/api/auth/callback`. Appears **after** the consent screen, so reaching it means the client id, the authority, the secret and admission are all already correct. |
| `AADSTS50011` redirect URI mismatch                                                          | A Web platform exists and the URI we sent is not on it. Must equal `ENTRA_REDIRECT_URI` / `${APP_BASE_URL}/api/auth/callback` exactly, including the scheme and any trailing path.                                                                                                                                                                |
| `AADSTS65001` / consent required                                                             | Grant admin consent for Dynamics CRM `user_impersonation`.                                                                                                                                                                                                                                                                                        |
| Login succeeds, no environments                                                              | The user has no Dataverse security role in any environment, or the tenant has no Dataverse environments.                                                                                                                                                                                                                                          |
| Test connection: "not a member of the organization"                                          | Add the user to the environment with a security role.                                                                                                                                                                                                                                                                                             |
| "Sign in again" errors in runs                                                               | The refresh token expired or was revoked (password reset, Conditional Access). Sign in and use **Retry**.                                                                                                                                                                                                                                         |
| `REAL_TENANT_READ_ONLY` when starting a migration                                            | The deployment is in read-only certification mode. This is deliberate; see REAL_TENANT_CERTIFICATION.md.                                                                                                                                                                                                                                          |
| Impersonation check fails despite the privilege                                              | `prvActOnBehalfOfAnotherUser` must be assigned directly to the user, not through a team.                                                                                                                                                                                                                                                          |

The **Diagnostics** page runs all of these checks in one place and explains each failure, without
ever displaying a token or a raw response.
