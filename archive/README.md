# Public demo snapshot

The owner approved publishing this previously public chat capture on 23 November 2026. This exception covers this snapshot only. It does not permit publishing future chats, private messages, keys or configuration.

The seed contains 20 web-feed and 50 rendered group records, with overlap intentionally retained. Sender labels are unverified display text. Group timestamps retain their displayed ISO form. Feed times have no date and may reflect the old UTC display rather than WIB.

The raw public feed/catalog JSON and manifest are included. Original group HTML is retained in the separate private backup; its hash and source are recorded in the manifest. This is not a native backup.

Set NAUNG_BUNDLED_HISTORY=1 for the explicitly approved disposable deployment. If no NAUNG_DATA_DIR is set, the launcher uses /tmp/naung-ephemeral. Remove old disk-specific native paths before enabling this mode. Without the flag, the snapshot is not imported. A separate private seed path and bundled mode cannot be combined.

Import is atomic and one-time per runtime state directory, refuses existing app state, and never calls messaging/AI/shop-command/payment APIs. /history renders escaped historical quotes, separate from the live feed and AI context. Catalog stock is only a new opening balance: orders, reservations, payment and dedup journals are not restored.

An ephemeral replacement loses all subsequent state on pod replacement. A new empty runtime re-imports only this fixed snapshot, resets the shop to these opening balances and creates new native identities/group. This is not ongoing backup or durable stock accounting.
