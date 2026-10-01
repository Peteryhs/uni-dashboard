# Android sign-in with Cloudflare Access Managed OAuth

The Android client uses Cloudflare Access as an OAuth 2.0 authorization server for the deployed
dashboard. The dashboard origin is entered during setup. For an origin such as
`https://dashboard.example.com`, the only redirect URI registered in Access for this client is:

```text
https://dashboard.example.com/oauth/android/callback
```

The URI is exact. It is not a wildcard, localhost allowance, or custom app-scheme redirect. The
Worker serves that HTTPS route and returns only `code`, `state`, `error`, and optional `iss` to
the Android app scheme `dev.peteryhs.unidash:/oauth/callback`. The native client checks the active
state and uses its PKCE verifier for the exchange; the bridge never forwards access or refresh
tokens.

## Deployment configuration

### One-time owner setup in Cloudflare

The dashboard owner completes this once for the Access application that protects the full
dashboard hostname. The phone user does not need a Cloudflare account, API token, client ID, or
client secret for browser sign-in.

In the Cloudflare dashboard, open **Zero Trust → Access controls → Applications**. Find the
application for the dashboard, open its three-dot menu, choose **Edit**, then open **Advanced
settings**. Under **Managed OAuth**, enable the feature, add this exact allowed redirect URI, and
save:

```text
https://dashboard.example.com/oauth/android/callback
```

Replace `dashboard.example.com` with the deployed dashboard origin. The URI must use HTTPS and
must match the origin the phone user enters, including the `/oauth/android/callback` path. Set
**Access token lifetime** to **15 minutes** and **Grant session duration** to **336 hours (2 weeks)**,
then choose **Save**. Keep any existing allowed redirect URIs and Access policies when adding the
Android callback.

This is the only Cloudflare setup needed for the normal Android browser flow. If you do not own
the Cloudflare application, send these instructions to its owner and wait for them to finish.

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the shell running the deployment tool.
The token needs Cloudflare Access Apps and Policies Read permission for preview and Write
permission for `--apply`.

```text
npm run access:oauth -- --dashboard https://dashboard.example.com --app-id <access-app-id>
npm run access:oauth -- --dashboard https://dashboard.example.com --app-id <access-app-id> --apply
```

The first command performs a read and previews the effective changes. The second fetches the
current Access application, preserves its full configuration, and sends a full update. It enables
Managed OAuth, appends the exact callback URI to existing allowed URIs, and configures a 15-minute
access token with a 336-hour grant session. Existing policies,
destinations, redirect URIs, and localhost/loopback settings stay in place. The tool refuses a
dashboard whose origin, root, and callback are not already covered by the selected Access
application.

The application ID can be omitted when `ACCESS_AUD` is present in `wrangler.toml` or the shell;
the tool discovers exactly one matching Access application. The tool never stores or prints the
API token and is preview-only unless `--apply` is supplied.

### Choose a different refresh session duration

The normal dashboard setup uses a **336-hour (2-week)** grant. The repository tool can prepare a
different owner choice when the deployment requires it; this does not change a phone's current
sign-in until the owner saves it in Cloudflare and the user signs in again:

```text
npm run access:oauth -- --dashboard https://dashboard.example.com --grant-weeks 3
npm run access:oauth -- --dashboard https://dashboard.example.com --grant-weeks 3 --apply
```

Without `--grant-weeks`, the tool retains the two-week default. The application cannot promise
uninterrupted access: policies and revocation may require an earlier sign-in. Sign in again on the
phone after changing the configuration to obtain a fresh grant.

### Interactive setup guides

Web shows a checklist for a new empty backend and offers **Setup guide** in Settings → Connections.
Android offers **Setup guide** in Settings.
Both remember only the current instruction, so private calendar URLs are never copied into
guide progress. Web steps save feeds using the existing credentials endpoint and show reported
source health separately from configured status. Steps can be skipped; finishing does not claim
that an unconfigured feed or phone is connected. Android's guide links to the web guide with
`?setup=mobile`, explains owner configuration, and can fill the connection screen with the chosen
dashboard origin. Reminder permission remains optional.

Deploy the updated Worker (including its static-asset routing configuration) before testing with
the updated Android app. Managed OAuth must be enabled on the Access application covering the
same origin that the user enters. Other dashboard origins need their own exact callback entry.

### Connect the phone

After the owner setup is complete, the end user only needs the public HTTPS dashboard address.
Open UniDash, enter that dashboard address, and tap **Sign in**. The system browser opens the
Cloudflare Access login; finish authentication there and allow the browser to return to UniDash.
The app verifies the connection and stores its refresh credential in Android Keystore-backed
storage. It never asks the phone user for a Cloudflare API token.

For the current deployed dashboard, enter `https://uni-dashboard.petershao288.workers.dev/`.
Other deployments must use their own HTTPS origin and matching callback URI.

If sign-in discovery fails, check that the address is the dashboard origin rather than the
Cloudflare admin console, then ask the dashboard owner to confirm the one-time Managed OAuth setup
and exact callback URI. **Advanced** service-token fields are a fallback for older deployments
without browser sign-in; they are a separate owner-managed credential path.

## Authorization and refresh

Android discovers the authorization and token endpoints from the dashboard's
`/.well-known/oauth-authorization-server` metadata, creates a one-time PKCE verifier and state,
and opens the authorization endpoint in the system browser. The state value binds the callback to
the active login attempt. The app exchanges the returned code with the verifier, stores the
resulting refresh credential in Android Keystore-backed storage, and uses the short-lived access
token for API calls.

When an access token expires, Android refreshes it in the background. Cloudflare re-evaluates the
Access policy on refresh. When the configured grant expires, a policy changes, or Cloudflare
revokes the grant, the refresh fails and the next sign-in returns to the browser. A 336-hour grant
is the configured upper session duration, not a guarantee that every login lasts the full two
weeks.

## Sign-out and revocation

App sign-out is local: it invalidates the app's session, removes its refresh credential and local
dashboard data, and prevents delayed callbacks from repopulating that session. It does not revoke
the Cloudflare grant held by another device and does not promise to invalidate a token already
present in a different client.

For a broader response, revoke the user's Access application tokens or remove the matching Access
policy in Zero Trust. A global Cloudflare logout affects Cloudflare sessions across applications,
while deleting a service token only revokes the service-token fallback for that device.

## Service-token fallback

Deployments that cannot open a browser may keep using an Access service token. Add a Service Auth
policy to the same Access application and configure the Android client with its client ID and
secret. This path is independent of the Managed OAuth grant and should be revoked in Zero Trust
when the device is retired.

## Verify a deployment

1. Enter the deployed dashboard address in Android. Confirm the system browser opens the expected
   Cloudflare Access login and returns to the app after authentication.
2. Close the browser before finishing; confirm Android offers another attempt. Repeat with app
   rotation and with Android reclaiming the app process while the browser is open.
3. Allow the short-lived access token to expire. Confirm foreground and background sync renew it
   without another prompt. Revoke the grant or remove the user's policy and confirm the app offers
   sign-in again while keeping its cached dashboard readable.
4. Disconnect while sync or browser sign-in is in progress. Confirm delayed results cannot restore
   the connection or cached data.
5. Confirm the web dashboard still accepts its normal browser login and an existing service-token
   connection still works through Advanced.

The repository tests cover protocol requests, callback validation, token renewal, and the Worker's
API gate. A real Access account and Android device are required to verify the complete browser and
Cloudflare edge flow.

