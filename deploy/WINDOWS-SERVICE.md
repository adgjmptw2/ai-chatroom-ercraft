# Windows-managed chatroom — 2026-10-08

Explicitly authorized by the user to replace temporary Codex-session hosting.
This supersedes the foreground-only/no-scheduled-task deployment restriction for
this Windows installation. No chat application code or credentials are replaced.

Task: `ERCraft AI Chatroom`. Runs hidden as the current Windows user at logon;
requires that user's logged-on session for existing provider CLI credentials.
It is independent of Codex. It does not promise operation after Windows logout,
while the machine sleeps, or before the first login following a reboot.

The PowerShell launcher holds a singleton mutex and waits for the Node host.
Node retains the existing supervised child and IPC graceful-shutdown contract.
Five bounded child restart attempts remain; exhaustion closes the owner before
the host fails. Task Scheduler retries host failure three times, one minute apart.
No execution time limit or battery-triggered stop. No forced termination.

Old ownership records are archived only after verifying absent owners/children
and listeners; PID ambiguity fails closed. Previous-boot PIDs are not identities.
Existing data, desired running state, configuration and provider logins survive.

Health/state/exit metadata: `data/.service-runtime/windows-host.jsonl`, one MiB
plus one rotated file. Heartbeat once per minute. Child stdout/stderr, credentials,
model messages and owner capabilities are not logged. Launcher failures have a
separate bounded `windows-launcher.jsonl`. Host termination with no final event
can be correlated with missing heartbeat and Task Scheduler history; it does not
by itself prove a particular external kill source.

Status: `node scripts/service.mjs status`

Graceful maintenance stop: disable the task first, then run
`node scripts/service.mjs stop`; wait until status is offline and the host exits.
Never use Stop-ScheduledTask or force-kill to simulate a clean drain.

Resume: enable the task and Start-ScheduledTask -TaskName 'ERCraft AI Chatroom'.
Rollback: disable the task, gracefully stop and wait; then use the original
foreground `node scripts/service.mjs run` if required. Preserve the new files/logs.
