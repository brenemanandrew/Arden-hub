# Modules

Two programs that already ran as their own Fly apps run here as modules of the
hub, unchanged apart from what is listed below. Each is a child process the hub
starts, supervises and reverse-proxies; each keeps its own data under the hub's
volume (`/data/stage`, `/data/pack`).

| Module | Upstream | Build | Mounted at | Child port |
|---|---|---|---|---|
| `stage/` | Staging Lane Health (`F:\Projects\Staging Lane Health`) | `64c5a53 2026-10-22` (`stage/BUILD.txt`) | `/stage/...` | 8481 |
| `pack/` | Arden Pack (`F:\Projects\Arden Pack`) | `ac3544a` | `/pack/...` | 8482 |

## Taking a new build

Replace the module's `server/` and `web/` folders with the new build's, update
`BUILD.txt`, re-apply the local change below, run `node test/test-server.js`,
push. Nothing else in the hub refers to their internals: the hub talks to them
over HTTP on localhost and rewrites the root-absolute links in their pages on
the way out.

## Local changes to upstream (keep these when updating)

- `pack/server/main.js`: `server.listen(...)` binds to `PACK_HOST` when set, so
  the child listens on 127.0.0.1 only. Upstream binds every interface.

## What the hub provides instead of the module's own

- Sign-in: the hub's PIN cookie gates every module page. The modules' own
  viewer passwords are left unset (`SLH_VIEWER_PASSWORD`, `PACK_PASSWORD`).
- Navigation: the hub injects its section bar at the top of every module page
  and hides the module's own nav links (its tools, feed pill and clock stay).
- The push doors stay the modules' own and need no hub cookie:
  `/stage/api/ingest`, `/stage/api/backup/*`, `/stage/api/feeder` (key
  `HUB_STAGE_KEY`, the same value as the host PC's cloud secret) and
  `/pack/api/drop` (key `HUB_PACK_KEY`, the same value as `pack.txt` key).
- `modules/stage/sample-data/` holds the three sample exports the upstream
  ships, used by `HUB_DEMO=1` and the tests. The WHTask sample is a copy of the
  order export (upstream's note), so picker numbers are empty in demo.
