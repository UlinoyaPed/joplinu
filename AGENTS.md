# JoplinU development

The active application is the independent npm workspace in `experiments/joplinu`. The old root Yarn workspace and `packages/app-*` are reference source, not the JoplinU build targets. Preserve licenses and user data.

- Use strict TypeScript and keep document, editor, platform, storage and cryptography boundaries explicit.
- Run `npm run check` in `experiments/joplinu` for web, core, packaging-helper and browser checks. Read `docs/builds.md` there for native builds.
- Native targets are Electron Linux RPM and Capacitor/Kotlin Android APK. Validate real build artifacts and report untested platform behavior explicitly.
- Never commit keystores, private keys, signing passwords, cloud credentials or generated build output. Signing belongs to scoped GitHub Secrets and temporary files.
- Keep PRs free of inherited Joplin title/CLA/issue-number requirements. No auto-close or auto-merge bots.
- The full document-model gate is still open. Do not claim real OSS/S3 sync, synchronization E2EE or Android IME acceptance until implemented and tested. Keep desktop SQLite, Android instrumentation and real-device evidence distinct.
