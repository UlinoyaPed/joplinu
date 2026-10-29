# JoplinU development

The active application is the independent npm workspace in `experiments/joplinu`. The old root Yarn workspace and `packages/app-*` are reference source, not the JoplinU build targets. Preserve licenses and user data.

- Use strict TypeScript and keep document, editor, platform, storage and cryptography boundaries explicit.
- Run `npm run check` in `experiments/joplinu` for web, core, packaging-helper and browser checks. Read `docs/builds.md` there for native builds.
- Native targets are Electron Linux RPM and Capacitor/Kotlin Android APK. Validate real build artifacts and report untested platform behavior explicitly.
- Never commit keystores, private keys, signing passwords, cloud credentials or generated build output. Signing belongs to scoped GitHub Secrets and temporary files.
- Push reviewable commits directly to `dev` as requested by the user. Do not create or use PRs. Keep inherited Joplin title/CLA/issue-number rules and auto-close / auto-merge bots removed.
- The full document-model gate is still open. Do not claim real OSS/S3 sync, synchronization E2EE or Android IME acceptance until implemented and tested. Keep desktop SQLite, Android instrumentation and real-device evidence distinct.

- Product goal (2026-10-29): cover most everyday Joplin capabilities and improve editing. Joplin database, sync protocol, plugins and historical architecture are not compatibility targets. Better internal designs and deliberate format changes are permitted; protect actual user data and document migrations.
- Prefer useful features and focused validation over proliferating tests. Run required existing checks; add only tests that protect meaningful behavior or data safety.
