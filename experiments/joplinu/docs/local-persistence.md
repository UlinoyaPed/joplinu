# Local Yjs persistence — experimental patch

This patch is based on PR #1 HEAD 7aa07642. It is an incremental safety fix, **not** completion of phase 2 or an acceptance claim for Android hardware.

- `PersistedNote.open` reads every stored Yjs update before constructing UndoManager and before mounting any editor.
- On a fresh document it durably stores the initial Yjs update. Subsequent local, undo, redo and merged updates are appended immediately, serially, without transforming Markdown.
- Electron renderer has no Node/SQLite access: a sandboxed preload exposes narrow IPC methods, validated by main-process code; SQLite stores the ordered journal in application userData using WAL and FULL sync.
- Android registers a Capacitor Kotlin bridge backed by private SQLite with transactions and checksum validation.
- Vite/browser test harness stores the same ordered updates in IndexedDB. IndexedDB durability differs from SQLite and browser storage may be evicted.
- Each record includes SHA-256 checksum. Recovery failures are fail-closed: no sample content is loaded over unreadable records.
- Write failures preserve unacknowledged in-memory updates and expose Retry / Emergency export.
- This iteration preserves live-session UndoManager; undo history is **not** persisted across restarts.
- No compaction, migrations, backup/restore UX, multi-window service, cloud synchronization, or E2EE.

## Validation (do not claim as passed without actually executing)

```bash
cd experiments/joplinu
npm ci --ignore-scripts
npm run build
npm test
npm run test:packaging
npm run test:browser
npm run test:production
npm run android:sync
npm run android:assemble
npm run desktop:package
npm run test:desktop
```

Manual acceptance:
1. On a fresh installation edit source text with Chinese, emoji, CRLF, trailing whitespace, math, fenced code, and opaque extensions; test all four views and Undo/Redo.
2. Wait for “已保存至本地”; completely quit, relaunch, and export. Compare exact UTF-8 contents with previous export.
3. Edit, abruptly kill the process, relaunch; compare last **acknowledged** saved content (unacknowledged updates may be lost). Inspect the SQLite file and journal.
4. Simulate ENOSPC / SQLite busy / database corruption: failure banner must appear, emergency export must work, and restart must refuse to seed sample text.
5. On Android hardware use two actual Chinese IMEs; repeat with Home/background/force-stop/rotation and abrupt termination. CI APK compilation does not prove lifecycle or hardware readiness.
6. Run existing four-mode / undo / roundtrip / unknown-syntax browser checks in isolated browser profiles, and test persistence reload separately.

Known limitation: JoplinU prototype presently has a single fixed document ID. There is no durable notebook index, retention/compaction or full history browser. Large journals can slow startup; controlled compaction and long-document profiling belong to a later phase.
