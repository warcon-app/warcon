<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/warcon-logo-on-dark.svg">
    <img src="branding/warcon-logo-on-light.svg" alt="Warcon" height="72">
  </picture>
</p>

# Warcon

A self-hostable, multi-server RCON panel for **WARDOGS** dedicated servers. Bun, SvelteKit and
Postgres/TimescaleDB, deployed with Docker Compose. Run it beside your game server, on any VPS, or
on a container host, with the database wherever you like.

- **Multiple servers** in one panel, each with its own encrypted RCON password.
- **User access management**: owner and member accounts (Better Auth); per-server `viewer` /
  `operator` / `admin` roles; password resets, forced password change, disable, session
  revocation, login throttling, optional "Sign in with Discord" for linked accounts.
- **Full audit trail**: every login, user or server change, and every game-server command, with
  actor, server, target, outcome, upstream status, IP and duration. Filterable and exportable
  (CSV/JSON). The game server's own listener log is shown alongside it.
- **Analytics**: a background poller samples every server and keeps what the game does not:
  players online over time, uptime, time per map, busiest hours, player playtime and sessions,
  match history with results.
- **Everything the official console does**: status, scoreboard, kick/ban/kill/whisper/change-team,
  broadcasts, map override, next map, end/restart match, map rotation editing and saving, reserved
  slots, bans, score tick, sponsor image, and the full `ServerSettings.ini` config document with
  validate/apply and revision conflict handling.
- **Demo mode**: a built-in mock game server so you can try everything before pointing it at a real one.

The protocol was reverse-engineered from `rcon.wardogs.com`; see [docs/wardogs-api.md](docs/wardogs-api.md).

Running a public server? Add it to [wardogservers.com](https://wardogservers.com) so players can find it in
the community server list.

## Screenshots

Taken against the built-in demo server, so the numbers are synthetic.

![Server overview: scores, match control and scoreboard](docs/screenshots/server-overview.png)

| Analytics                                                                     | Players, reserved slots and bans             |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| ![Analytics: players online, uptime, matches](docs/screenshots/analytics.png) | ![Players tab](docs/screenshots/players.png) |

| Audit trail                                                        | Map rotation                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| ![Audit trail with filters and export](docs/screenshots/audit.png) | ![Map rotation editor](docs/screenshots/rotation.png) |

| Configuration                                                                    | Game server log                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ![Score tick, sponsor image and ServerSettings.ini](docs/screenshots/config.png) | ![The game server's own RCON listener log](docs/screenshots/log.png) |

| Users and access                              | Servers                                  |
| --------------------------------------------- | ---------------------------------------- |
| ![Users & Access](docs/screenshots/users.png) | ![Servers](docs/screenshots/servers.png) |

More in [docs/screenshots/](docs/screenshots/): the [dashboard](docs/screenshots/dashboard.png), [time per map and most active players](docs/screenshots/analytics-2.png), and the [sign-in page](docs/screenshots/sign-in.png).

## How it works

```
browser ──HTTPS──▶ Warcon (Bun + SvelteKit) ──HTTP──▶ game server :7776 (WDRCON)
                     │  server-rendered pages, /api/* JSON, /api/auth/* (Better Auth)
                     │  poller: status + players every POLL_SECONDS → samples, sessions, matches
                     └─ Postgres (Drizzle schema; TimescaleDB hypertable + retention for samples)
```

The official console calls the game server straight from the browser over plain HTTP, so it cannot
be hosted on HTTPS and every admin needs the raw RCON password. Warcon keeps the password
server-side (AES-GCM encrypted), authenticates admins with its own accounts, checks the role for
every action, and writes an audit row before answering.

## Deploy with Docker

New to this? [docs/getting-started.md](docs/getting-started.md) walks through it step by step.

Prerequisites: Docker with Compose.

```bash
git clone <this repo> warcon && cd warcon
cp .env.example .env
# edit .env: set BETTER_AUTH_SECRET and ENCRYPTION_KEY to `openssl rand -base64 32` values,
#            POSTGRES_PASSWORD, and ORIGIN to the URL people will open (http://<host>:3000, or your https domain)
docker compose up -d
```

Compose starts two containers: `warcon` and `db` (TimescaleDB). To use an external Postgres
instead, remove the `db` service and set `DATABASE_URL` in `.env`; install the `timescaledb`
extension there if you want automatic retention on the analytics samples (plain Postgres works too,
the app prunes old samples itself).

Open the URL. The first visit shows the **owner setup** form; after that it is a normal login. Then,
as owner:

1. **Servers → Add server**: name, host, port, scheme, RCON password. Use **Test** to check reach.
2. **Users & Access → Add user**, then **Access** to grant `viewer` / `operator` / `admin` per server.

The database lives in the `warcon-db` volume; back it up with `pg_dump`. Migrations apply
automatically when Warcon starts. Keep `ENCRYPTION_KEY` safe: losing it means re-entering every
server's RCON password. Never change it after servers are added unless you intend to re-enter them.

### Behind a reverse proxy or Cloudflare

Put Caddy, nginx, Traefik, or a Cloudflare Tunnel in front of port 3000 for TLS, then set in `.env`:

```
ORIGIN=https://rcon.example.com   # cookies become Secure, redirects and form posts use this
ADDRESS_HEADER=x-forwarded-for    # the header your proxy puts the client IP in; XFF_DEPTH=1 (default) reads the last hop it appended
```

`ADDRESS_HEADER` and `XFF_DEPTH` are read by SvelteKit's Node adapter, which resolves the client
address for the audit trail and login throttling. Use `x-real-ip` for nginx, `x-forwarded-for` for
Caddy and Traefik, `cf-connecting-ip` for a Cloudflare Tunnel. Only set it when the proxy is the only
way to reach the port; otherwise anyone can spoof the recorded IP.

### Configuration (`.env`)

| Var                                           | Default            | Meaning                                                                                                   |
| --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                          | required           | Session signing secret.                                                                                   |
| `ENCRYPTION_KEY`                              | required           | Base64 of 32 random bytes; encrypts stored RCON passwords.                                                |
| `DATABASE_URL`                                | set by Compose     | `postgres://user:pass@host:5432/warcon`.                                                                  |
| `POSTGRES_PASSWORD`                           | `warcon`           | Password for the bundled `db` service (Compose only).                                                     |
| `ORIGIN`                                      | required           | The exact URL people open (scheme, host, port).                                                           |
| `ADDRESS_HEADER` / `XFF_DEPTH`                | unset / `1`        | Behind a proxy: the header carrying the client IP (see above).                                            |
| `PORT` / `HOST`                               | `3000` / `0.0.0.0` | Listen address.                                                                                           |
| `POLL_SECONDS`                                | `20`               | Analytics sampling interval per server; `0` disables the poller.                                          |
| `APP_NAME`                                    | `Warcon`           | Name shown in the UI.                                                                                     |
| `AUDIT_LOG_READS`                             | `false`            | Also audit read-only calls (status polls etc.). Noisy.                                                    |
| `ALLOW_DEMO_SERVER`                           | `true`             | Allow a server with host `demo` served by the built-in mock.                                              |
| `GAME_TLS_INSECURE`                           | `false`            | Accept self-signed certificates on `https` game servers.                                                  |
| `SETUP_TOKEN`                                 | unset              | When set, first-run setup requires it.                                                                    |
| `STEAM_API_KEY`                               | unset              | Steam persona/avatar lookup.                                                                              |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | unset              | "Sign in with Discord" for accounts that linked it. OAuth redirect: `<ORIGIN>/api/auth/callback/discord`. |

### Roles

|                                                                                                                        | viewer | operator | admin | owner |
| ---------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ----- | ----- |
| status, players, rotation, bans, reserved, config (read), server log, analytics                                        | ✓      | ✓        | ✓     | ✓     |
| broadcast, whisper, kick, kill, change team, end/restart match, change map, next map, live rotation edits              |        | ✓        | ✓     | ✓     |
| ban/unban, reserved slots, score tick, rotation mode/enable, save rotation, sponsor image, config apply, raw /v1 calls |        |          | ✓     | ✓     |
| manage users, servers and access; see the whole audit trail                                                            |        |          |       | ✓     |

Members see the audit trail for their own actions plus everything on servers where they are admin.

### Reaching the game server

Warcon talks to the game's RCON listener over HTTP from its own process, so the panel can run
anywhere that can reach `Port` (default 7776) on each game host. Enable the listener in
`ServerSettings.ini` under `[/Script/WDRCON.WDRCONSettings]`, then connect however suits your setup:

- **Direct.** Set `BindAddress=0.0.0.0` (or the host's public address) and add the server in Warcon
  with scheme `http`. Restrict the port to Warcon's IP in whatever firewall the game host already
  has: the hosting provider's panel, `ufw`, a cloud security group. The RCON password is sent as a
  bearer token on every request, so the firewall is what keeps it private.
- **Private network.** Over WireGuard, Tailscale, or a provider LAN, bind the listener to the
  private address and use plain `http`.
- **TLS proxy on the game host.** Keep `BindAddress=127.0.0.1` and put Caddy (or nginx) in front of
  it; add the server with scheme `https` and port `443`. Caddy fetches a certificate for a public
  DNS name by itself.

      rcon.game1.example.com {
          reverse_proxy 127.0.0.1:7776
      }

  For a self-signed certificate set `GAME_TLS_INSECURE=true`. This applies to every `https` server,
  not just the one that needs it.

- **Same host as the game server.** Keep `BindAddress=127.0.0.1`. From Compose, uncomment the
  `extra_hosts` line in `docker-compose.yml` and use host `host.docker.internal`, or run the
  container with `network_mode: host`.

The ini comments say a non-loopback `BindAddress` expects TLS and `PasswordHash=`; the official web
console connects over plain `http` regardless, and so can Warcon.

## Local development

Prerequisites: [Bun](https://bun.sh) 1.2+ and a Postgres (the TimescaleDB image is easiest).

```bash
bun install
docker run -d --name warcon-pg -p 5432:5432 -e POSTGRES_USER=warcon -e POSTGRES_PASSWORD=warcon \
  -e POSTGRES_DB=warcon timescale/timescaledb:latest-pg17
cp .env.example .env      # set the two secrets, ORIGIN=http://localhost:5173, DATABASE_URL=postgres://warcon:warcon@127.0.0.1:5432/warcon
bun run dev               # http://localhost:5173
bun run check             # svelte-check
bun run build && bun run start   # production build, http://localhost:3000 (set ORIGIN to match)
```

The schema is defined in [src/lib/server/db/schema.ts](src/lib/server/db/schema.ts). After changing
it, run `bun run db:generate` to write a new migration into `drizzle/`; the app applies pending
migrations at startup. Add a server with host `demo`, port `1`, password `demo` to use the mock game
server.

## Layout

```
src/hooks.server.ts            startup (migrations, poller), session lookup, Better Auth handler, CSRF header check
src/lib/server/env.ts          process config + the database connection
src/lib/server/db/schema.ts    every table, as Drizzle definitions (source of truth for migrations)
src/lib/server/db/index.ts     Bun SQL client + Drizzle + migration runner
drizzle/                       generated SQL migrations (bun run db:generate) + TimescaleDB setup
src/lib/server/auth.ts         Better Auth config (username + admin plugins, Drizzle adapter)
src/lib/server/access.ts       global/per-server roles, accessible servers, login throttling
src/lib/server/users.ts        account management on top of Better Auth (create, disable, reset, grants)
src/lib/server/servers.ts      server records, reachability test, per-server grants
src/lib/server/actions.ts      every panel action -> role level + /v1 call(s)
src/lib/server/rcon-run.ts     /api/servers/:id/rcon/:action dispatcher with audit rows
src/lib/server/rcon.ts         WardogsClient (Bearer auth, JSON/text calls, demo routing)
src/lib/server/transport.ts    fetch to the game server
src/lib/server/poller.ts       background sampler (leader-elected via advisory lock): samples, sessions, matches
src/lib/server/analytics.ts    analytics queries per server and range
src/lib/server/audit.ts        audit writer/query with secret redaction
src/lib/server/mockgame.ts     in-process imitation of the WDRCON API for demo/testing
src/lib/components/            Modal, MapPicker, PopulationChart, Toasts, badges…
src/routes/(auth)/             /sign-in, /setup (form actions)     src/routes/sign-out
src/routes/(app)/              dashboard, /server/[id]/{,players,rotation,config,analytics,log}, /audit, /users, /servers, /account
src/routes/api/                JSON API (below)
docs/wardogs-api.md            the reverse-engineered game-server API
```

### API cheatsheet

All `/api` calls need the session cookie; mutations also need `X-Requested-With: warcon`.
Sign-in, setup, password change and session revocation are SvelteKit form actions on their pages;
`/api/auth/*` is Better Auth's own endpoint set (public sign-up is disabled).

```
GET/POST /api/users  PATCH/DELETE /api/users/:id  PUT /api/users/:id/grants {grants:[{serverId,role}]}
GET/POST /api/servers  PATCH/DELETE /api/servers/:id  POST /api/servers/:id/test
GET/PUT /api/servers/:id/grants {grants:[{userId,role}]}   GET /api/servers/:id/summary
GET|POST /api/servers/:id/rcon/:action   (GET for reads with query params, POST JSON for mutations)
GET  /api/servers/:id/analytics?range=24h|7d|30d
GET  /api/actions                     lists actions with their role level
GET  /api/audit?server=&actor=&action=&outcome=&q=&from=&to=&before=&limit=
GET  /api/audit/export?format=csv|json GET /api/audit/meta
GET  /api/steam/profiles?ids=a,b      GET /api/health
```

Actions: `capabilities status players maps lightings experiences alternators catalog rotation bans
reserved sponsor serverLog config` (viewer) · `broadcast whisper kick kill changeTeam endMatch
restartMatch changeMap setWeather setNextMap rotationAdd rotationRemove rotationMove rotationReorder`
(operator) · `ban unban reservedAdd reservedRemove rotationSave settings setSponsor configValidate
configApply raw` (admin).

## Notes and limits

- Analytics are derived from polling: player sessions are accurate to one interval, and match
  boundaries are inferred from the match clock and map changes. Samples are kept for 90 days
  (a TimescaleDB retention policy, or the poller's own prune on plain Postgres), sessions and
  matches for a year.
- Several Warcon replicas can share one database; a Postgres advisory lock makes exactly one of
  them the poller.
- Password hashing is Better Auth's default scrypt, which runs natively via `node:crypto` on Bun.
- Sessions are looked up in the database on every request (no cookie cache), so disabling a user
  or revoking a session takes effect immediately.
- Discord sign-in never creates accounts: a user links Discord from their Account page first.
- The demo server's state lives in process memory and resets on restart.
- Audit rows are never deleted by the panel. Prune them with SQL if you need to.
