AI CHATROOM: FOREGROUND SUPERVISION AND OFFLINE CRITICAL-DATA BACKUPS

Integration only. Nothing here installs, activates, deploys, schedules, calls a
model, changes config, or changes ERCraft hosting. Requires Node 22 or newer.
The parent owns server.mjs, config, graceful shutdown, routing, and activation.

Start and local control

  node scripts/service.mjs run
  node scripts/service.mjs status
  node scripts/service.mjs stop

Run is a persistent foreground Node entrypoint. Keep its exec/session retained.
Do not detach, unref, use cmd start, create a scheduled task, or close the owning
session to stop Windows processes. Use stop and wait for the retained run process
to exit. Stop's reply acknowledges the request; it does NOT assert child exit.
Poll status until offline or await the retained process. A stop-timeout means the
child remains owned and the supervisor remains available; it is not safe to start
another child or take a backup. No forced process/tree termination is implemented.

The same --home PATH (or CHATROOM_HOME) identifies the instance for every command.
Run/backup accept --config PATH (or CHATROOM_CONFIG). The default application root
is the repository containing scripts/service.mjs. The child's HOME and optional
config overrides are passed explicitly; persisted data is never reset.

Reusable exports from lib/service-runtime.mjs

  startSupervisor({ root, home = root, configFile, entry, childArgs, env, policy })
    -> ServiceSupervisor with status(), stop(reason), done, and 'status' events.
  controlService({ home, action: 'status' | 'stop', timeoutMs = 5000 })
  acquireServiceLock(home), servicePaths(home), restartDelay(attempt, policy)
  backupSnapshot({ root, home = root, configFile, childStopped: true,
                   backupDir, extraDataPaths, maxSnapshots, maxBytes, maxFiles })
  verifySnapshot({ snapshotPath, maxBytes, maxFiles })
  restoreSnapshot({ snapshotPath, destination, maxBytes, maxFiles })

When the entrypoint is forked with Node IPC, the retained parent may send
{type:'service:status',requestId} and receive {type:'service:status',requestId,status}.
{type:'shutdown'} or {type:'service:stop'} requests graceful service stop. Status
events are also sent through Node IPC. Owner IPC disconnect requests graceful stop.

EXACT CHILD CONTRACT REQUIRED BEFORE ACTIVATION

1. Read CHATROOM_SERVICE_INSTANCE and CHATROOM_SERVICE_SUPERVISOR from the child's
   environment. They are fresh random identities, not credentials or saved state.
   After successfully listening and loading persisted state, send:
   {type:'service:ready',protocol:1,instanceId:process.env.CHATROOM_SERVICE_INSTANCE,
    pid:process.pid}

2. On process message {type:'service:health',requestId,instanceId}, validate the
   instance and reply through process.send, without model calls or state changes:
   {type:'service:health',requestId,instanceId,pid:process.pid,ready:true,
    roomRunning:room.running}
   This is the health hook. No unauthenticated HTTP control/health route is needed.

3. On {type:'shutdown',requestId,instanceId,preserveDesiredState:true,reason},
   validate the instance, reject new mutations, stop timers and new model work,
   drain or cooperatively cancel owned work, close listeners/SSE and managed
   subprocesses, flush delayed world saves plus state/plans/messages/meta/notes/
   topic writes, and exit 0 only after durable flushes complete. Preserve the
   saved desired running and sleep flags. Do not implement this by setting saved
   room.running=false or invoking a room-off action. Shutdown must be idempotent.
   The supervisor never edits the desired flags; crash restarts reload the latest
   persisted state. Parent handles any repair of interrupted planner operations.

4. A supervised child must gracefully shut down on process 'disconnect', using
   the same preserve-desired-state path, so supervisor loss cannot leave an
   unmanaged server. Child-owned subprocesses need cooperative lifetime handling.
   Do not call process.kill/taskkill to force a Windows process tree.

Policy and identity

Defaults: 5 automatic restarts in the lifetime of this supervisor, with delays
1, 2, 4, 8, 16 seconds (exponential helper capped at 30 seconds). Successful health
does not replenish the lifetime budget. Nonzero exits/signals restart; ordinary
exit 0 does not. A readiness/health failure requests cooperative shutdown first
and may restart only after child exit, even if that exit is 0. Readiness timeout
is 60 seconds; health interval 15 seconds and timeout 10 seconds; stop deadline
30 seconds. Never restart a still-live or still-draining child. Exhausted and
normally stopped supervisors remain controllable until explicit stop closes them.
Programmatic policy overrides are bounded; the CLI deliberately has no restart-
forever or force-kill switch. Child stdout/stderr are ignored to avoid accidental
credential logging; the entrypoint emits only sanitized lifecycle metadata.

data/.service-runtime/owner.json is an exclusive wx-created lock containing the
supervisor identity/start timestamp, PID, random control capability, local
control port and current child's PID/generation identity. Loopback-only TCP
control uses the capability plus instance ID;
it exposes status/stop only. Child PID plus a separate random generation identity
is checked on every health response. A reused PID never authorizes lock takeover.
Concurrent runs and offline backups share this lock. A stale lock is deliberately
not automatically stolen: the parent must establish that BOTH supervisor and
child (and owned work) have stopped before manually removing only that stale
owner record. No lock owner is killed. This lock cannot prevent someone from
bypassing the entrypoint with node server.mjs; parent must stop any legacy server
before activation or offline backup. Source config updates must also be quiescent.

Offline backup and restore verification

  node scripts/service.mjs stop
  (wait for the retained run process to exit, or status to report offline)
  node scripts/service.mjs backup --offline
  node scripts/service.mjs verify --snapshot ABSOLUTE_SNAPSHOT_DIRECTORY
  node scripts/service.mjs restore --snapshot ABSOLUTE_SNAPSHOT_DIRECTORY --destination NEW_DIRECTORY
  node scripts/service.mjs run

Use this explicit sequence for deployment/startup or stop-backup-restart. There
is no periodic backup and no running-room checkpoint shortcut. --offline asserts
that all child processes and other writers are stopped; it does not stop them.
The worker acquires the same service lock for the complete copy and verification,
so a managed run cannot start mid-snapshot. Copy/hash work runs in a joined Node
worker thread, not on the caller's event loop. Snapshot creation is never a
precondition for service start/recovery: a low-disk backup refusal cannot block
the run command or crash restarts. Never terminate a worker mid-copy.

Required: the selected config file (stored as config.json) and data/state.json.
Copied when present: application-root .env; data/world.json, world-plans.json,
messages.jsonl, workspace-meta.json, notes recursively, image-aliases.json,
admin-auth.json, admin-password.txt, usage.jsonl, hive-usage.jsonl; any data root
file/directory named topic or topics or starting with topic-, topic_, topic.
(and plural equivalents), recursively. Add other topic locations with extraDataPaths entries
such as 'data/conversation-topics.json'. Optional absences are recorded privately.

Scope is explicitly critical data ONLY. workspace, existing images, public/assets,
assets, runtime dependencies, source code and operational logs are not copied.
Keep those existing image/assets directories intact; the snapshot alone cannot
restore a lost disk. No hardlinks are created. Source files that already have
hardlinks are read only and copied to independent new files. Symlinks and Windows
junctions, including ancestors, are rejected. Original/shared targets are never
written, chmodded, renamed, deleted, or rotated.

Snapshots go to backups/service by default. Limits: 3 snapshots (including failed
.pending attempts), 256 MiB source bytes, 5000 files, bounded recursion. Capacity
refuses new snapshots; it never deletes old copies. Copy/restore checks free space
before writing and between files, budgeting next output, allocation overhead and
4 MiB metadata, while
retaining at least 15 GiB free (also on C: when Windows destination is elsewhere).
No cleanup or scheduled tasks are created. Failed partial copies are retained in
their bounded slot for investigation, never published as successful snapshots.

Each copied file is fsynced, source sizes/identity/mtime and SHA-256 are rechecked,
and copied hashes are verified before atomic directory publication. A private
manifest records paths, byte lengths, hashes, scope and optional missing files;
its digest detects accidental manifest corruption. Digests are integrity checks,
not signatures against an attacker able to rewrite the snapshot and digest.
Receipts/status never include secrets, file hashes, or manifest contents. Keep
backups, restored staging, .env and service lock outside public file serving and
source control. POSIX new files/directories use 0600/0700. On Windows, the dedicated
control directory and each NEW snapshot/restore directory receive protected ACLs
granting only the current user and LocalSystem access, before writing sensitive
files. The built-in PowerShell helper runs hidden and is awaited; ACL failure
refuses the operation. Child folders/files inherit those private ACLs. Existing
source data and images are never repermissioned. Choose a backup parent directory
that other users cannot replace or delete. No credential contents are read into
process arguments or printed.

Restore verifies the entire snapshot first, creates a NEW destination, copies
and rehashes each file, and refuses every existing destination. It never restores
in place or overwrites authoritative data. Parent reviews staged restored files,
handles config-path mapping, keeps matching assets/images, and owns any later
promotion while offline. No promotion is implemented here.

Existing host subpath and TLS

deploy/Caddyfile.example is unactivated and uses example.invalid. Merge only the
/chat routes into the EXISTING HTTPS site block, preserving its other routes.
The app must bind 127.0.0.1:8321, have basePath=/chat, publicOrigin set to the exact
https://existing-host origin, and matching administrator allowed origins. Root
local app behavior remains the parent's default when basePath is unset.

/chat redirects to /chat/; only /chat/* proxies to the app. /chat/api/dev and its
prefix variants return 404 before proxying. The upstream sees /chat unchanged;
the app strips its configured prefix. Origin and Host are preserved; the proxy
overwrites X-Forwarded-Prefix with /chat. SSE uses flush_interval -1. TLS uses the
real existing host's certificate automation when separately configured. Do not
substitute handle_path or rewrite Origin, and do not add a catch-all app proxy.

Optional client identity for clients connecting DIRECTLY to Caddy: the example
strips CF-Connecting-IP and X-Chatroom-Proxy-Token by default. To enable individual
client accounting, replace BOTH deletion lines with the TWO commented header_up
assignments: overwrite CF-Connecting-IP with {http.request.remote.host}, the actual
socket peer, and overwrite X-Chatroom-Proxy-Token with {$CHATROOM_PROXY_TOKEN}.
Provision the same random secret of at least 32 characters in Caddy's environment
and the Node service environment, without putting its value in this example,
command arguments, output, access logs, or source control. Parent clientAddress
trusts that identity only for a loopback proxy with a matching configured token.
Without a valid token/identity, the safe default aggregates proxy traffic under
the same per-address cap of 128; it does not grant unlimited proxy clients.

This DIRECT-CADDY example is not a Cloudflare trust-chain configuration. Behind
Cloudflare, the actual Caddy socket peer is a Cloudflare edge; this optional mode
therefore groups users by edge address. Do not pass through arbitrary inbound
CF-Connecting-IP or change this to blindly trust X-Forwarded-For. Real Cloudflare
client attribution requires separately verified trusted edge peers and protected
origin access, with sanitized forwarded identity and the shared app token.

If an existing CDN, Pages site, or Worker currently serves the hostname, it must
separately route /chat and /chat/* to this reachable origin and preserve streaming,
Host/Origin and cookies. Installing a Caddy snippet alone does not create that
edge route, publish an origin, open firewall ports, or change ERCraft hosting.
The exact live ERCraft hostname and its Pages/Worker /chat route are still pending;
example.invalid does not assert ownership or activation of any ercraft.net route.
Before activation parent validates proxy path normalization and external /api/dev
denial (including encoded/case variants) end-to-end with the actual edge and app.
Official references: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
and https://caddyserver.com/docs/caddyfile/matchers

Validation (synthetic temporary homes only; no server.mjs/model invocation)

  node --test tests/service-runtime.test.mjs

Tests exercise lossless snapshot/restore, corruption, scope, private receipts,
disk/capacity limits, hardlinks/junctions, lock identity, status authorization,
crash budgets/backoff, stop during backoff, normal exit, cooperative stop timeout,
readiness/health failures, and persisted running/sleep flags.
