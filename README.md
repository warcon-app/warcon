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
- **Organisations and invite links**: each clan or community is an organisation with its own
  servers, owners and members. An owner pastes an invite link into their Discord; whoever opens it
  signs in with Discord (creating their account on the spot) and joins with the roles the link
  carries. Per-server `viewer` / `operator` / `admin` roles on top.
- **Account management**: Better Auth accounts; password resets, forced password change, disable,
  session revocation, login throttling.
- **Full audit trail**: every login, user or server change, and every game-server command, with
  actor, server, target, outcome, upstream status, IP and duration. Filterable and exportable
  (CSV/JSON). The game server's own listener log is shown alongside it.
- **Live view**: a worker process watches every server on a cadence that follows what is
  happening: every second or two while someone has it open or people are on it, every half
  minute when it is empty. Pages get each observation as it happens over an event stream, and a
  command you send shows its effect on the next look. Browsers never talk to a game server.
- **Analytics**: the worker keeps what the game does not: players online over time, cash in play
  per faction, uptime, time per map, busiest hours, player playtime and sessions, match history
  with results. Samples are written when something changes plus a heartbeat, and every figure is
  duration-weighted, so a faster cadence never distorts them.
- **Player dossiers**: click any player for their history across the organisation's servers
  (sessions, playtime, names used, K/D), the admin actions taken on them, shared notes and a
  watchlist, and, with a Steam key, their Steam persona, account age and VAC / game-ban record.
- **Connect-time risk**: an advisory score from the Steam Web API, bans on the org's other
  servers, lookalike names of banned players and the watchlist, shown next to each connected
  player. It sees what RCON exposes and nothing more: no aim, position or input telemetry.
- **Automation**: per-server triggers the worker evaluates on every observation, so a welcome
  whisper or a risk kick lands within a couple of seconds of the join. Every action goes through
  an outbox and is recorded as delivered, failed, skipped or unknown, and survives a restart in
  between. Each rule is dry-runnable against the last 24 hours before it is switched on: welcome
  whisper on join, scheduled broadcasts, empty-server map reset, and kick-on-connect for VAC bans,
  brand-new accounts or bans elsewhere in the org.
- **Organisation ban and reserved lists**: ban a player across every server in the organisation
  at once, with a reason and an optional expiry; hand out reserved slots the same way. The worker
  keeps every server in line and shows where each entry stands; bans added outside the panel are
  left alone.
- **Discord mirror**: an org owner points a channel webhook at the audit trail and picks what to
  mirror (bans, commands, trigger actions, sign-ins…), per server if wanted.
- **Everything the official console does**: status, scoreboard, kick/ban/kill/whisper/change-team,
  broadcasts, map override, next map, end/restart match, map rotation editing and saving, reserved
  slots, bans, score tick, sponsor image, a live cash-in-play chart for the current match, and the
  full `ServerSettings.ini` config document as a typed form (or the raw file) with validate/apply,
  revision conflict handling and copy/download.
- **Demo mode**: a built-in mock game server so you can try everything before pointing it at a real one.

The protocol was reverse-engineered from `rcon.wardogs.com`; see [docs/wardogs-api.md](docs/wardogs-api.md).

Running a public server? Add it to [wardogservers.com](https://wardogservers.com) so players can find it in
the community server list.

## Screenshots

Taken against the built-in demo server, so the numbers are synthetic.

![Server overview: scores, match control and scoreboard](docs/screenshots/server-overview.png)

| Analytics                                                                     | Players                                      |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| ![Analytics: players online, uptime, matches](docs/screenshots/analytics.png) | ![Players tab](docs/screenshots/players.png) |

| Audit trail                                                        | Map rotation                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| ![Audit trail with filters and export](docs/screenshots/audit.png) | ![Map rotation editor](docs/screenshots/rotation.png) |

| Configuration                                                                    | Game server log                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| ![Score tick, sponsor image and ServerSettings.ini](docs/screenshots/config.png) | ![The game server's own RCON listener log](docs/screenshots/log.png) |

| Player dossier                                                                   | Automation                                                              |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ![Player dossier: history, risk, watchlist, notes](docs/screenshots/dossier.png) | ![Automation: triggers with a dry run](docs/screenshots/automation.png) |

| Users and access                              | Servers                                  |
| --------------------------------------------- | ---------------------------------------- |
| ![Users & Access](docs/screenshots/users.png) | ![Servers](docs/screenshots/servers.png) |

More in [docs/screenshots/](docs/screenshots/): the [dashboard](docs/screenshots/dashboard.png), the [players table with watchlist and risk flags](docs/screenshots/players-flags.png), [Discord webhooks on the org page](docs/screenshots/org-webhooks.png), [time per map and most active players](docs/screenshots/analytics-2.png), and the [sign-in page](docs/screenshots/sign-in.png).

## How it works

```
browser ──HTTPS──▶ web (Bun + SvelteKit)            worker ──HTTP──▶ game server :7776 (WDRCON)
                     │  pages, /api/* JSON, Better Auth      │  observes every server on its tier
                     │  live view + SSE from the worker      │  (1–2 s watched/busy, 30 s idle)
                     │  commands → relay → worker's lane     │  sessions, triggers → outbox → delivery
                     └─ Postgres / TimescaleDB ◀─────────────┘  samples, matches, live snapshot, settings
```

One image, three roles: `web` serves the panel, `worker` owns every game request, `migrate`
applies the schema and exits. `WARCON_ROLE=all` (the default outside Compose) does all of it in
one process for the smallest install. Web and worker talk over a small HTTP relay guarded by
`RELAY_SECRET`; the worker holds a lease in the database so exactly one process observes, and
re-checks it inside every write.

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

Compose starts `migrate` (runs once), `warcon` (the web), `worker` and `db` (TimescaleDB); set
`RELAY_SECRET` in `.env` to any long random string. The app reaches `db` through the
`PGHOST`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` variables Compose sets, so `POSTGRES_PASSWORD`
can contain any characters. To use an external Postgres instead, set `DATABASE_URL` in `.env` (it
takes precedence over those) and delete the `db` service together with the `depends_on` block in
`docker-compose.yml`; install the `timescaledb` extension there before the first start if you want
automatic retention on the analytics samples (plain Postgres works too, the app prunes old samples
itself).

Open the URL. The first visit shows the **owner setup** form; after that it is a normal login. Then,
as owner:

1. **Orgs → New organisation**, or rename the **Default** organisation every install starts with.
2. **Servers → Add server**: name, host, port, scheme, RCON password. Use **Test** to check reach.
3. **Orgs → your org → New invite link**: pick the role joiners get, copy the link into your
   Discord. People open it, sign in with Discord, and appear under **Members**, where you can adjust
   their per-server roles.

The database lives in the `warcon-db` volume; back it up with `pg_dump`. Migrations are applied
by the `migrate` container before web and worker start (a single `WARCON_ROLE=all` process applies
them itself); web and worker refuse to start while any are pending. Keep `ENCRYPTION_KEY` safe: losing it means re-entering every
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

Have the proxy redirect plain `http://` to `https://` (Caddy does this by default; on Cloudflare turn on
**Always Use HTTPS**). A page served over http has an http origin, and every form post on it is then
rejected as cross-site against the https `ORIGIN`.

### Configuration (`.env`)

| Var                                                          | Default                | Meaning                                                                                                                                                                           |
| ------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                         | required               | Session signing secret.                                                                                                                                                           |
| `ENCRYPTION_KEY`                                             | required               | Base64 of 32 random bytes; encrypts stored RCON passwords.                                                                                                                        |
| `DATABASE_URL`                                               | unset                  | `postgres://user:pass@host:5432/warcon`. Overrides the `PG*` fields; percent-encode `/ # % ?` in the password.                                                                    |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGPASSWORD` / `PGDATABASE` | set by Compose         | The database as separate fields (no encoding needed). Used when `DATABASE_URL` is unset.                                                                                          |
| `POSTGRES_PASSWORD`                                          | `warcon`               | Password for the bundled `db` service (Compose only).                                                                                                                             |
| `ORIGIN`                                                     | required               | The exact URL people open (scheme, host, port).                                                                                                                                   |
| `ADDRESS_HEADER` / `XFF_DEPTH`                               | unset / `1`            | Behind a proxy: the header carrying the client IP (see above).                                                                                                                    |
| `PORT` / `HOST`                                              | `3000` / `0.0.0.0`     | Listen address.                                                                                                                                                                   |
| `WARCON_ROLE`                                                | `all`                  | `all` serves, migrates and runs the worker in one process; `web` and `worker` split them (Compose does); `migrate` applies migrations and exits.                                  |
| `RELAY_SECRET` / `RELAY_URL` / `WORKER_PORT`                 | unset / unset / `7700` | Split roles only: the secret web and worker share, where the web finds the worker (`http://worker:7700`), and the worker's port.                                                  |
| `POLL_SECONDS` / `POLL_CONCURRENCY`                          | `20` / `128`           | Seeds for two of the runtime settings on a fresh install only; after that the owner edits cadences, budgets and retention on the **Settings** page without a restart.             |
| `APP_NAME`                                                   | `Warcon`               | Name shown in the UI.                                                                                                                                                             |
| `AUDIT_LOG_READS`                                            | `false`                | Also audit read-only calls (status polls etc.). Noisy.                                                                                                                            |
| `ALLOW_ORG_SIGNUP`                                           | `false`                | Anyone may create an account and their own organisation at `/sign-up` (3 orgs per person). For hosted, multi-clan instances.                                                      |
| `MAX_ORGS_PER_USER` / `MAX_SERVERS_PER_ORG`                  | `3` / `10`             | Self-serve limits. The site owner is exempt and can raise the server limit per organisation, or suspend one, from the Orgs page.                                                  |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`                | unset                  | Cloudflare Turnstile challenge on the username-and-password sign-up forms (invite links and `/sign-up`). Recommended with `ALLOW_ORG_SIGNUP`.                                     |
| `ALLOW_DEMO_SERVER`                                          | `true`                 | Allow a server with host `demo` served by the built-in mock.                                                                                                                      |
| `GAME_TLS_INSECURE`                                          | `false`                | Accept self-signed certificates on `https` game servers.                                                                                                                          |
| `SETUP_TOKEN`                                                | unset                  | When set, first-run setup requires it.                                                                                                                                            |
| `STEAM_API_KEY`                                              | unset                  | Steam lookups: persona and avatar, account age, VAC and game bans, for dossiers, the risk score and the kick-on-connect trigger. Free at <https://steamcommunity.com/dev/apikey>. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`                | unset                  | "Sign in with Discord": invite links create accounts through it, existing accounts can link it. OAuth redirect: `<ORIGIN>/api/auth/callback/discord`.                             |

### Roles

Every server belongs to an **organisation**. People are members of organisations, either as
**org owner** or **member**, and members get a per-server role. The **site owner** (the account
from first-run setup, plus anyone it promotes on the Users page) runs the whole panel.

|                                                                                                                                                          | viewer | operator | admin | org owner | site owner |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ----- | --------- | ---------- |
| status, players, rotation, bans, reserved, config (read), server log, analytics, player dossiers, triggers (read)                                        | ✓      | ✓        | ✓     | ✓         | ✓          |
| broadcast, whisper, kick, kill, change team, end/restart match, change map, next map, live rotation edits, player notes and watchlist                    |        | ✓        | ✓     | ✓         | ✓          |
| ban/unban, reserved slots, score tick, rotation mode/enable, save rotation, sponsor image, config apply, raw /v1 calls, triggers (create, edit, dry run) |        |          | ✓     | ✓         | ✓          |
| the organisation's ban list and reserved-slot list (add and remove entries, pushed to every server)                                                      |        |          | ✓     | ✓         | ✓          |
| add, edit and remove the org's servers; members, per-server roles and invite links; Discord webhooks; the org's audit trail                              |        |          |       | ✓         | ✓          |
| create and delete organisations; every account on the panel; the whole audit trail                                                                       |        |          |       |           | ✓          |

Members see the audit trail for their own actions plus everything on servers where they are admin.

### Self-service sign-up

Invite links always let a newcomer create an account, with Discord or with a username and password
(8 sign-ups per IP address per half hour; add a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
widget with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to keep bots off the password form).
With `ALLOW_ORG_SIGNUP=true`, `/sign-up` additionally
lets anyone create an organisation of their own and become its owner, up to three per person, and
**Continue with Discord** on the sign-in page creates an account for a Discord user who has none
and sends them to `/sign-up`; the site owner still sees and can rename or delete every org. Leave
it off for a single-clan install.

### Player dossiers, risk and the watchlist

Every player name in the panel links to a dossier: sessions, playtime, kills and deaths on each
of the organisation's servers, the names they have used, the admin actions taken on them (kicks,
bans, whispers, trigger actions), notes admins have left, and a watchlist flag with a reason.
Notes and the watchlist are shared by every server in the organisation; operators and up can
write them, and a note can be deleted by its author or an admin.

With `STEAM_API_KEY` set, the dossier also shows the Steam persona, account age (public profiles
only), VAC and game bans, refreshed daily and on demand. From all of that the panel derives an
**advisory risk score** shown in the players table: VAC or game bans, a very new or private
account, a ban on another server in the organisation, a name that resembles a banned player's, or
the watchlist. It is a pointer for an admin to look closer, not a verdict: the RCON API exposes no
aim, position or input data, so nothing here detects cheating itself.

### Organisation ban and reserved lists

Each organisation keeps a **ban list** and a **reserved-slot list** in the panel, under the
**Ban list** and **Reserved slots** tabs of the organisation page, and pushes them to every one of
its servers. Each server's own **Bans & slots** tab shows what that server holds, marks the
entries the organisation put there, and links to the organisation lists. Ban a player from the
Players tab or a dossier and choose _every server in the organisation_ (the default, when you may
edit the org list) or _this server only_. Org owners and
anyone who is admin on one of the org's servers can edit the lists; a ban can carry a reason and
an expiry, a reserved slot a priority for when a server's `MaxReservedSlots` is full.

Each entry shows where it stands on every server: **applied** by the panel, **pending** the next
sync, **failed** (hover for the server's answer), or **local**. Local means the player was already
banned (or reserved) on that server by someone working outside the panel. The panel never removes
what it did not add, so removing an org entry lifts it only where the panel applied it, and a
local ban stays until an owner imports it into the org list or unbans it on that server.

Bans and reserved slots that your servers already hold show up on the list pages as candidates to
**import**: an owner reviews them, and importing puts them on the org list, marks them as managed
on the servers that have them, and applies them to the rest. On a server's Bans & slots tab a local ban can be
promoted the same way (owners), or added to the org list while this server's own copy stays local
(server admins). Every dossier shows the player's standing on the org lists and lets an editor ban
or unban org-wide, or hand out and withdraw a reserved slot, without leaving the page.

A ban with an **expiry** is lifted by the panel when the time comes: the entry moves to the list's
history as expired and the next sync removes it from every server the panel applied it to. With
**Members get a reserved slot** on (an owner's switch on the Reserved slots tab), every member of
the organisation who linked a SteamID on their Account page is reserved a slot on all its servers,
ranked below the explicit entries when a server is full and skipped while the org has them banned.

Sync happens twice over: right away when a list is edited (the toast says on how many servers the
change landed, and which are unreachable and will be retried), and on every poll, where the
poller re-applies anything missing, so an org ban that someone lifts on the server directly comes
back at the next poll; use the org list to lift it everywhere. Reserved slots respect each
server's `MaxReservedSlots`: when a server is full, the org's entries are applied in priority
order and the rest show as failed until room is made. Every run that changes something, or fails,
is in the audit trail under `system` as `lists.sync`, and reaches Discord webhooks that mirror
bans. **Sync now** on a list page pushes everything on demand.

### Automation (triggers)

The **Automation** tab on each server holds rules the poller evaluates on every sample. Admins
create them; every action they take is in the audit trail under the `trigger` category with the
rule that fired, and can be mirrored to Discord.

| Trigger                | Does                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome whisper        | Whispers a message to each joiner (optionally only on their first visit). Placeholders `{name}` `{server}` `{map}` `{players}` `{max}`.                                                                               |
| Scheduled broadcast    | Rotates through a list of messages every N minutes while at least M players are on.                                                                                                                                   |
| Empty-server map reset | After the server has been empty for N minutes on a different map or mode, sets the chosen map as next and ends the match (or requests it directly when there is no rotation).                                         |
| Kick on connect risk   | Kicks joiners who match rules: VAC ban, game ban, Steam account younger than N days (optionally private profiles too), banned on another server in the org, or on the watchlist. Reserved-slot players can be spared. |

**Dry run** replays the last 24 hours of the server's own history (joins, player counts, empty
stretches, cached Steam data) against a rule and lists what it would have done, so you can tune a
rule before enabling it. Joins are detected one poll apart, so a welcome arrives `POLL_SECONDS`
after someone connects; the first poll after a restart or an outage never fires join rules, since
everyone present looks like a joiner then.

### Discord webhooks

On the organisation's overview an owner can add Discord channel webhooks (in Discord: channel settings →
Integrations → Webhooks → copy URL) and choose what to mirror: bans (including org list changes), other game commands, trigger
actions, player notes and watchlist changes, management changes, sign-ins; for every server or a
subset. Events are batched into one message per burst, IP addresses are never sent, and the URL
(which lets anyone post to the channel) is stored encrypted with `ENCRYPTION_KEY` and never shown
again. **Test** posts a message right away; delivery failures show on the org page.

### Accounts and personal data

An account holds a username, display name, password hash, sessions (with IP address and
browser), the Discord id and avatar URL when Discord is linked, and a SteamID64 if the person
links one on the Account page (so an organisation can hand them a reserved slot). Every sign-in and action is
written to the audit trail with the actor's name, IP address and browser. Nothing else is
collected, and nothing leaves the panel.

Anyone can delete their own account from the **Account** page (right to erasure): password
accounts confirm with the password, Discord-only accounts by typing their username after a recent
sign-in. Deletion removes the account, its credentials, sessions, server roles and organisation
memberships at once. Audit entries the person caused stay for the record but lose their name, IP
address and browser, and entries that named them lose the username; one row recording the deletion
itself keeps the requester's IP. The only owner of an organisation, or the only site owner, must
hand over first, so nothing is left without an owner. The site owner can delete anyone from the
Users page under the same rules.

Analytics store the Steam id and in-game name of every player seen on a server, for a year (see
[Notes and limits](#notes-and-limits)). With `STEAM_API_KEY` set the panel also caches what the
Steam Web API says about each player it sees (persona, avatar, account creation date, ban
counts), and admins can leave notes and watchlist flags on players. If you host the panel for
other people, publish a privacy notice that says so, along with the audit retention you choose.

### Site owner controls

The Orgs page shows every organisation with its creator, member and server counts against its
limit, and status. From there (or from an org's own page) the site owner can raise or lower an
org's server limit and **suspend** it: members lose access to its servers, owners cannot add
servers or mint links, and invite links stop working, until it is restored. Deleting an org removes
its servers from the panel; the accounts stay.

### Invite links

An org owner mints a link on the org page: it carries the org role joiners get (`member` or
`owner`), an optional default server role applied to every server the org has at that moment, an
optional expiry and an optional use limit. Opening `<ORIGIN>/join/<token>` shows the org name and a
**Continue with Discord** button; a Discord user without an account gets one (username derived from
their Discord handle), an existing user simply signs in, and either way they land back on the link
to confirm the join. People who already have a username can use that instead. Links can be revoked
at any time; whoever already joined keeps their access until an owner removes them.

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

Only the site owner can register a private target (loopback, `host.docker.internal`, RFC 1918,
a VPN address). Servers added by org owners must resolve to a public address, and every server is
re-checked before each request, so a hostname that later points somewhere internal is refused
rather than fetched. Link-local addresses (`169.254.0.0/16`, `fe80::/10`) are refused for everyone.
Refused targets are recorded on the audit page. The raw action is limited to `/v1/` paths on the
server's own port, and the connectivity test and raw action are rate limited per user.

The ini comments say a non-loopback `BindAddress` expects TLS and `PasswordHash=`; the official web
console connects over plain `http` regardless, and so can Warcon.

## Local development

Prerequisites: [Bun](https://bun.sh) 1.2+ and a Postgres (the TimescaleDB image is easiest).

```bash
bun install
docker run -d --name warcon-pg -p 5432:5432 -e POSTGRES_USER=warcon -e POSTGRES_PASSWORD=warcon \
  -e POSTGRES_DB=warcon timescale/timescaledb:2.30.0-pg18
cp .env.example .env      # set the two secrets, ORIGIN=http://localhost:5173, DATABASE_URL=postgres://warcon:warcon@127.0.0.1:5432/warcon
bun run dev               # http://localhost:5173 (single process: web + worker in-process)
bun run check             # svelte-check
bun run build && bun run start   # production build, http://localhost:3000 (set ORIGIN to match)
```

To run the split roles locally after `bun run build`: `bun run db:migrate`, then
`WARCON_ROLE=worker RELAY_SECRET=… bun run worker` in one terminal and
`WARCON_ROLE=web RELAY_SECRET=… RELAY_URL=http://127.0.0.1:7700 bun run start` in another.
`/api/health` on the web (and `/health` on the worker) shows the worker's tiers, in-flight count,
"behind" and "stuck" figures, and the delivery queue; the owner's **Settings** page shows the same.

The schema is defined in [src/lib/server/db/schema.ts](src/lib/server/db/schema.ts). After changing
it, run `bun run db:generate` to write a new migration into `drizzle/`; the app applies pending
migrations at startup. Add a server with host `demo`, port `1`, password `demo` to use the mock game
server.

## Layout

```
src/hooks.server.ts            startup (role, gateway, worker in-process for `all`), session lookup, Better Auth handler, CSRF header check
src/worker/worker.ts           the worker process entry (WARCON_ROLE=worker); runtime.ts serves the relay; migrate.ts = bun run db:migrate
scripts/build-worker.ts        bundles the worker with Bun (shims $env and $app), run by bun run build
src/lib/server/env.ts          process config + the database connection
src/lib/server/db/schema.ts    every table, as Drizzle definitions (source of truth for migrations)
src/lib/server/db/index.ts     Bun SQL client + Drizzle + migration runner
drizzle/                       generated SQL migrations (bun run db:generate) + TimescaleDB setup
src/lib/server/auth.ts         Better Auth config (username + admin plugins, Drizzle adapter)
src/lib/server/access.ts       global/per-server roles, accessible servers, login throttling
src/lib/server/users.ts        account management on top of Better Auth (create, disable, reset, grants)
src/lib/server/orgs.ts         organisations: members, per-server roles, invite links, joining
src/lib/server/servers.ts      server records, reachability test, per-server grants
src/lib/server/lists.ts        organisation ban and reserved-slot lists: entries, per-server standing, views
src/lib/server/lists-plan.ts / lists-sync.ts   what to add or remove on a server (pure) / the per-server sync run and API fan-out
src/lib/server/actions.ts      every panel action -> role level + /v1 call(s)
src/lib/server/rcon-run.ts     /api/servers/:id/rcon/:action dispatcher with audit rows
src/lib/server/rcon.ts         WardogsClient (Bearer auth, JSON/text calls, demo routing)
src/lib/server/transport.ts    fetch to the game server
src/lib/server/poller.ts       the worker's scheduler: tiers, phases, concurrency budget, roster, housekeeping, stats
src/lib/server/poller-schedule.ts  the scheduler's maths (phase per server, next due, budget) — pure
src/lib/server/observe.ts      one observation: status/players, session diff, trigger evaluation, one fenced transaction, live snapshot, samples
src/lib/server/sessions.ts     player presence in memory, batched session writes (join, leave, heartbeat)
src/lib/server/outbox.ts       trigger delivery loop: claim with a lease, send through the lane, record the outcome
src/lib/server/rollups.ts      hourly sample rollups behind the long ranges, and the retention policy
src/lib/server/dispatcher.ts   one lane per game server: one request in flight, humans ahead of the worker
src/lib/server/leadership.ts   the worker lease and the fenced transaction every worker write uses
src/lib/server/live.ts / events.ts / interest.ts   live snapshot rows, the in-process event bus, watch leases
src/lib/server/gateway.ts      the web↔worker seam; gateway-local.ts (same process), gateway-remote.ts + relay.ts (HTTP)
src/lib/server/settings.ts     owner-editable runtime settings (site_settings): keys, bounds, hot reload
src/lib/server/players.ts      dossiers, notes, watchlist, per-player marks (risk) for the players table
src/lib/server/steam.ts        Steam Web API lookups cached in steam_profiles
src/lib/server/risk.ts         advisory risk score and name resemblance (pure)
src/lib/server/trigger-rules.ts / triggers.ts   trigger settings and verdicts (pure) / evaluation into intents, dry runs
src/lib/server/webhooks.ts     Discord webhook records; webhook-delivery.ts batches audit rows to Discord
src/lib/server/analytics.ts    analytics queries per server and range
src/lib/server/audit.ts        audit writer/query with secret redaction
src/lib/server/mockgame.ts     in-process imitation of the WDRCON API for demo/testing
src/lib/config-doc.ts / config-fields.ts   ServerSettings.ini parser and line-level setter (pure, tested) / the keys the config form manages
src/lib/components/            Modal, MapPicker, PopulationChart, CashChart, ConfigForm, Toasts, badges…
src/routes/(auth)/             /sign-in, /setup, /join/[token] (form actions)     src/routes/sign-out
src/routes/(app)/              dashboard, /server/[id]/{,players,players/[steamId],bans,rotation,config,automation,analytics,log}, /audit, /orgs, /orgs/[id]/{,bans,reserved}, /users, /servers, /account
src/routes/api/                JSON API (below)
docs/wardogs-api.md            the reverse-engineered game-server API
```

### API cheatsheet

All `/api` calls need the session cookie; mutations also need `X-Requested-With: warcon`.
Sign-in, setup, password change and session revocation are SvelteKit form actions on their pages,
which call Better Auth server-side behind the login lockout and the audit trail. Of Better Auth's
own `/api/auth/*` routes only the OAuth callback is reachable over HTTP; everything else answers 404.

```
GET/POST /api/orgs  PATCH/DELETE /api/orgs/:id   PATCH {name} | {membersReserved} | site owner: {serverLimit, suspended, reason}
GET  /api/orgs/:id/members  PATCH/DELETE /api/orgs/:id/members/:userId {role}  PUT .../:userId/grants {grants:[{serverId,role}]}
GET/POST /api/orgs/:id/invites {label,orgRole,serverRole,expiresDays,maxUses}  DELETE /api/orgs/:id/invites/:inviteId
GET/POST /api/users  PATCH/DELETE /api/users/:id  PUT /api/users/:id/grants {grants:[{serverId,role}]}
GET/POST /api/servers {orgId,...}  PATCH/DELETE /api/servers/:id  POST /api/servers/:id/test
GET/PUT /api/servers/:id/grants {grants:[{userId,role}]}   GET /api/servers/:id/summary
GET|POST /api/servers/:id/rcon/:action   (GET for reads with query params, POST JSON for mutations)
GET  /api/servers/:id/analytics?range=24h|7d|30d
GET  /api/servers/:id/cash?since=<iso>                  cash-in-play samples since a moment (24 h at most), seeds the dashboard chart
GET  /api/servers/:id/players/marks?ids=a,b&names=…     watchlist / first-visit / risk per connected player
GET  /api/servers/:id/players/:steamId                  dossier   POST .../steam (refresh Steam data)
POST /api/servers/:id/players/:steamId/notes {body}     DELETE .../notes/:noteId   PUT .../watch {watched,reason}
GET/POST /api/servers/:id/triggers {kind,name,enabled,config}   PATCH/DELETE .../:triggerId   POST .../dry-run {kind,config}
GET/POST /api/orgs/:id/webhooks {label,url,events,serverIds,enabled}   PATCH/DELETE .../:webhookId   POST .../:webhookId/test
GET  /api/orgs/:id/lists                                 the org's ban and reserved-slot lists, and the caller's role on them
GET/POST /api/orgs/:id/lists/:kind/entries {steamId,reason,expiresAt,priority}   DELETE .../entries/:steamId   (kind = ban | reserve; ?includeRemoved=1)
POST /api/orgs/:id/lists/sync                            push the lists to every org server now
GET  /api/orgs/:id/lists/import                          server entries not on the org list   POST {entries:[{kind,steamId,reason}]} adopts them (owner)
GET  /api/servers/:id/lists/state                        which bans / reserved slots here come from the org lists   POST .../lists/sync
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

- Analytics are derived from observation: player sessions are accurate to the cadence in force
  (a second or two on a busy server), and match boundaries are inferred from the match clock and
  map changes. Raw samples are kept for 14 days by default (a TimescaleDB retention policy, or the
  worker's own prune on plain Postgres) with hourly rollups behind the 30-day charts; sessions and
  matches for a year. Both are settings.
- Several web processes can share one database and one worker; the worker's lease makes exactly
  one process observe, and a second worker takes over within seconds if the first stops renewing.
- The game has no push API. Freshness is the observation cadence, which the owner sets; the
  defaults (1 s players / 2 s status while watched, 2 s / 5 s while busy) are lighter on the game
  than the old per-browser polling was.
- Password hashing is Better Auth's default scrypt, which runs natively via `node:crypto` on Bun.
- Sessions are looked up in the database on every request (no cookie cache), so disabling a user
  or revoking a session takes effect immediately.
- Discord creates accounts only through an invite link, or anywhere it is offered when
  `ALLOW_ORG_SIGNUP` is on (`/sign-up` and the sign-in page); Better Auth's public sign-up and
  social sign-in endpoints are closed either way. Password accounts can link Discord from their
  Account page, and accounts created through Discord can set a password there to sign in by
  username as well.
- Upgrading an existing install: the migration creates one organisation named "Default" holding
  every server, with existing owners as its owners and everyone else as members. Rename it on the
  Orgs page.
- The demo server's state lives in process memory and resets on restart. Its players' SteamIDs are
  arbitrary, so with a Steam key some resolve to unrelated real accounts and others to "Not found".
- The risk score and the kick-on-connect trigger see only what this page describes. They cannot
  see aim, position, input or IP addresses; anything claiming to detect aimbots from the RCON API
  is guessing.
- Audit rows are never deleted by the panel. Prune them with SQL if you need to. Deleting an
  account pseudonymises its rows rather than removing them (see
  [Accounts and personal data](#accounts-and-personal-data)).
