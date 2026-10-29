# JoplinU v2: per-note Yjs persistence

This implementation deliberately creates new v2 local stores. It does not migrate v1 data. Export an independent backup before installing development builds over an existing profile.

## Storage protocol

The library vault remains the authority for note IDs, folder layout, tags, settings, attachments and history. Persistent vault metadata omits note CRDT payloads. Each note has its own ordered Yjs update journal; a new note writes an initial full state. Subsequent saves encode changes against the last acknowledged Yjs state vector. A single transaction commits metadata, journal appends/deletions and the expected vault revision. Failed writes preserve in-memory edits for retry or emergency export.

Replay happens before the editor mounts. A missing or malformed note log causes loading to fail closed rather than silently creating replacement content. Electron and Android use SQLite, while browser previews use a separate IndexedDB database. Native data has SHA-256 checksums per update; SQLite uses WAL and synchronous=FULL. Android splits updates into bounded 64 KiB database records to avoid single-row CursorWindow limits.

After 32 updates or approximately 8 MiB of accumulated update bytes per note, the next changed save replaces that note's journal with one full Yjs state in the same transaction. Each note's undo stack still belongs to its live editor session; the existing explicit note-history and backup functions remain separate.

## Verification status

The branch contains Node SQLite journal tests and updates to in-memory controller test stores, but the full TypeScript, browser, Electron and Android CI suites have not been executed in this session. In particular, Android emulator and real-device Chinese IME tests remain required. This feature does not implement cloud synchronization or E2EE.

Run from `experiments/joplinu`: `npm ci --ignore-scripts`, `npm run check`, `npm run android:sync`, `npm run android:assemble`, `npm run android:test`, `npm run test:desktop`.
