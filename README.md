# Naung

A fictional-store demo with a public chat frontend on GitHub Pages and a chat backend on Biznet NEO. The web chat and Delta Chat group share one public conversation, with separate fictional character bot accounts and sandbox-only checkout.

- **Frontend:** https://vanipy.com/naung/ (GitHub Pages, `main/docs`)
- **Backend:** https://irvan.app.neoapp.id/ (Biznet NEO). It owns the public chat data, Delta Chat relay, bot replies and sandbox shop.
- **Public chat API:** `GET /api/visitor/messages` and `POST /api/visitor/send` on the NEO host. The Pages frontend uses cross-origin requests to these routes.

The Pages site is only the browser UI. If the NEO service is unavailable, chat reads and sends will not work. The visitor chat and linked Delta Chat group are public, not private. Do not enter secrets or personal payment details. Instinct stand-in replies are checked about once an hour and can take up to an hour.

### Cross-origin visitor API rollout

The intended browser origin is exactly `https://vanipy.com`. The backend should return CORS headers only for that origin, handle `OPTIONS` preflight for the JSON API paths, and reject writes carrying a different or missing `Origin`. CORS is not authentication, so the write endpoint also enforces message length, request-body size, a 2-second minimum interval, a per-IP hourly cap, and a service-wide hourly cap. It accepts URL-encoded text and returns JSON instead of redirecting; the existing same-origin `/visitor/send` route remains for the old NEO-hosted page.

The current rate limiter is in-memory and per process; it resets on restart and is not a substitute for a provider-level abuse/WAF limit. The code defaults to the socket peer address for per-IP limits. `NAUNG_TRUST_PROXY_XFF=true` is an opt-in to use the first `X-Forwarded-For` value; only set it after confirming NEO ingress strips client-supplied forwarding headers and sets its own. Until then, clients may share the proxy socket key, so the per-IP allowance can apply to all visitors behind that proxy. CORS origin and API changes are prepared in this repository but must not be deployed to the live service until the NEO portal is accessible and the operator has been told.


## Private storage

Set `NAUNG_DATA_DIR` to a private mounted directory outside this source tree. The app stores public conversation records, catalog/stock/orders, original message references, native account databases and the original published group invite there. Native keys and state must never be committed or served as static files. The process holds an OS `flock` writer lock for its lifetime. Missing or corrupt saved state fails closed.

Configuring a directory or volume is not proof that a hosting provider retains it through restart/redeploy. This repository's local checks do not certify hosted durability.

### NEO App persistent-volume billing (learned 2026-11-23)

A persistent volume attached to the original NEO App deployment kept accruing disk charges on its own meter. The fix was to clone the app into a new project configured without a volume, repoint irvan.app.neoapp.id to the new service, then delete the old service. Verification at 10:34 WIB the same day: the old service's disk line stayed frozen at 17 GB-hours (Rp68) after deletion, and the new app shows no storage line at all, so storage billing genuinely stopped rather than sitting as a pending deletion. After any storage change, verify the provider's usage lines directly; deleting a service alone is not proof that its disk charges have stopped.

## Later group members

For each arrival, the app uses Delta Chat's original-message resend across the three bot accounts, limited to the latest 100 eligible bot-owned public-group messages. These preserve the original senders and let clients that already have them deduplicate. Pending originals retry on the next check. Private chats are never scanned.

Delta Chat does not let a bot resend another human's originals. Native human public messages are therefore provided to a newcomer in a separate, clearly labelled historical transcript, not reposted into the group. This transcript uses only public-native-message records, with display names explicitly described as self-reported. Previously served recipients are retained with private state to avoid repeat transcripts after restart.

## Optional owner group addition

`NAUNG_OWNER_CONTACT_INVITE` accepts a privately configured owner contact QR link. The app uses its secure-join key-contact, keeps encryption intact, and adds only that account to its public group. Do not put the link in source or logs. An offline contact handshake is reported as pending without taking the demo offline. Status exposes booleans only, not the contact link.

## Checks

`node --test pay.test.cjs shared-room.test.cjs character-team.test.cjs public-replay.test.cjs persistence.test.cjs persistence-server-test.cjs`

`node character-native-test.cjs` performs a real local native-core test with mocked AI. It checks three actual bot senders, later-member replay without duplicate old-member replies, a newcomer-only human public-history transcript, private-message exclusion, and the one-call/no-loop guards. It uses synthetic chatmail accounts and no model credit.

### Speaker attribution and chat time

Chat records now carry trusted origin/speaker metadata rather than inferring
bot authority from a participant's display name. Other speakers' history is
quoted room context. Reply labels are owned by the selected native sender,
not generated transcript headers. Native group delivery is awaited and a
pending/failed status is visible on the web if delivery does not succeed.

Chat time is rendered in Asia/Jakarta with a WIB label, independent of the
host timezone. New public records retain an ISO timestamp; known legacy
UTC HH:MM records are converted for display without rewriting saved history.
Delta Chat handset timestamps remain under the handset client's own settings.

---

Built with AI assistance (Instinct and others). Not everything has been reviewed by Irvan.
