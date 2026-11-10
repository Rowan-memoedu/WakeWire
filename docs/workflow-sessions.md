Existing SDK workflows connect through WakeWire's codex-session command. The daemon owns one private native Codex App Server per connected client. The official SDK still initializes the native server and makes thread/start, turn/start, inject, read, resume, fork, interrupt and metadata requests. WakeWire forwards native JSON-RPC without changing IDs, prompt text, images, model settings or notifications.

This interface is deliberately separate from webhook event rendering. It does not add the WakeWire event envelope, truncate fields, coalesce requests, store conversations, retry mutations or forward messages from another chat. Existing workflow receipts remain responsible for unknown-result recovery.

The client uses the SDK's public launch_args_override with these arguments:

    node <installed-dist/cli.js> codex-session --client knowledge_clipper --codex <native-codex.exe> --cwd <original-directory> --config <native-override>

The other supported client name is async_workflow. Repeat --config for each original SDK config override. Both integrations default to the installed CLI at D:/Applications/WakeWire/node_modules/wakewire/dist/cli.js and WAKEWIRE_HOME=D:/AppData/WakeWire. WAKEWIRE_NODE, WAKEWIRE_CLI and WAKEWIRE_HOME may explicitly select another installation or isolated acceptance profile; there is no direct-Codex fallback when WakeWire is unavailable.

The CLI reads the local daemon state and authenticates to ws://127.0.0.1:<state-port>/api/codex/session with the management Bearer token in a header. The setup frame uses protocolVersion=1, client, codexPath, cwd and configOverrides. After the ready acknowledgement, each WebSocket frame contains one unchanged native JSON-RPC line. Browser-origin upgrades are rejected. Only executable paths explicitly configured in sessions.codexPaths (a JSON array) are permitted. Credentials and native request/response bodies are not logged.

Client closure, including termination of the SDK's relay process, closes the owned App Server stdin and waits for exit. A five-second grace period is followed by termination of that owned child. Other sessions and the listening daemon remain running. A normal workflow may make final naming or compaction-rule requests after turn/completed; release happens when that workflow's SDK context closes, so these requests are not cut off.

GET /api/health includes workflowSessions.activeSessions. Logs record opened/released sessions, client identity, child PID and native method names only. Thread/Turn identities and all business results are read from the original workflow's durable receipts or the official native history.

Private prompt deliveries also read their original turn on the owning connection every 30 seconds while waiting for completion. This reconciles terminal states when desktop takeover loses the streamed notification; it never resumes a Thread or repeats turn/start. A terminal interrupted turn retains its original receipt and requires an explicit continuation in that same Thread. After a desktop runtime update, verify the exact resolved binary against sessions.codexPaths before reloading the idle gateway; an obsolete approved path does not authorize arbitrary replacement binaries.

On Windows, configure a separate production home, initialize the daemon, set sink.codexPath and sessions.codexPaths, then run scripts/install-windows-service.ps1 from the installed package. It registers the per-user WakeWire logon task using the existing Node runtime and a hidden background host. The task preserves the home path, uses IgnoreNew, and does not start another instance over an existing daemon.

The KnowledgeClipper connector is helpers/codex_chat.py in D:/Projects/RemNote Quick Clipper. Only its native SDK launch changes; its existing pinned runtime, instructions, images, streaming, cancellation, tabs and export contracts remain intact. The deployed helper is loaded for each request, so verified helper-only updates do not require a desktop-app restart.

The recording connector is src/async_workflow/codex_appserver.py in D:/Projects/AsyncWorkflow. Only recording command execution and exact readback opt into WakeWire. Other sdk_config consumers, including maintenance feedback and the separate command inbox, retain their existing native connection. ASR, Codex Exec content production, classification and RemNote writes are unchanged.

Run npm run typecheck, npm test, npm run lint and npm run build. Live acceptance must invoke both products' real adapters with isolated public fixtures, preserve their native receipts, verify history directly and confirm zero remaining workflow sessions. Do not append cross-chat diagnostic messages to creation samples. Deployment and local-source alignment evidence belongs in D:/Artifacts/WakeWireIntegration, never in the source repository.
