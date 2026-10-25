# Local Poll Chat

Ballot now provides authenticated, poll-specific discussion in the local application. Voters can read discussion for active and closed polls and post while a poll is active. Closed polls remain read-only so their discussion stays available. Draft polls are hidden from voters and have no accessible chat room.

## Local transport

The local backend uses Server-Sent Events (SSE) for server-to-browser updates and authenticated HTTP POST requests for sending messages. The browser reconnects after a dropped stream. This gives near-immediate local updates without adding a dependency or contacting a package registry. It is not an API Gateway WebSocket deployment, and it does not establish AWS real-time capability.

## Access and moderation

- A verified account session or verified Google OIDC identity is required. The development preview/mock identity mode is rejected for chat.
- The backend derives the message sender from the authenticated identity; client-supplied sender names are ignored.
- Only voters can post. Administrators can monitor chat rooms and hide or restore messages; they cannot post as voters.
- Messages are scoped to a poll ID. The backend limits messages to 500 characters and 10 messages per identity per poll per 10 seconds.
- Hidden messages are excluded from voter history and streams. Admins can see hidden messages. Hide/restore actions are recorded in `.local-data/chat-moderation.jsonl` without message text.

## Local storage and limits

Chat messages are stored in `.local-data/chat-messages.json` with restrictive local file permissions and persist across backend restarts. This file is separate from the in-memory poll and ballot store. If a restart clears a poll, its chat history remains on disk but cannot be reached until the matching poll ID exists again. The store is local to one backend process and is not shared across devices or server instances. It has a 20,000-message global cap and 1,000-message per-poll cap; older messages may be removed when the global cap is reached. Rate limiting is in process memory and resets on restart. The local JSON file is not encrypted and this is not production storage.

The existing `chatEnabled` poll field is retained for compatibility with saved poll data, but the local chat feature is available for every active or closed poll and does not use that legacy field as an access control. Draft status and poll lifecycle are enforced by the backend.

## Verify locally

1. Start the backend with `npm.cmd run dev:backend` and the frontend with `npm.cmd run dev -- --port 5174 --strictPort`.
2. Sign in as a voter in two browser sessions and open the same active poll. Send a message in one session; it should appear in the other without refreshing.
3. Sign in as an Admin and open **Live chat** in the Admin dashboard. Verify the room and message appear; hide and restore a message to check moderation.
4. Close the poll. Voters should still read history, while sending a new message should be rejected.
5. Run `npm.cmd test` for route, isolation, authorization, moderation, stream cleanup, and persistence checks.

No AWS resources, credentials, or external services are used by this local feature.
