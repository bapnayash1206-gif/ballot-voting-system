# Local demo data

Run `npm.cmd run demo:setup` from the project directory while the local account backend is already running at `http://127.0.0.1:8787`. The setup script does not start or restart the backend. It first checks the health route, then asks for one of the three existing Admin usernames and reads the password without echoing it. It never changes the Admin password; an Admin still requiring the normal initial password change must complete that flow first.

The setup uses the existing registration, login, poll lifecycle, vote-status, and vote endpoints. The backend hashes new Voter passwords with its current scrypt implementation and validates every poll and ballot. Existing usernames are preserved and their password/role are not changed. It writes credentials only for accounts successfully created by this setup to `.local-data/demo-credentials.txt`; this directory is ignored by Git. Keep that report local and remove it securely when it is no longer needed.

Ten Voter usernames are reserved by the demo setup: `demo_voter01` through `demo_voter10`. New temporary passwords are generated on the first successful registration and are not printed to the terminal. If one of these users already exists, the setup skips registration. On later runs it can use only the password in its local report; if the account was created elsewhere or its password was changed, it skips that account's planned ballot.

Three clearly labeled demo polls are created:

- `[Demo] Which campus event would you prefer?` — single-choice, active.
- `[Demo] Which technical workshop interests you most?` — multiple-choice, active.
- `[Demo] Which campus improvement should be prioritized?` — ranked-choice IRV, closed after ballots are submitted.

All use public voting and live result visibility so the local demo endpoints expose the accepted ballots according to the configured rules. Six voters are assigned to the event poll, four to the workshop poll, and five to the ranked poll; the other voters remain without a planned vote. Repeat runs check the backend's per-voter vote receipt first, so accepted ballots are not duplicated. Poll IDs are recorded in `.local-data/demo-setup-state.json`; only polls with these recorded IDs are reused. Existing unrelated polls are not adopted or changed.

Important limitation: the local backend stores polls and ballots in process memory. Restarting it clears the demo polls and votes; the account records remain in `.local-data/accounts.json`. Rerun the setup after a backend restart to recreate the three polls and their demo ballots. There is no supported account-deletion endpoint, and only draft polls can be deleted. These active/closed demo records therefore have no safe cleanup action through the current API; leave them clearly labeled or use the normal supported poll lifecycle. This local demo setup is not production-secure and must not be used for real elections.
