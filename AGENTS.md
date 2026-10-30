# WakeWire

- This private maintenance fork owns webhook delivery and native SDK session transport; Codex owns all Thread history and execution.
- Read docs/workflow-sessions.md before changing either connected workflow. Preserve raw JSON-RPC, original prompts, rich inputs, native identities and unknown-result behavior.
- Source is D:/Projects/WakeWire; installed package is D:/Applications/WakeWire; production home is D:/AppData/WakeWire; acceptance material is D:/Artifacts/WakeWireIntegration.
- One private App Server belongs to one workflow SDK connection. Closing it must not terminate another workflow or a shared/proxy server.
- No direct fallback, mutation replay, alternate Thread store or cross-chat message injection.
- Keep credentials, source payloads, native responses, local state and artifacts out of Git. Logs contain method names and process/session metadata only.
- Validate with npm run typecheck, npm test, npm run lint, npm run build and isolated real adapters. Align source, package, installed files and running daemon.
- Windows task installation uses scripts/install-windows-service.ps1. Background service restarts are permitted within deployment; do not restart the user's desktop apps.
