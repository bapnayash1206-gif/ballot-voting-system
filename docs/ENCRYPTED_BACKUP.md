# Encrypted Local Backup

The local Admin-only endpoint `POST /api/admin/backup/export` creates an encrypted snapshot of the running process's in-memory poll state. It accepts only `{ "passphrase": "..." }`, requires at least 16 characters, and is available only in account or Google auth modes after backend Admin authorization. Development/mock identity headers are always rejected. The endpoint reads poll memory and writes a new encrypted file under `.local-data/backups/`; it does not mutate polls, ballots, accounts, or sessions.

The file uses a versioned JSON envelope with AES-256-GCM and a key derived with Node's scrypt (`N=32768, r=8, p=1`). The random salt, IV, authentication tag, and ciphertext are included. Poll definitions, exact aggregates, IRV results, ballot choices, submission times, and internal voter keys are encrypted. The metadata response contains only the new filename, poll and ballot counts, size, creation time, and SHA-256 digest. Passphrases and ballot contents are not logged. Unique timestamp-plus-random filenames are opened with `wx`; an existing filename is never overwritten.

## Validate before restarting

From the project folder run:

```powershell
npm.cmd run backup:validate -- ".local-data/backups/<backup-filename>.json"
```

The script prompts for the passphrase with hidden input. It authenticates/decrypts in memory, validates the backup schema, duplicate voter keys, option references, ballot counts and choice counters, and recomputes ranked-choice rounds. It prints only the validation summary and file digest. It has no restore behavior and does not write to the backup.

## Limitations and security

- The current local `votingMode: anonymous` ballots still use the account identity internally for duplicate-vote prevention. The export therefore encrypts those internal voter keys; “anonymous” is not unlinkable anonymity in this local design.
- Anyone who obtains both the file and passphrase can decrypt voter choices and identity keys. Store them separately and restrict file access. The local file inherits project-directory permissions; POSIX mode `0600` is requested, but Windows ACLs should be reviewed separately.
- The passphrase arrives in a same-origin local HTTP request and is held transiently in process memory. It is not logged or stored, but JavaScript cannot guarantee memory zeroization of immutable strings. Use this only on a trusted local machine. A deployed version must use HTTPS and a reviewed key-management approach.
- The export route does not restore data, persist polls for ordinary operation, export accounts/sessions, or include chat. Polls and ballots remain in memory until an approved restart; existing JSON files are not altered.
- The endpoint bypasses voter-facing result visibility only for the verified Admin backup operation so the snapshot can be complete. It must not be exposed through a voter route.
- The route is not active in an already-running Node process until that process is deliberately restarted. No route call or export is made during implementation.

## Activation caveat for existing in-memory polls

The route is not hot-loaded into a backend process that started before this code change. The old API has no individual-ballot export endpoint, and polls/ballots exist only in that process's memory. Therefore, if valuable poll data exists in an older running process, restarting it to activate this route would lose that data before this new export can run. Do not restart that process until a separate plan explicitly accepts the loss or a complete backup has been obtained by a method available in that running version. Existing `backup-polls.json` and `backup-results.json` files must be independently validated and must not be assumed to include ballots or match current runtime state.
