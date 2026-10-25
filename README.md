# Ballot — Campus Voting Demo

Ballot is a React/Vite frontend connected to a local Node.js API. The default local account mode supports backend-verified Admin and Voter roles. Polls and ballots remain in process memory for development; restarting the backend clears them. This is not a production voting system.

The account-mode entry page `/` and `/signin` show only the Sign In form. `/signup` shows only the voter Sign Up form, and `/welcome` remains an alias for Sign In. Successful registration confirms the new account and returns to Sign In. Authenticated administrators open `/admin`; voters open `/vote`, with direct poll pages at `/poll/:pollId`. An opt-in Google mode remains available: it verifies Google OIDC ID tokens on the Node backend and checks administrators against a backend-only Google `sub` allowlist. A separate development preview mode still exists but uses spoofable mock identity headers. None of these local modes makes this prototype production-ready.

An un-deployed AWS integration scaffold is in [`aws/`](aws/) with a preparation guide in [`AWS_DEPLOYMENT_GUIDE.md`](AWS_DEPLOYMENT_GUIDE.md). The React app can use local Google sign-in with the local API, but the AWS adapter is not selected by the app and AWS integration has not been deployed or tested against AWS.

## Local setup

Use a current Node.js LTS release. From `C:\Users\bapna\voting-system`, install dependencies once:

```powershell
npm install
```

This project includes an ignored local `.env` for the requested local development setup. It selects `accounts` mode and contains the three user-provided initial Admin passwords. The file is ignored by Git; do not copy it into source control or share it. On another checkout, copy `.env.example` to `.env` and choose private values for all three `INITIAL_ADMIN_*_PASSWORD` variables before starting the backend. The backend refuses to start if a required initial Admin password is missing; it never makes a default password.

Open two terminals in the project directory. Start the backend in terminal 1:

```powershell
npm run dev:backend
```

It listens on `127.0.0.1:8787`. Start the frontend in terminal 2:

```powershell
npm run dev -- --port 5174 --strictPort
```

Open <http://localhost:5174/>. Vite proxies `/api` requests to `http://127.0.0.1:8787`. The root URL shows the account welcome page. Sign in directly at <http://localhost:5174/signin>; new voters can register at <http://localhost:5174/signup>.

### Local username and password accounts

Account mode is the default (`AUTH_MODE=accounts`, `VITE_AUTH_MODE=accounts`). The local backend creates the three predefined Admin usernames `samarth`, `vishwas`, and `sriram` from `INITIAL_ADMIN_SAMARTH_PASSWORD`, `INITIAL_ADMIN_VISHWAS_PASSWORD`, and `INITIAL_ADMIN_SRIRAM_PASSWORD` in the ignored `.env`. Never put these values in source code. On each Admin's first sign-in, the backend requires a password change before any poll API can be used. The password values supplied for this local project are development-only; replace them with strong, unique values before use beyond local testing. Changing a password updates the stored salted scrypt hash; restarting the backend does not reset it to the initial value, and initialization preserves existing hashes and does not create duplicate accounts. To reset one local Admin password, stop the backend, then run `npm.cmd run admin:reset-password -- samarth` (or `vishwas` / `sriram`) in an interactive PowerShell terminal. Enter the new password twice; input is not echoed or passed in command history. The reset changes only that account, revokes its sessions in that process, and requires a password change at next sign-in. Restart the backend after the reset. Changing an initial-password environment variable alone will not overwrite a password already initialized.

Voters can register with only a username, password, and password confirmation at `/signup`. The voter display name defaults to the normalized username. Usernames are case-insensitive and must be 3–32 characters using letters, numbers, dots, underscores, or hyphens. Passwords must be 10–128 characters and must be confirmed. Registration always assigns the `voter` role on the backend; it does not accept an Admin role. Voters sign in at `/signin` and are redirected to `/vote`. The Sign In "Which interface?" selection is a preference only: the backend compares it to the account's assigned role and never grants access based on the selection.

Password hashes are stored in the ignored `.local-data/accounts.json` file (configurable with `ACCOUNTS_FILE`), not in memory. Session tokens are random opaque values in `HttpOnly; SameSite=Strict` cookies; raw tokens are not returned in JSON. Sessions are held in memory for eight hours, so backend restart signs everyone out. Failed sign-in attempts are rate-limited in process memory. This is local-development authentication only: the account file is not encrypted at rest, sessions and rate limits are not shared between processes, there is no account recovery or in-app account management UI, and no production-grade CSRF, monitoring, lockout, or security review has been completed. Do not use it for real elections or sensitive votes.

The backend enforces Admin-only poll mutation and analytics routes. Authenticated Voters can discover published polls and submit ballots; the backend uses the account's verified local account ID for duplicate-vote prevention. These local account IDs are only as trustworthy as this laptop's file and process. The Admin/Voter route guards in React are for navigation only; the backend is the authorization boundary. The same local accounts system is not an AWS identity provider.

Useful account endpoints are `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, and `POST /api/auth/password`. API calls in account mode use same-origin cookies and do not send `x-dev-*` identity headers.

### Optional local Google Sign-In mode

Google mode is opt-in and remains separate from local username/password accounts. Set both `AUTH_MODE=google` and `VITE_AUTH_MODE=google` to use it. It uses Google Identity Services to return an OIDC ID token to the browser and sends that token as a Bearer token to the local API. The Node backend verifies its Google signing-key signature, issuer, audience, expiry, issued-at time, subject, and verified-email claim. The browser stores the token in memory only; refreshing requires sign-in again. The Google client ID is public configuration, not a client secret. The mode makes no AWS calls, but the browser does load Google Identity Services and the backend fetches Google's public signing keys when it first verifies a token.

1. Back up your current ignored `.env` if you intend to switch modes. Set `AUTH_MODE=google` and `VITE_AUTH_MODE=google`; preserve the three Admin password variables if you plan to switch back to local account mode.
2. In Google Cloud Console, create an OAuth client of type **Web application**. Add both `http://localhost` and `http://localhost:5174` as authorized JavaScript origins, as described in Google's [client ID setup guide](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid). This GIS button flow does not use a redirect URI. Do not expose a client secret in the frontend.
3. Set the same OAuth client ID in `GOOGLE_CLIENT_ID` and `VITE_GOOGLE_CLIENT_ID`.
4. Set `AUTH_MODE=google` and `VITE_AUTH_MODE=google`, then restart both local servers.
5. Start the backend and frontend as shown above. Sign in with Google. The backend's `/api/auth/me` response includes the verified Google `sub`. Only add a chosen administrator's `sub` to the backend-only `GOOGLE_ADMIN_SUBJECTS` variable; restart the backend. Do not assign admin based on email, a request header, a browser setting, or a client-supplied role. Inspect `/api/auth/me` in the browser Network panel if you need to find the subject; never copy or share the ID token.

Configure the app name and support email in Google Auth Platform **Branding**. Set the intended audience in **Audience**; if the app is in Testing, add each account you intend to use as a test user (see Google's [Audience guide](https://support.google.com/cloud/answer/15549945)). Use only the standard sign-in profile/email/openid identity scopes; no Google APIs or extra scopes are used. These are Google account-console steps for you to perform; this repository does not change external account settings. If no Google client ID is configured, Google mode shows a configuration message instead of silently using development identities.

For PowerShell, the environment lines in `.env` can be changed with a text editor. Vite loads `.env` automatically; the local Node API also reads the file on supported current Node LTS versions. Restart both processes after changing the file.

Check the health route directly:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health | ConvertTo-Json -Compress
```

Expected: `{"status":"ok"}`. `GET /api/health` is also available for the earlier API health response.

## Poll workflow

### Sharing voter links

Authorized Admins can use **Share** on a published poll or find **Share poll** in the Admin command palette. The dialog copies the existing `/poll/:pollId` voter route and creates a downloadable QR image locally in the browser. Draft polls are not offered for sharing because voters cannot discover them. `VITE_APP_ORIGIN` optionally sets the origin used by shared links; when it is empty, the current browser origin is used. Restart Vite after changing this Vite environment variable. A `localhost` or loopback link is only reachable from the same computer, so it will not work when scanned from another device. This local preview does not provide a publicly hosted application URL.

Authorized Admins can export poll summaries and backend-provided option results as CSV from the Results section. Ranked-choice exports include each available IRV round, continuing and exhausted ballots, eliminations, and outcome. Exports call the existing result endpoint and skip drafts or polls whose result-visibility rules deny access; partial exports list every poll that could not be included. User-controlled CSV text is escaped against spreadsheet formula execution, and exports omit voter identities and credentials. **Print / Save as PDF** opens a formatted browser print view; choose **Save as PDF** in the browser print destination. Poll management supports selecting rows, selecting the filtered list, clearing selection, exporting selected results, and closing selected active polls. Bulk close sends separate existing close requests and reports partial failures; only active polls are submitted for closure.

1. In the Admin workspace select **Create poll**. Set the question, at least two unique options, voting type, duration, voting mode, result visibility, and optional discussion preview. Ranked choice uses instant-runoff (IRV).
2. Save it as a draft. Drafts can be edited or deleted.
3. Select **Start poll**. The duration begins from the backend start time.
4. Open the poll and submit a single-, multiple-, or ranked-choice ballot. Ranked voters use accessible move-up/move-down controls and review their ordered ranking before submission. They must rank at least one candidate; partial rankings are allowed and cannot contain duplicates. The backend validates the ballot and poll status, then records at most one ballot per normalized development voter ID per poll. A repeat submission returns HTTP 409 with `You have already voted in this poll. You cannot vote again.` The voter screen surfaces that backend error if a second submission is attempted.
5. Inspect **Results & analytics** or open a poll's results. The backend enforces `live`, `afterVote`, and `afterClose` visibility. Multiple-choice option percentages may add to more than 100%. Ranked results show each IRV round, continuing and exhausted ballots, candidate eliminations, and final outcome. A strict majority of continuing ballots is required; if the lowest tally is tied, counting stops and reports no winner rather than applying an arbitrary tie-break.
6. Select **Close poll**, or let its duration expire. A closed or expired poll can be reopened. Reopening starts a fresh duration and preserves existing ballots/counts; a voter who has already voted remains ineligible to vote again.

The browser uses the local API client in `src/api/mockBackend.js`. Useful routes are:

| Method and route | Purpose |
|---|---|
| `GET /health` | Basic health response |
| `GET /api/polls` | List polls |
| `POST /api/polls` | Create draft |
| `GET /api/polls/:id` | Read a poll |
| `PATCH /api/polls/:id` | Edit a draft |
| `DELETE /api/polls/:id` | Delete a draft |
| `POST /api/polls/:id/start` | Start a draft |
| `POST /api/polls/:id/close` | Close an active poll |
| `POST /api/polls/:id/reopen` | Reopen a closed or expired poll |
| `GET/POST /api/polls/:id/votes` | Check ballot status / submit a ballot |
| `GET /api/polls/:id/results` | Read results when visible |

In development preview mode, admin routes use the development-only `x-dev-admin-id` header; voting and results use `x-dev-voter-id`. A caller can spoof these values, so this is not authentication. In account mode, the backend derives roles and voter identity from its local account store and session; the browser's role selection and routes cannot grant Admin access. In Google mode, the backend derives identity from the verified token `sub`, ignores development headers, and authorizes poll administration only for subjects in `GOOGLE_ADMIN_SUBJECTS`. Poll ballots and duplicate-vote checks are still backed by process memory and are lost when the backend restarts. Never use this prototype for real elections or sensitive votes.

## Ports and troubleshooting

Stop an old server with **Ctrl+C** in its terminal before restarting it. If port 8787 is occupied, identify the listener in PowerShell with:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object OwningProcess
```

Stop only a process you recognize and intend to stop:

```powershell
Stop-Process -Id <PID>
```

If Vite port 5174 is occupied, stop the old Vite process before starting with `--strictPort`; otherwise Vite would normally select a different port. If you deliberately change the backend port using `MOCK_API_PORT`, also update `server.proxy['/api']` in `vite.config.js` to the same port and restart Vite.

If the dashboard reports the backend unavailable, verify `/health`, make sure both terminals are still running, then refresh the dashboard. The frontend displays a loading state and a connection error instead of substituting sample polls.

## Feature scope and limitations

- Poll metadata, lifecycle, ballot counts, ballots, and result calculations use the local backend.
- Poll discussion uses authenticated local API routes and Server-Sent Events (SSE) for poll-specific live updates. Messages persist in `.local-data/chat-messages.json`; Admins can monitor rooms and hide or restore messages, with moderation actions recorded separately. See [docs/LOCAL_CHAT.md](docs/LOCAL_CHAT.md) for access rules, limits, and local verification steps. This is local development functionality, not an AWS WebSocket integration.
- Response rate and participant estimates are omitted because the backend has no eligible-voter denominator; no synthetic participation statistics are shown.
- Development-mode admin labels and voter ID headers are mock values. Local account mode provides development-only password hashing and sessions, but does not make the application production secure. Google mode uses verified OIDC tokens but is not a substitute for a reviewed production session and authorization architecture.
- Data exists only in backend process memory; it is not durable, shared across processes, or protected by production authorization.
- Drafts can be deleted; active, closed, and expired polls cannot. There is no archive operation. Deleted polls are removed and return 404.
- Ranked choice uses IRV. Partial rankings are allowed; a ballot exhausts once none of its ranked candidates remain. Tied-lowest rounds stop without a winner. AWS ranked results currently read all vote shards on each results request, which may become slow or costly at large scale; no final-result snapshot worker is included.
- In account mode, the UI routes users by their backend-returned role, and the local backend independently checks that role for Admin operations. Google mode similarly enforces the backend `sub` allowlist. UI hiding is not the security boundary.
- Google mode is not configured or end-to-end tested against a real Google OAuth client in this repository state. XSS protections, account recovery/session policy, eligibility rules, durable storage, rate limiting, audit controls, and a production security review remain outstanding.
- No AWS services, credentials, or cloud resources are configured or used.

## Development checks

```powershell
npm test
npm run lint
npm run build
```

## Local demo data

See [docs/DEMO_DATA.md](docs/DEMO_DATA.md) for the safe, repeatable local demo setup. It creates only new demo voter accounts, uses the authenticated local API for polls and ballots, and keeps temporary credentials in the Git-ignored `.local-data/demo-credentials.txt` report.


## Encrypted local backup

An authenticated Admin can create an encrypted, read-only snapshot from the unified dashboard. It includes poll definitions, timestamps, vote counts, ranked-choice calculations, and ballot records. Ballot voter keys are included only inside the encrypted payload so a future restore can preserve duplicate-vote state. Password hashes, session tokens, and account records are excluded. The feature rejects development/mock authentication and is available to a verified local-account Admin or backend-allowlisted Google Admin.

The Admin supplies and confirms a passphrase of at least 16 characters. The backend derives an AES-256-GCM key using scrypt, then writes a new timestamped file with exclusive-create semantics under `.local-data/backups/`; it never replaces an existing backup. The passphrase is not persisted or logged. This same-origin local implementation is not a production-grade key-management service; protect the backup and store its passphrase separately.

Before restarting the backend, validate the file from the project folder:

```powershell
npm.cmd run backup:validate -- ".local-data/backups/<backup-filename>.json"
```

The validator prompts for the passphrase without echoing it and reports only integrity, poll/ballot totals, timestamp, and SHA-256. It does not print ballot contents and does not restore data. The export route is loaded only when the backend starts with the updated code; do not restart a backend with in-memory poll data until a verified backup exists and a separate restart has been approved.
