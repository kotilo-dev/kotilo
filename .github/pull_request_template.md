## Summary

<!-- What does this change and why? Link the issue: Fixes #123 -->

## Tests run

<!-- Commands you ran and their result, e.g. cargo test --workspace, dotnet test hub/AgentHub.sln, npm --prefix apps/desktop test, npm --prefix apps/desktop run e2e -->

## Checklist

- [ ] Builds and the relevant tests pass; `cargo clippy --workspace --all-targets -- -D warnings` is clean (if Rust changed)
- [ ] New or changed behavior has tests (parsers, state mappings and config mergers with fixtures)
- [ ] No vendor names or logos in branding, product identity or icons
- [ ] Does not read, copy, store or transmit any agent credentials or token files; AI keys only in the credential vault
- [ ] Agent config files are changed only through backup-first mergers, own entries only; tests use temp directories
- [ ] No prompt, response or audio content written to the database or logs
- [ ] Tests send no global input (hotkeys, keystrokes, clipboard, sounds) to the desktop
- [ ] Platform-specific code stays in the platform layer
- [ ] No proprietary or employer-internal code; new dependencies are Apache-2.0 compatible and `THIRD_PARTY_NOTICES` is regenerated
- [ ] UI strings are in the i18n files (English and Turkish); colors use design tokens
- [ ] I agree that this contribution is licensed under Apache-2.0

## Screenshots

<!-- For UI changes: before/after screenshots (Playwright screenshots are fine). -->
