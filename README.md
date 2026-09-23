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

It is for anyone who runs a WARDOGS server: a clan with one box, a community with a dozen, or a
host with hundreds. Everybody on the team gets their own login instead of the RCON password, the
panel keeps the history the game throws away, and the worker can act on what it sees. Pick your
way in:

- **Just want to run it?** [docs/getting-started.md](docs/getting-started.md) is the plain-language
  walkthrough: Docker, one `.env` file, done. [Deploy with Docker](#deploy-with-docker) below has
  the detail.
- **Want a look first?** Every install comes with a built-in demo server, so you can click around
  the whole panel before pointing it at a real one.
- **Want to hack on it?** [Local development](#local-development) gets you running in a few
  minutes and [Contributing](#contributing) says what a change needs. Questions and half-formed
  ideas are welcome in the issues.

What is in the box:

- **Multiple servers** in one panel, each with its own encrypted RCON password.
- **Organisations and invite links**: each clan or community is an organisation with its own
  servers, owners and members. An owner pastes an invite link into their Discord; whoever opens it
  signs in with Discord (creating their account on the spot) and joins with the roles the link
  carries. Per-server roles on top: every org starts with `viewer` / `operator` / `admin`, and its
  owners can change what those may do or add roles of their own.
- **Account management**: Better Auth accounts; password resets, forced password change, disable,
  session revocation, login throttling.
- **Full audit trail**: every login, user or server change, and every game-server command, with
  actor, server, target, outcome, upstream status and duration. Filterable and exportable
  (CSV/JSON). The game server's own listener log is shown alongside it; the addresses of its peers
  are shown to the site owner only.
- **Live view**: a worker process watches every server on a cadence that follows what is
  happening: every second or two while someone has it open or people are on it, every half
  minute when it is empty. Pages get each observation as it happens over an event stream, and a
  command you send shows its effect on the next look. Browsers never talk to a game server.
- **Past players**: the Players tab switches between who is on now and everyone who has played on
  that server, searched by name, alias or SteamID64, with when they were last on, their sessions
  and playtime. Anyone who can open the server can look; a row's Ban (for people who hold _Bans_)
  lands the moment the player next joins, and Watch needs _Notes_.
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
  whisper on join or once the player has picked a faction, a whisper on faction change, scheduled
  broadcasts, empty-server map reset, kick-on-connect for VAC bans, brand-new accounts or bans
  elsewhere in the org, and a flag for players whose kill rate or headshot share is out of line.
- **Organisation ban and reserved lists**: ban a player across every server in the organisation
  at once, with a reason and an optional expiry; hand out reserved slots the same way. The worker
  keeps every server in line and shows where each entry stands; bans added outside the panel are
  left alone.
- **Discord mirror and status channels**: an org owner points a channel webhook at the audit trail
  and picks what to mirror (bans, commands, trigger actions, sign-ins…), per server if wanted. A
  webhook can also keep a live status card per server in its channel, edited in place by the
  worker: players online, map art, mode, a score bar per faction and who is on each side.
- **Everything the official console does**: status, scoreboard, kick/ban/kill/whisper/change-team,
  broadcasts, map override, next map, end/restart match, map rotation editing and saving, reserved
  slots, bans, score tick, sponsor image, a live cash-in-play chart for the current match, and the
  full `ServerSettings.ini` config document as a typed form (or the raw file) with validate/apply,
  revision conflict handling and copy/download.
- **Demo mode**: a built-in mock game server so you can try everything before pointing it at a real one.

The protocol was reverse-engineered from `rcon.wardogs.com`; see [docs/wardogs-api.md](docs/wardogs-api.md).
The map imagery under `static/maps/` is BULKHEAD's, mirrored from the official console by
`scripts/fetch-map-art.sh` and credited in the footer; it is not under this repository's MIT
licence (see [static/maps/ATTRIBUTION.md](static/maps/ATTRIBUTION.md)). Warcon is a community
tool with no affiliation to BULKHEAD or Team17.

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

| Config                                                                           | Game server log                                                      |
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
every action, and writes an audit row before answering. Nobody reads the password back, owners
included, and changing a server's host, port or scheme asks for it again, since the stored one
would otherwise be sent to the new address.

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
the analytics samples compressed as they age (plain Postgres works too; the samples table then
grows uncompressed, about 1.5 MB per game server per day).

The Admin page's Overview shows the build each process runs, the version and the commit, so an
install on an old build is easy to spot. There is nothing to set: the build reads the commit from
the checkout. Only a build whose source arrives without `.git` needs it passed in, as the
`WARCON_COMMIT` build argument.

Open the URL. The first visit shows the **owner setup** form; after that it is a normal login. Then,
as owner:

1. **Orgs → New organisation**, or rename the **Default** organisation every install starts with.
2. **Servers → Add server**: name, host, port, scheme, RCON password. Use **Test** to check reach.
   The organisation's **Servers** tab then shows them side by side with the live view: reach, map,
   players, and who may open each.
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
address for login throttling and the rate limits (it is never stored). Use `x-real-ip` for nginx, `x-forwarded-for` for
Caddy and Traefik, `cf-connecting-ip` for a Cloudflare Tunnel. Only set it when the proxy is the only
way to reach the port; otherwise anyone can spoof their address and dodge the limits.

Have the proxy redirect plain `http://` to `https://` (Caddy does this by default; on Cloudflare turn on
**Always Use HTTPS**). A page served over http has an http origin, and every form post on it is then
rejected as cross-site against the https `ORIGIN`.

### Metrics (Prometheus)

Both processes export Prometheus metrics at `/metrics`, the web on its normal port and the worker
on `WORKER_PORT`, behind the `METRICS_TOKEN` bearer; the endpoint answers 404 until that is set.
Warcon ships no Prometheus or Grafana of its own: point the ones you already run at it. Everything
is counted in memory on paths that already run, never with a query per server, and the few gauges
that need a look at the database or the scheduler are read once per scrape.

```yaml
# prometheus.yml on your monitoring host
scrape_configs:
  - job_name: warcon-web
    authorization: { credentials: <METRICS_TOKEN> }
    static_configs: [{ targets: ['panel.example.com:443'] }]
    scheme: https
  - job_name: warcon-worker
    authorization: { credentials: <METRICS_TOKEN> }
    static_configs: [{ targets: ['10.0.0.5:7700'] }] # the worker's private address
```

With `WARCON_ROLE=all` one process serves both sets, so one job is enough. The web endpoint sits
on the panel's own URL, so it is reachable wherever the panel is. The worker's port is the relay
port: the Compose file keeps it inside the Compose network, so a Prometheus on another machine
cannot see it until you publish it on a private address (add `ports: ['10.0.0.5:7700:7700']` to
the `worker` service, never `0.0.0.0`), or run Prometheus on the same host and Compose network.
The exposition carries fleet-wide figures: keep the token out of URLs and never publish
`/metrics` without it.
[`monitoring/grafana-dashboard.json`](monitoring/grafana-dashboard.json) is a dashboard to import
into your Grafana (Dashboards → New → Import); it expects the two job names above and, for its
database panels, a [postgres_exporter](https://github.com/prometheus-community/postgres_exporter)
scraped as job `postgres`, which is optional.

| Metric                                                                                | What it is                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `warcon_players_online`, `warcon_servers{tier}`                                       | Players on every reachable server and the roster by observation tier (worker).              |
| `warcon_observations_total{outcome}`, `warcon_observation_seconds`                    | Looks at game servers per second and how long they take (worker).                           |
| `warcon_servers_behind`, `warcon_observations_stuck`, `warcon_observations_in_flight` | Whether the worker is keeping up: the same figures as the Admin page's Overview tab.        |
| `warcon_deliveries_total{outcome}`, `warcon_outbox_pending`                           | Trigger actions delivered, failed, skipped or unknown, and the queue depth (worker).        |
| `warcon_worker_lease_held`                                                            | 1 on the process that owns observation and delivery.                                        |
| `warcon_http_requests_total{route,method,status}`, `warcon_http_request_seconds`      | Every request by SvelteKit route id (web).                                                  |
| `warcon_feed_posts_total{outcome}`, `warcon_feed_kills_total{result}`                 | Kill feed batches accepted, refused or rejected, and events accepted, skipped or duplicate. |
| `warcon_rate_limited_total{scope}`                                                    | Requests the in-memory limiter refused, by the limit that fired.                            |
| `warcon_fleet{table}`                                                                 | Row counts of organizations, users, servers, org members, webhooks and triggers (web).      |
| `process_*`, `nodejs_*`                                                               | CPU, memory and event-loop lag of each process.                                             |

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
| `METRICS_TOKEN`                                              | unset                  | Bearer for `GET /metrics` (Prometheus) on the web and worker processes; the endpoint answers 404 until it is set. See [Metrics](#metrics-prometheus).                             |
| `POLL_SECONDS` / `POLL_CONCURRENCY`                          | `20` / `128`           | Seeds for two of the runtime settings on a fresh install only; after that the owner edits cadences and budgets under **Admin → Settings** without a restart.                      |
| `APP_NAME`                                                   | `Warcon`               | Name shown in the UI.                                                                                                                                                             |
| `AUDIT_LOG_READS`                                            | `false`                | Also audit read-only calls (status polls etc.). Noisy.                                                                                                                            |
| `ALLOW_ORG_SIGNUP`                                           | `false`                | Anyone may create an account and their own organisation at `/sign-up` (3 orgs per person). For hosted, multi-clan instances.                                                      |
| `MAX_ORGS_PER_USER` / `MAX_SERVERS_PER_ORG`                  | `3` / `10`             | Self-serve limits. The site owner is exempt and can raise the server limit per organisation, or suspend one, from the Orgs page.                                                  |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`                | unset                  | Cloudflare Turnstile challenge on the username-and-password sign-up forms (invite links and `/sign-up`). Recommended with `ALLOW_ORG_SIGNUP`.                                     |
| `ALLOW_DEMO_SERVER`                                          | `true`                 | Allow a server with host `demo` served by the built-in mock.                                                                                                                      |
| `GAME_TLS_INSECURE`                                          | `false`                | Accept self-signed certificates on `https` game servers.                                                                                                                          |
| `SETUP_TOKEN`                                                | unset                  | When set, first-run setup requires it.                                                                                                                                            |
| `STEAM_API_KEY`                                              | unset                  | Steam lookups: persona and avatar, account age, VAC and game bans, for dossiers, the risk score and the kick-on-connect trigger. Free at <https://steamcommunity.com/dev/apikey>. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`                | unset                  | "Sign in with Discord": invite links create accounts through it, existing accounts can link it. OAuth redirect: `<ORIGIN>/api/auth/callback/discord`. Steam sign-in needs no key. |

### Roles

Every server belongs to an **organisation**. People are members of organisations, either as
**org owner** or **member**, and members get a per-server role. The **site owner** (the account
from first-run setup, plus anyone it promotes under Admin → Users) runs the whole panel.

A server role is a named set of **capabilities**. Every organisation starts with three, `viewer`,
`operator` and `admin`, holding what the table shows. Its owners can change any of them on the
org's **Roles** tab (a change applies at once to everyone holding the role), reset a built-in to
what it shipped with, and add roles of their own, say a `Trial staff` that may kick but not ban.
Org owners and the site owner hold every capability on every server in scope.

| Capability         | Unlocks                                                                                                                                                                   | viewer | operator | admin |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------- | ----- |
| View               | what is happening on the server: status, players, kills, rotation, who is banned and who holds a reserved slot, analytics, leaderboards, player stats. Every role has it. | ✓      | ✓        | ✓     |
| Chat               | broadcast, whisper                                                                                                                                                        |        | ✓        | ✓     |
| Kick, kill, move   | kick, kill, change team                                                                                                                                                   |        | ✓        | ✓     |
| Match control      | end/restart match, change map, next map, weather                                                                                                                          |        | ✓        | ✓     |
| Live rotation      | add, remove and reorder rotation entries on the running server                                                                                                            |        | ✓        | ✓     |
| Notes & watchlist  | read and add player notes (delete your own), watch and unwatch, the reason a player is watched                                                                            |        | ✓        | ✓     |
| Bans               | ban and unban on the server                                                                                                                                               |        |          | ✓     |
| Reserved slots     | reserve and unreserve on this server, with a note and an expiry, and read the notes; a Seeding reward rule that hands out slots here                                      |        |          | ✓     |
| Org ban list       | the organisation's ban list, enforced on every server; sync; a player's entry on it in the dossier                                                                        |        |          | ✓     |
| Org reserved slots | the organisation's reserved-slot list, handed out on every server; sync; a player's entry on it in the dossier; a Seeding reward rule that hands out slots everywhere     |        |          | ✓     |
| Others' notes      | delete anyone's note                                                                                                                                                      |        |          | ✓     |
| Save rotation      | save the rotation, rotation mode on and off                                                                                                                               |        |          | ✓     |
| Config & settings  | read, validate and apply the config document; score tick, sponsor image, connection test, the game's raw status                                                           |        |          | ✓     |
| Automation         | see the triggers and what they did; create, edit, dry-run and delete them                                                                                                 |        |          | ✓     |
| Audit trail        | everyone's actions on the server in the audit log, not just your own; the game server's own RCON log                                                                      |        |          | ✓     |
| Raw RCON           | any /v1 route on the game server directly, except the config document                                                                                                     |        |          | ✓     |

View is what is happening on the server and nothing about how it is run. The config document, the
triggers, staff notes on players and the game's RCON log each need the capability that manages
them, in the panel and for API keys alike; where the server listens (its RCON host and port) and
the notes on the Servers page are shown to the organisation's owners only.

No role reads the server's credentials. The config document leaves the panel with the RCON
`Password`, its `PasswordHash` and the kill feed `Token` shown as `(hidden)`, for every role, org
owners and API keys included. Leave `(hidden)` as it is and validate and apply put the server's
current value back; type over it to change the value. A copied or downloaded document carries the
placeholder too, so it is not a backup of those three lines. Raw RCON does not serve `/v1/config`;
the `config`, `configValidate` and `configApply` actions are the way to the document. Nor does it
serve `/v1/audit`: the `serverLog` action does, with the peers' addresses blank for everyone but
the site owner, API keys included.

Beyond server roles, an **org owner** adds, edits and removes the org's servers, manages members,
roles, per-server grants and invite links and Discord webhooks, and sees the org's audit trail. The
**site owner** creates and deletes organisations, manages every account, and sees the whole trail.

Members see the audit trail for their own actions plus everything on servers where their role
includes _Audit trail_. Existing installs keep their access on upgrade: every grant is mapped to
the matching built-in role of its organisation. _Org lists_ has since been split into _Org ban
list_ and _Org reserved slots_, so an org can hand out one without the other: every role, and
every API key over the whole organisation, that held it was given both; a key limited to some
servers, which could never open the org lists, was given neither.

### Self-service sign-up

Invite links always let a newcomer create an account: with Discord or Steam (the provider's
identity becomes the account), with a passkey, or, behind a link, with a username and password
(8 sign-ups per IP address per half hour; add a [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
widget with `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to keep bots off the username forms).
With `ALLOW_ORG_SIGNUP=true`, `/sign-up` additionally
lets anyone create an organisation of their own and become its owner, up to three per person, and
**Discord** and **Steam** on the sign-in page create an account for a user who has none
and send them to `/sign-up`; the site owner still sees and can rename or delete every org. Leave
it off for a single-clan install.

### Sign-in methods and recovery

The panel holds no email address, so nobody is ever sent a reset link. Instead every account is
expected to be able to survive losing one thing. The rules, checked on the **Account** page:

- **Two independent ways in.** A passkey, a linked Discord or Steam account, a password with an
  authenticator app, and a saved recovery key each count as one.
- **A second factor on any password.** A password on its own is never enough; turn on the
  authenticator app (TOTP, with backup codes) or drop the password and rely on passkeys and
  providers. Passkeys and provider sign-ins are two factors by themselves and never ask for a code.
- **Owners hold a linked provider or a recovery key.** An organisation owner can reset a member's
  methods under Admin → Users, but nobody resets an owner, so an owner needs a way back in that
  does not depend on one device.

The **recovery key** is a 40-character secret shown once; the panel stores only its hash. Using it
at `/recover` signs the account in once, discards the key, and lands on the account page to set
things up again. New accounts start with a passkey or a provider (the password form sits behind a
link). Existing accounts keep working: a banner asks for the missing pieces. How hard the panel
pushes is the site owner's **Settings → Sign-in rules** choice: _Advise only_ (the default: the
banner and nothing more), _Require for privileged accounts_ (site owners, organisation owners and
anyone whose server role can ban, change config, run automation or use raw RCON must comply;
guests and viewers are left alone), or _Require for everyone_. Where required, an account that
still falls short after its grace period (14 days for owners, 30 for members, both editable,
counted from the first sign-in after this release) is limited to its account page until it does.

When every method is gone, whoever runs the box resets the account from a shell (the container
image has it too):

```sh
bun run auth:reset -- <username>           # local checkout
docker compose run --rm migrate bun ./build/reset-auth.js <username>   # Compose
```

It removes the authenticator app, passkeys and recovery key, keeps Discord and Steam links, signs
every session out, and prints a temporary password that must be changed at the next sign-in.

Passkeys need the panel to be served over `https` at the exact `ORIGIN` (the WebAuthn relying
party id is its hostname); `http://localhost` works for development. Steam sign-in uses Steam's
OpenID and needs no key; `STEAM_API_KEY` only improves the username and avatar of accounts it
creates. Better Auth's own `/api/auth/*` routes stay closed to browsers: passkey ceremonies go
through `/api/passkeys/*`, and codes, recovery keys and Steam through the panel's own pages.

### Player dossiers, risk and the watchlist

Every player name in the panel links to a dossier: sessions, playtime, kills and deaths on each
of the organisation's servers, the names they have used, the admin actions taken on them (kicks,
bans, whispers, trigger actions), notes admins have left, and a watchlist flag with a reason.
Notes and the watchlist are shared by every server in the organisation; roles with _Notes &
watchlist_ can write them, and a note can be deleted by its author or a role with _Others' notes_.
A [Discord webhook](#discord-webhooks) ticked for _Watched players joining_ posts each time a
watched player joins one of the organisation's servers.

With `STEAM_API_KEY` set, the dossier also shows the Steam persona, account age (public profiles
only), VAC and game bans, refreshed daily and on demand, and what its friends list shows, looked
at weekly. The **advisory risk score** is worked out when someone looks, for that reader: a ban on
another server, or games recorded there, count only if the reader can open that server. The score
is bounded to 0–100. Recent bans weigh more than old ones; multiple banned friends, a private
profile or friends list, local bans, name resemblance, and the watchlist add evidence. Extreme
win rate, K/D, and headshot percentage across recorded games add smaller weights only after
minimum match/kill counts. Headshot percentage uses kill-feed games only; the other totals use the
panel's match and session history. A _Kick on connect risk_ rule that kicks at a risk level scores
each joiner across the whole organisation.
At most 200 Steam friends are checked per account, and a partial count is labelled as such;
the friends lookups keep to a fifth of the 100,000 calls a day Steam allows a key.
Steam provides no documented profile-comments read endpoint to this panel, so comments are not
scored. Missing data is not treated as clean data or as proof of cheating. The score is a pointer
for an admin to look closer, not a verdict: the RCON API exposes no aim, position or input data.

### Organisation ban and reserved lists

Each organisation keeps a **ban list** and a **reserved-slot list** in the panel, under the
**Ban list** and **Reserved slots** tabs of the organisation page, and pushes them to every one of
its servers. Each server's own **Bans** and **Reserved slots** tabs show what that server holds,
mark the entries the organisation put there, and link to the organisation lists. The Reserved
slots tab is a roster: who holds a slot, whether they are playing right now, the note and expiry
on their entry, and how many player slots the server holds back for them. Its form reserves a
slot **on this server only**, with a note and an expiry, through a reserved-slot list of the
server's own: the panel applies it at once and withdraws it when the expiry comes, and the
roster marks these _here_. The organisation's Reserved
slots tab has the same shape across every server: the roster with who is playing where, how far
the list has been applied on each server, and the form that hands out a slot everywhere. Ban a player from the
Players tab or a dossier and choose _every server in the organisation_ (the default, when you may
edit the org list) or _this server only_. A ban on this server only goes on a ban list of the
server's own, marked _here_ on its Bans tab with the reason, who placed it and when it lifts. The
panel enforces its bans itself: the worker removes a banned player the moment it sees them on
the server, with the organisation's ban message, and writes nothing to the game's own ban list or
files. Select a ban the panel holds and choose **Edit**
to change its reason or expiry; who placed it and when stay as they are. Org owners can edit
both org lists; anyone whose role on one of the org's servers includes _Org ban list_ or _Org
reserved slots_ can edit that list, and either one opens the org's Players and Servers tabs.
_Bans_ on a server covers its own ban list and _Reserved slots_ its own slots. A ban can carry a
reason and an expiry, a reserved slot a note and an expiry. Everyone who can open the server sees who is banned, why and until when, so
write a reason as something the player could be told; who placed a ban is shown to people who hold
_Bans_ on the server or may edit the org's ban list, and the note on a reserved slot to people who
hold _Reserved slots_ on the server or may edit the org's reserved-slot list.

An org owner can set a **ban message** on the Ban list tab: the text a banned player is shown,
built from the reason and facts about the ban, for example
`{reason} | Expires {expires} | Appeal: discord.gg/yours | {uid}`. The placeholders are `{reason}`,
`{duration}` (`Perm`, `7d`, `36h`), `{expires}` and `{banned}` (UTC, `never` for a permanent ban),
`{uid}` (a short id shown in the ban list's ID column and found by its filter) and `{admin}` (the
name of whoever placed the ban: the game shows its ban list to everyone who can open the server,
so use it only if that name may be public). The message applies to org bans and to bans on one
server's own list, from the moment it is saved; the list keeps the bare reason, and a ban already
on a server keeps the text it was placed with, also when its reason or expiry is edited later.
The default, `{reason}`, sends the reason alone.

Each entry shows where it stands on every server: **applied** by the panel, **pending** the next
sync, **failed** (hover for the server's answer), or **local**. Local means the player was already
banned (or reserved) on that server by someone working outside the panel. The panel never removes
what it did not add, so removing an org entry lifts it only where the panel applied it, and a
local ban stays until an owner imports it into the org list or unbans it on that server.

Bans and reserved slots that your servers already hold show up on the list pages as candidates to
**import**: an owner reviews them, and importing puts them on the org list, marks them as managed
on the servers that have them, and applies them to the rest. On a server's Bans tab a local ban can be
promoted the same way (owners), or added to the org list while this server's own copy stays local
(ban list editors). Every dossier shows the player's entry on each org list the reader may edit,
and lets them ban or unban org-wide, or hand out and withdraw a reserved slot, without leaving the
page.

A ban or reserved slot with an **expiry** is lifted by the panel when the time comes: the entry
moves to the list's history as expired; an expired ban stops being enforced at once, and an
expired slot is removed from every server the panel applied it to at the next sync. With
**Members get a reserved slot** on (an owner's switch on the Reserved slots tab), every member of
the organisation who linked a SteamID on their Account page is reserved a slot on all its servers,
skipped while the org has them banned. A **Seeding reward** rule (see [Automation](#automation-triggers))
hands out expiring entries the same way, on the seeded server's own list or the organisation's,
to players who stayed while a server was low; the entry names the rule that added it.

Bans are enforced by the panel, not by the game. The worker holds each server's bans (the
organisation's list and the server's own) and, every time it looks at the server's players (every
two seconds on a server with people on it, up to thirty on an empty one), removes anyone who is
banned, showing them the ban message as it reads at that moment. A ban, an unban, an edit or an
expiry therefore takes effect at once and on every server, whether or not the player is connected,
and no settings file is touched. Each removal is in the audit trail under `system` as
`ban.enforce`. Two things follow. Bans only hold while Warcon is running and can reach the server:
if you stop the panel, nobody is kept out. And bans the game holds in its own list (placed with
the in-game console, another RCON tool, the `ban` action of the API, or by an older Warcon) are
not the panel's: the Bans tab shows them as _local_ with **Unban**, the panel never adds to or
lifts them, and on hosts that keep them in `ServerSettings.ini` they come back at a restart until
you take them out of the file. To move one to the panel, ban the player in the panel and remove
the local ban.

Reserved slots are synced to the game twice over: right away when a list is edited (the toast
says on how many servers the change landed, and which are unreachable and will be retried), and on
every poll, where the poller re-applies anything missing. A reserved slot is a queue skip:
the game takes the list at any length, and `MaxReservedSlots` only sets how many player slots
are held back for the people on it (a 100-slot server with 2 held back reports 98 to the public;
the panel shows the split). Live builds have no reserved-slot routes,
so on those the panel writes `DefaultReservedPlayerIds` in the config document instead (one
revision-checked apply per change), as the official console does. Every run that changes something, or fails,
is in the audit trail under `system` as `lists.sync`, and reaches Discord webhooks that mirror
bans. **Sync now** on a list page pushes everything on demand.

### Automation (triggers)

The **Automation** tab on each server holds rules the poller evaluates on every sample. Admins
create them; every action they take is in the audit trail under the `trigger` category with the
rule that fired, and can be mirrored to Discord. A rule acts with nobody at the controls, so
saving or dry-running one needs, besides _Automation_, the capability for what it does: _Chat_ for
the rules that message players, _Match control_ for the map reset, _Kick, kill, move_ for the rules
that kick and for the Kill rate watch, and for the Seeding reward _Reserved slots_ or _Org reserved
slots_ (see its row). A custom role or API key with _Automation_ alone can read the rules and
delete them.

| Trigger                | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Welcome whisper        | Whispers a message to each joiner (optionally only on their first visit). Placeholders `{name}` `{server}` `{map}` `{players}` `{max}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Scheduled broadcast    | Rotates through a list of messages every N minutes while at least M players are on, and optionally only until a ceiling, so a fill-the-server message stops once it has.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Empty-server map reset | After the server has been empty for N minutes on a different map or mode, sets the chosen map as next and ends the match (or requests it directly when there is no rotation).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Kick on connect risk   | Kicks joiners who match rules: VAC ban or game ban (optionally only within the last N days), Steam account younger than N days (optionally private profiles too), banned on another server in the org, or on the watchlist; or whose advisory risk score is high (or medium or worse), as the players table shows it. Reserved-slot players can be spared.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Name filter            | Kicks joiners whose name breaks the rule, or with _Alert only_ just records them (audit trail and Discord). A character policy: any, Latin letters (keeps José and Müller, optionally with Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari, Chinese, Japanese or Korean beside them) or ASCII only; digits, spaces and keyboard punctuation always pass, emoji and symbols only when allowed, and a name can be required to hold N letters. Blocked words: a built-in English list of slurs and hate terms, your own words (up to 200) and exceptions for names that would match but are fine. Words are caught through case, leetspeak, look-alike letters, stretching and spelling out (`n.a.z.i`). The kick reason takes `{why}` `{name}` `{server}`; `{why}` says what kind of fault it was, never the word. Reserved-slot players can be spared. Checked at the join and again whenever the name changes, clan tag included: the game can show the tag a moment after the player is in. Its dry run checks everyone who has played on the server, under each name they used. |
| High ping kick         | Kicks a player whose reported ping remains above a configurable limit for a configurable number of seconds. Normal or unavailable ping, leaving, or interrupted player-list polling resets the timer. Historical ping is not stored, so this rule cannot be replayed in a dry run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Team kill limit        | Whispers a player from N team kills in their current session, and kicks them at M. Needs the [kill feed](#kill-feed); acted on as each kill arrives, not per poll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Kill rate watch        | Flags a player, never kicks, when their kills with hand-held weapons in the last N minutes reach a count, or their share of headshots over those kills reaches a percentage once they have at least M; vehicles, their guns and buildables are not counted. The flag goes to the audit trail and the Discord mirror (the post opens the player's page in the panel), and the same player is flagged again only after a cooldown. Needs the [kill feed](#kill-feed), which has no position or aim, so a flag is a reason to look, not proof. The windows are kept in the worker's memory and start over when it restarts.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Match broadcast        | Announces the result when a match ends and the map as the next one starts, either message optional, with at least N players on. A match ends when the map changes or the faction scores fall back to zero (a faction reached the cap, or an admin ended the round; live builds send no score cap or match clock, so Warcon assumes the game's default of 100), so `{faction}` is whoever led at that moment, tied factions named together. Placeholders `{faction}` `{score}` `{scores}` `{cap}` `{previous}` `{map}` `{server}` `{players}` `{max}`, and from the players' lines of the match that ended `{mvp}` (the most kills, tied players named together) and `{top}` (the top three with their kills). Sent one poll after the round ends.                                                                                                                                                                                                                                                                                                                                   |
| Restart notice         | Broadcasts a heads-up N minutes before the server's scheduled restart and a message once it is due, optionally repeated every N minutes while the round drags on, with at least N players on. The restart itself lands when the round in progress ends. Follows the server's [game restart](#game-restart) schedule. Placeholders `{minutes}` `{uptime}` `{server}` `{map}` `{players}` `{max}`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Seeding reward         | Time a player spends on with at most N players counts as seed time, by default banked only once the server has filled (a count the rule sets, else the limit the server reports) with the player still on, so staying until the threshold and leaving, or a few minutes on an empty server, earns nothing (a switch on the rule counts every low minute instead); M minutes of it over the sessions that ended in the last D days earns a reserved slot for E days, with an optional whisper: on this server only (its own reserved-slot list, which needs the Reserved slots capability) or on every server in the organisation (the org list, which needs Org reserved slots), chosen on the rule. The seeded server applies it at once and, for an org-wide slot, the other servers at their next sync; it lapses on its own and can be earned again; players who already hold a slot here are skipped. Seed time is kept on each session, so the dossier history, the leaderboard's Seed time column and the dry run show it.                                                   |

**Dry run** replays the last 24 hours of the server's own history (joins, player counts, empty
stretches, cached Steam data) against a rule and lists what it would have done, so you can tune a
rule before enabling it. Joins are detected one poll apart, so a welcome arrives `POLL_SECONDS`
after someone connects, or after they pick a faction when the rule is set to wait for that (players
choose a side after joining, so a whisper on join can land while they are still in the menu); the
first poll after a restart or an outage never fires join rules, since everyone present looks like a
joiner then.

### Kill feed

WARDOGS can push every kill to an HTTP endpoint: with `[WDServerFeed] Url` and `Token` set in
`ServerSettings.ini`, the game process POSTs each kill (killer, victim, weapon or vehicle,
distance, headshot and other context) a second or two after it happens. Warcon is that endpoint.
On the server's **Config** tab an org owner clicks **Configure**: Warcon mints a token,
writes both keys into the config document and applies; the game reads them at its next restart
(its scheduled one, see [game restart](#game-restart), or a manual restart). `Url` is the panel's origin alone: the game
appends `/api/ingest/events` to it by itself. The card shows when the last batch arrived, so a
config that did not take is visible.

What the feed adds: a live kill feed on the server's Overview tab, a **Kills** tab with the whole
history (filter by killer, victim, either side, weapon or vehicle, kind of kill and minimum
distance, with a count, older pages and new kills arriving live; the filter lives in the URL, so a
view can be shared), a **Combat** section on Analytics (kills per bucket, weapons, longest kills,
top killers with headshot share and team kills), a Combat card on every player dossier (weapons,
most-killed, nemeses, recent kills and deaths), and the team-kill trigger. Team kills are
inferred: the feed carries no factions, so Warcon uses the factions it observed for both players
at that moment. Kills are history and are
never pruned (a TimescaleDB hypertable with compression where the extension is installed). The
demo server feeds itself once its feed is turned on.

The feed identifies its server by the token alone (the body's `serverId` changes with every
reboot), so each server has its own. The token is stored encrypted, like the RCON password, and
shown to org owners only. `POST /api/ingest/events` is the one `/api` route that takes neither a
session nor an API key, and it is exempt from the CSRF header for the same reason a bearer is.
Configs written by earlier versions hold `Url=<origin>/api/feed/events`, which the game turns into
a path Warcon does not serve. Click **Configure** again (the game reads the new `Url` at its next
restart), or have the proxy in front of the panel rewrite `/api/feed/events/api/ingest/events` to
`/api/ingest/events` until then. It has to be a rewrite, not a redirect: the game follows a 301 or
302 as a GET, which the feed refuses.

### Discord webhooks

A webhook is one Discord channel, and each one carries what is ticked for it. On the
organisation's overview an owner adds channel webhooks (in Discord: channel settings →
Integrations → Webhooks → copy URL) and chooses what to mirror: bans (including org list changes), other game commands, trigger
actions, player notes and watchlist changes, management changes, sign-ins, team kills from the
[kill feed](#kill-feed), watched players joining (with why they are watched, a poll after they
connect; the post opens their page in the panel); for every server or a subset. A separate team-kill channel is a second
webhook with only that box ticked; the server's **Settings** tab connects one in a click. Events are batched into one message per burst, and the URL
(which lets anyone post to the channel) is stored encrypted with `ENCRYPTION_KEY` and never shown
again. **Test** posts a message right away; delivery failures show on the org page.

A webhook can also keep a **live status card** for each server it covers (tick _Keep status
cards in the channel_ on the org page, or open the server's **Settings** tab, paste a webhook and
tick the card, team kills, or both; pin what it posts). Three card styles: **banner** (the default) with the wide map art and a
column of players per faction, **compact** with a map thumbnail, faction counts and the top
three, and **scoreboard** with one ranked table across the factions. The worker edits each card
in place; the banner shows: players online out of the slots
with a bar, map, lighting, mode and zone, a ten-square score bar per faction in the faction's
colour racing to the cap (the card's own colour bar follows the leader), match time, three columns of who is on each side with kills and deaths,
the wide map art, and a relative "updated" stamp Discord keeps current on its own. An unreachable
server shows red with the error and when it was last seen. Edits go out when something changed,
at least 30 seconds apart (longer when many servers share one webhook), plus a refresh every five
minutes, inside Discord's webhook limit. A card someone deleted from the channel is posted again;
pausing the webhook, switching the option off or changing the URL removes the cards, and a server
the webhook stops covering loses its card. Map art and the icon need `ORIGIN` to be https for the
pictures to show.

Each webhook sets how often its cards are edited (**refresh**, 30 seconds to 5 minutes, one
minute by default; the spacing that keeps a shared webhook under Discord's limit still applies
on top) and which **links** its cards carry: the server's public status page, its public
leaderboard, and the panel. The card's title opens the first link and the rest sit on a line
under the body. A public link goes out only while that page is on for the server (see
[Public pages](#public-pages)), so a card never sends people to the sign-in wall; the panel link
is off by default, for staff channels. The server's **Settings** tab has these controls next to
the card style, with the public page switches under them.

### Leaderboards and careers

Every server page has a **Leaderboards** tab: a board over this server or every server of the
organisation you can see, ranked by kills, deaths, K/D, kills per hour of playtime, playtime,
seed time (time on with the server low, as a [Seeding reward](#automation-triggers) counts it),
matches played, wins, win rate or cash, over 7, 30 or 90 days or all time, paged, with sortable
headers. A **playtime floor** (an hour by default) keeps a ten-minute visit off the top of the
K/D board. Every stat is summed from the player's line of each match: the worker records one
row per player per match with the game's own kill and death counters over that match, the
player's time on and side, the change in their cash, and, on servers with a [kill feed](#kill-feed),
the feed's headshots, team kills, suicides, vehicle kills, longest shot and best kill and death
streaks. A match counts once it has ended (the match in progress is on the live page), and the
result (win, loss, draw) is read from the match's winner and final scores against the side the
player played; a match with no winner and nobody scoring, or one abandoned by a restart, has no
result. Playtime and seed time come from player sessions; kills per hour leaves seed time out;
cash is summed over sessions, each banked across its matches like kills. Names link to the dossier.

Each dossier has a **Career** section: rank on the all-time kills board for this server and the
organisation, the current win or loss streak, matches with wins, losses and draws, K/D, kills per
minute, headshot rate and best streak, a table per map and per faction (matches, wins, K/D), and
the last ten matches with map, faction, result, time on, kills, deaths and the change in cash,
each opening its match page. Everything is read at page load from the rows the worker writes;
nothing is precomputed.

Every server page has a **Matches** tab: the match history, newest first, with the map, when it
started, how long it ran, the winner with the final scores (or "abandoned" for a match a restart
closed without a result) and how many played. A match that has ended opens to its page: the
final scores, the score of each faction over the match (from the analytics samples), awards
judged at read time (most kills, best K/D at ten kills or more, longest shot, best streak,
richest match; none for a match under twenty minutes), a sortable scoreboard of every player's
line and the match's kill feed. Both are public too under the leaderboards switch, at
`/s/<id>/matches`.

An org owner can **purge a server's stats** at the foot of its Settings tab: every recorded kill,
match and match row of the server is deleted, for good, after typing the server's name back.
Player sessions stay, since they are presence rather than stats. Careers and boards for the
server start again from the next match, and the match in progress is recorded from the purge on.
The purge is audited with the counts.

### Game restart

A WARDOGS server restarts itself on a schedule, always at the end of the round then in progress.
Which schedule depends on the host, so an org owner sets it per server under **Game restart** on
the Settings tab: after N hours up (the game's own restart, 24 unless set; it was twelve before
September 2026), daily at a time in a time zone (hosts that let you pick the time, such as
BisectHosting: enter the time and zone their panel shows, e.g. `07:00` `America/Chicago`;
daylight saving is followed), or none. The header's restart countdown, the status cards'
"Restarts after this round" and the Restart notice rule all follow it.

### Public pages

Two pages of a server can be opened to anyone with the address. An org owner **switches each on**
per server on the server's **Settings** tab, which shows the addresses to copy (the server's edit
dialog carries the same switches); nothing is public until then.
The site owner can **close** either page for a whole organisation from the org's page, next to
the server limit, which shuts every such page in it at once.

- **Live status** at `/s/<server id>`: map, mode, player count, join code and each team's players
  under its score with kills and deaths, refreshed every twenty seconds. A second switch under it
  adds the last twenty kills from the [kill feed](#kill-feed) (weapon, distance, names only).
- **Leaderboards and careers** at `/s/<server id>/leaderboard` and `/s/<server id>/players/<SteamID>`:
  the same board and career as the panel, over this server or the organisation's servers whose
  leaderboards are public too, with the player's kill-feed record (headshots, longest shot,
  weapons, most killed, nemeses). While this is on, names on the live page open the career.

Public pages never show pings, the build or the panel's own error text (an unreachable server
says only that it could not be reached), and read Steam personas from the cache only. The status
page shows in-game names alone. With leaderboards public, a player's SteamID is public too: it
is the address of their career, and the board, the live page's names and a career's most killed
and nemeses link by it; the board also shows the in-game cash. A public board goes twenty pages
deep (the top thousand); the panel's has no ceiling. A page that is off answers 404, so a closed page looks like no
page. An org owner can set the organisation's **Discord invite** link (discord.gg or
discord.com/invite), shown as a button on its public pages. Each page has a JSON twin under
`/api/public/servers/<id>`, rate limited per address and cacheable for a few seconds.

### Accounts and personal data

An account holds a username, display name, password hash if a password is set, the encrypted
authenticator secret and backup codes if the app is on, passkey public keys, the hash of a
recovery key, sessions (with the browser), the Discord id and avatar URL when Discord
is linked, and a SteamID64 when Steam is linked or the person enters one on the Account page (so
an organisation can hand them a reserved slot). Every sign-in and action is written to the audit
trail with the actor's name and browser. IP addresses are not kept: the panel reads a request's
address to throttle sign-ins and rate limit, in memory, and the login and sign-up lockouts store only a keyed
hash of it. No email address is ever asked for. Nothing else is collected, and nothing leaves
the panel.

Anyone can delete their own account from the **Account** page (right to erasure): password
accounts confirm with the password, the rest by typing their username after a recent sign-in.
Deletion removes the account, its credentials, passkeys, sessions, server roles and organisation
memberships at once. Audit entries the person caused stay for the record but lose their name and
browser, and entries that named them lose the username. The only owner of an organisation, or the only site owner, must
hand over first, so nothing is left without an owner. The site owner can delete anyone from the
Users tab of the Admin page under the same rules.

Analytics store the Steam id and in-game name of every player seen on a server, for a year (see
[Notes and limits](#notes-and-limits)). With `STEAM_API_KEY` set the panel also caches what the
Steam Web API says about each player it sees (persona, avatar, account creation date, ban
counts), and admins can leave notes and watchlist flags on players. If you host the panel for
other people, publish a privacy notice that says so, along with the audit retention you choose.

### Site owner controls

The **Admin** page (site owner only) has three tabs. **Overview** is the whole install at a
glance, refreshed every five seconds: players online, servers reachable, organisations and users,
kill feed and observation rates, the worker's tiers, queue and memory, the web process's request
and error figures, the database's size table by table, players seen today, this month and ever
(a tally cached for five minutes, with a Recount button), servers by game build, and whether the
[Prometheus endpoint](#metrics-prometheus) is on. **Users** manages every account and **Settings**
the runtime settings (cadences, delivery, retention). The old `/users` and `/settings` addresses
redirect to their tabs.

The Orgs page shows every organisation with its creator, member and server counts against its
limit, and status. From there (or from an org's own page) the site owner can raise or lower an
org's server limit and **suspend** it: members lose access to its servers, owners cannot add
servers or mint links, and invite links stop working, until it is restored. Deleting an org removes
its servers from the panel; the accounts stay. The org's page is also where the site owner can
**close** the [public pages](#public-pages) (status page, leaderboards and careers) for that
organisation; they are allowed for every organisation unless closed there.

### Bots and API keys

A Discord bot or a script talks to the same `/api` routes as the panel, with an organisation
**API key** instead of a session. An org owner mints one on the org page under **API keys**: a
label, the capabilities it carries (the same list roles use), which servers it may touch (or every
server the org has, now and later), and an optional expiry. The token is shown once; only its
hash is stored. Keys can read and act on servers and edit the org lists (a key limited to some
servers carries neither _Org ban list_ nor _Org reserved slots_), but never manage the
organisation, its members or its keys, and never reach the site owner's routes.

```sh
# add a reserved slot from a bot: no cookie, no CSRF header, just the bearer
curl -X POST "$ORIGIN/api/orgs/$ORG_ID/lists/reserve/entries" \
  -H "Authorization: Bearer wck_…" -H "Content-Type: application/json" \
  -d '{"steamId":"76561198000000000","reason":"donor"}'
```

Every call a key makes is audited under `<label> (API key)`. Revoking a key on the org page ends
it at once; a suspended organisation's keys stop working with it.

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

Before you push, run what CI runs: `scripts/ci.sh` goes through the same steps in the same order
(install, lint, check, the suites against a throwaway database, the production build and the smoke
test of that build; `--docker` adds the image build) with nothing from `.env`, since CI has none,
and stops at the first step CI would fail on. It needs the `warcon-pg-test` container the tests use
(`CI_DB` names another server) and port 5199 free. To have every push run it first:
`git config core.hooksPath .githooks`.

To run the split roles locally after `bun run build`: `bun run db:migrate`, then
`WARCON_ROLE=worker RELAY_SECRET=… bun run worker` in one terminal and
`WARCON_ROLE=web RELAY_SECRET=… RELAY_URL=http://127.0.0.1:7700 bun run start` in another.
`/api/health` on the web (and `/health` on the worker) answers a plain liveness check for anyone
(a monitor or the container healthcheck reads only `ok`); the worker's tiers, in-flight count,
"behind" and "stuck" figures and the delivery queue are added only for the site owner's own session
or a caller presenting `METRICS_TOKEN`, since they are fleet-wide. The Admin page's Overview tab
shows the same figures to the owner.

The schema is defined in [src/lib/server/db/schema.ts](src/lib/server/db/schema.ts). After changing
it, run `bun run db:generate` to write a new migration into `drizzle/`; the app applies pending
migrations at startup. Add a server with host `demo`, port `1`, password `demo` to use the mock game
server.

## Contributing

Issues, questions and pull requests are all welcome, and none of them needs to be polished. A
report that says "this looked wrong on my server" with a screenshot is useful.

**Contributing right now.** Warcon is early and moving fast: whole areas get rewritten in a week,
and features are pulled when they turn out to be the wrong idea. That makes it a good time to shape
it and a bad time to sit on a large branch. Feature ideas are wanted, and an issue that says what
you run and what you wish the panel did is as valuable as code. Bug reports, small fixes and tests
land quickly and survive rewrites. For anything bigger, open an issue first so it can be matched
against what is already in flight. What will not happen while this is true is a rewrite held back
to keep a pull request mergeable, so a change that lands before the code around it moves may be
reworked afterwards. That is not a judgement on the work.

What a change needs before it is merged:

- It works, and where the code is testable it has a test. Tests sit next to the code as
  `*.test.ts` and run with `bun test`.
- A new route, page load or game action has a line in the permission matrices under
  [src/test](src/test): they ask every route as every kind of person and key, and fail when one
  is missing. They need a Postgres to make a throwaway database on, named by
  `TEST_DATABASE_URL` (see `.env.example`); without it they are skipped locally, and CI runs them.
- CI passes: `bun run lint` (Prettier), `bun run check` (svelte-check), `bun test`,
  `bun run build` and the smoke test of the build, the steps [ci.yml](.github/workflows/ci.yml)
  runs; `scripts/ci.sh` runs them here first.
- The commit message says what behaviour changed, in plain words. Small whole commits are easier
  to review than one large one.
- It keeps data: analytics roll up rather than get pruned, and history stays.
- It considers per-server cost. A hosted install runs hundreds of servers on one worker, so a query
  per server per observation is hundreds of queries a second; servers a feature does not apply to
  should cost nothing.

Use whatever tools help you write it, including AI assistants; you do not need to declare which.
The change is what gets reviewed: does it work, is it tested, does the message say what it does.
You are the author of what you submit, so understand it and be ready to answer questions about it.
Warcon takes the same position the Linux kernel does, put plainly by Linus Torvalds in
[July 2026](https://lore.kernel.org/linux-media/CAHk-=wi4zC+Ze8e+p3tMv8TtG_80KzsZ1syL9anBtmEh5Z40vg@mail.gmail.com/):
AI is a tool like any other, contributions are judged on technical merit, and arguing against
other people using it is not a conversation this project will have.

The protocol notes in [docs/wardogs-api.md](docs/wardogs-api.md) describe what the game server
exposes; anything not in there is unknown to Warcon as well.

## Layout

```
src/hooks.server.ts            startup (role, gateway, worker in-process for `all`), session lookup, Better Auth handler, CSRF header check
src/worker/worker.ts           the worker process entry (WARCON_ROLE=worker); runtime.ts serves the relay; migrate.ts = bun run db:migrate
scripts/build-worker.ts        bundles the worker with Bun (shims $env and $app), run by bun run build
scripts/ci.sh                  what CI runs, step for step, on this machine; scripts/smoke.sh is its end-to-end pass over a fresh instance
src/lib/server/env.ts          process config + the database connection
src/lib/server/db/schema.ts    every table, as Drizzle definitions (source of truth for migrations)
src/lib/server/db/index.ts     Bun SQL client + Drizzle + migration runner
drizzle/                       generated SQL migrations (bun run db:generate) + TimescaleDB setup
src/lib/server/auth.ts         Better Auth config (username, admin, two-factor, passkey plugins; Drizzle adapter)
src/lib/enrolment.ts           the sign-in rules (two ways in, second factor on passwords); server/enrolment.ts applies them
src/lib/server/steam-openid.ts Steam sign-in (OpenID 2.0); recovery.ts recovery keys; auth-plugin.ts sessions for both
src/lib/capabilities.ts        the capability vocabulary and the built-in role defaults (client-safe)
src/lib/server/access.ts       global and org roles, per-server capability access, accessible servers, login throttling
src/lib/server/roles.ts        an organisation's editable server roles (built-ins seeded per org)
src/lib/server/apikeys.ts / apikeys-core.ts   organisation API keys for bots: mint, resolve bearers, revoke (db) / token format and scope (pure)
src/lib/server/users.ts        account management on top of Better Auth (create, disable, reset, grants)
src/lib/server/orgs.ts         organisations: members, per-server roles, invite links, joining
src/lib/server/servers.ts      server records, reachability test, per-server grants
src/lib/server/lists.ts        organisation ban and reserved-slot lists and each server's own reserved slots: entries, per-server standing, views
src/lib/server/lists-plan.ts / lists-sync.ts   what to add or remove on a server (pure) / the per-server sync run and API fan-out
src/lib/server/actions.ts      every panel action -> capability + /v1 call(s)
src/lib/server/rcon-run.ts     /api/servers/:id/rcon/:action dispatcher with audit rows
src/lib/server/rcon.ts         WardogsClient (Bearer auth, JSON/text calls, demo routing)
src/lib/server/transport.ts    fetch to the game server
src/lib/server/poller.ts       the worker's scheduler: tiers, phases, concurrency budget, roster, housekeeping, stats
src/lib/server/poller-schedule.ts  the scheduler's maths (phase per server, next due, budget) — pure
src/lib/server/feed-core.ts    the kill feed's batch format and parsing — pure
src/lib/server/feed.ts         feed tokens, batch ingest into `kills` (open match and factions attached), the stored feed
src/lib/server/feed-events.ts  what the worker does with a batch: publish to browsers, run the team-kill rules, the demo's own feed
src/lib/server/observe.ts      one observation: status/players, session diff, trigger evaluation, one fenced transaction, live snapshot, samples
src/lib/server/sessions.ts     player presence in memory, batched session writes (join, leave, heartbeat)
src/lib/server/outbox.ts       trigger delivery loop: claim with a lease, send through the lane, record the outcome
src/lib/server/rollups.ts      hourly sample rollups behind the long ranges
src/lib/server/dispatcher.ts   one lane per game server: one request in flight, humans ahead of the worker
src/lib/server/leadership.ts   the worker lease and the fenced transaction every worker write uses
src/lib/server/live.ts / events.ts / interest.ts   live snapshot rows, the in-process event bus, watch leases
src/lib/server/gateway.ts      the web↔worker seam; gateway-local.ts (same process), gateway-remote.ts + relay.ts (HTTP)
src/lib/server/settings.ts     owner-editable runtime settings (site_settings): keys, bounds, hot reload
src/lib/server/players.ts      dossiers, notes, watchlist, per-player marks (risk) for the players table
src/lib/leaderboard.ts / server/leaderboards.ts   board and career maths (pure) / the queries over kills, sessions and matches
src/lib/features.ts            which public pages a server has: the site owner's allowance and the server's switch (pure)
src/lib/server/public.ts       the public surface: 404 gates, the public status shape, per-address limits
src/lib/server/steam.ts        Steam Web API lookups cached in steam_profiles
src/lib/server/risk.ts         advisory risk score and name resemblance (pure)
src/lib/server/trigger-rules.ts / triggers.ts   trigger settings and verdicts (pure) / evaluation into intents, dry runs
src/lib/server/webhooks.ts     Discord webhook records; webhook-delivery.ts batches audit rows to Discord
src/lib/server/analytics.ts    analytics queries per server and range
src/lib/server/audit.ts        audit writer/query with secret redaction
src/lib/server/mockgame.ts     in-process imitation of the WDRCON API for demo/testing
src/lib/config-doc.ts / config-fields.ts   ServerSettings.ini parser and line-level setter (pure, tested) / the keys the config form manages
src/lib/components/            Modal, MapPicker, PopulationChart, CashChart, ConfigForm, Toasts, badges…
src/routes/(auth)/             /sign-in (+ /verify), /setup, /join/[token], /recover (form actions)     src/routes/sign-out
src/routes/api/passkeys/       WebAuthn ceremonies relayed to Better Auth; src/routes/auth/steam/ the Steam callback
src/routes/(app)/              dashboard, /server/[id]/{,players,players/[steamId],bans,rotation,config,automation,analytics,leaderboard,log,settings}, /audit, /orgs, /orgs/[id]/{,bans,reserved}, /admin/{,users,settings}, /servers, /account
src/routes/(public)/           /s/[id]{,/leaderboard,/players/[steamId]}: the public pages, no session
src/routes/api/                JSON API (below)
docs/wardogs-api.md            the reverse-engineered game-server API
```

### API cheatsheet

All `/api` calls need either the session cookie (mutations then also need
`X-Requested-With: warcon`) or an organisation API key as `Authorization: Bearer wck_…` (see
[Bots and API keys](#bots-and-api-keys)).
Sign-in, setup, password change and session revocation are SvelteKit form actions on their pages,
which call Better Auth server-side behind the login lockout and the audit trail. Of Better Auth's
own `/api/auth/*` routes only the OAuth callback is reachable over HTTP; everything else answers 404.

```
GET/POST /api/orgs  PATCH/DELETE /api/orgs/:id   PATCH {name} | {discordInviteUrl} | {membersReserved} | {banMessage} | site owner: {serverLimit, suspended, reason, allowPublicStatus, allowPublicLeaderboards}
GET  /api/orgs/:id/members  PATCH/DELETE /api/orgs/:id/members/:userId {role}  PUT .../:userId/grants {grants:[{serverId,roleId}]}
GET/POST /api/orgs/:id/roles {name,capabilities[]}  PATCH/DELETE .../:roleId {name?,capabilities?}  POST .../:roleId/reset
GET/POST /api/orgs/:id/keys {label,capabilities[],serverIds[]|null,expiresDays}  DELETE .../:keyId   (POST returns the token once)
GET/POST /api/orgs/:id/invites {label,orgRole,serverRoleId,expiresDays,maxUses}  DELETE /api/orgs/:id/invites/:inviteId
GET/POST /api/users  PATCH/DELETE /api/users/:id  PUT /api/users/:id/grants {grants:[{serverId,roleId}]}
GET/POST /api/servers {orgId,...}  PATCH/DELETE /api/servers/:id  POST /api/servers/:id/test   (PATCH also {publicStatus, publicLeaderboards, publicKills}, org owners, within the site owner's allowance; a PATCH that changes host, port or scheme must carry password, or it is 400 password_required)
GET/PUT /api/servers/:id/grants {grants:[{userId,roleId}]}   GET /api/servers/:id/summary
GET|POST /api/servers/:id/rcon/:action   (GET for reads with query params, POST JSON for mutations)
GET  /api/servers/:id/analytics?range=24h|7d|30d       includes `combat` from the kill feed when the server has one
GET  /api/servers/:id/kills?before=<iso>&beforeTime=<s>&limit=50&count=1&match=<matchId>   the stored kill feed, newest first; `count=1` adds the total, `match` narrows it to one match; `kills` frames on /api/live/events carry new ones
GET  /api/servers/:id/matches?page=1                    match history, newest first, fifty a page   GET /api/servers/:id/matches/:matchId   a match that ended: lines, score timeline, awards
POST /api/servers/:id/stats/purge {name}                 deletes the server's kills, matches and match rows (org owners; the name must be the server's; sessions stay)
     &killer=&victim=&player=&cause=&kind=&minM=            filters: a SteamID exactly, else part of a name; the raw cause tag; kind headshot|teamKill|suicide|vehicle|environment; metres at least
GET/POST/DELETE /api/servers/:id/feed                   the kill feed setup: token and URL (POST mints or replaces, owners only)
POST /api/ingest/events                                 where the game posts: [WDServerFeed] Url is the origin, the game adds this path (Authorization: Bearer wkf_…); not a panel route
GET  /api/servers/:id/cash?since=<iso>                  cash-in-play samples since a moment (24 h at most), seeds the dashboard chart
GET  /api/servers/:id/players/marks?ids=a,b&names=…     watchlist / first-visit / risk per connected player
GET  /api/servers/:id/players/:steamId                  dossier   POST .../steam (refresh Steam data)   GET .../career   rank, streak, results by map and faction, the last ten matches
GET  /api/servers/:id/leaderboard?scope=server|org&range=7d|30d|90d|all&sort=kills|deaths|kd|perHour|playtime|matches|wins|winRate|cash&dir=desc|asc&page=1&minMinutes=60
POST /api/servers/:id/players/:steamId/notes {body}     DELETE .../notes/:noteId   PUT .../watch {watched,reason}
GET/POST /api/servers/:id/triggers {kind,name,enabled,config}   PATCH/DELETE .../:triggerId   POST .../dry-run {kind,config}
GET/POST /api/orgs/:id/webhooks {label,url,events,serverIds,enabled,statusEnabled,statusStyle,statusIntervalS,linkStatus,linkLeaderboard,linkPanel}   PATCH/DELETE .../:webhookId   POST .../:webhookId/test
GET  /api/public/servers/:id   .../leaderboard (same query as above, page 20 at most)   .../players/:steamId      the public pages' JSON: no session, 404 while the page is off, limited per address
GET  /api/orgs/:id/lists                                 the org lists the caller edits (kinds), with counts, and the caller's role on them
GET/POST /api/orgs/:id/lists/:kind/entries {steamId,reason,expiresAt}   PATCH {reason,expiresAt} / DELETE .../entries/:steamId   (kind = ban | reserve, needing Org ban list or Org reserved slots; ?includeRemoved=1)
POST /api/orgs/:id/lists/sync                            push the lists to every org server now
GET  /api/orgs/:id/lists/import                          server entries not on the org list   POST {entries:[{kind,steamId,reason}]} adopts them (owner)
GET  /api/servers/:id/players/seen?q=&since=&flag=&sort=&dir=&offset=&limit=   everyone who has played on this server, by name, alias or SteamID (View; 60 a minute)
GET  /api/servers/:id/lists/state                        which bans / reserved slots here come from the org lists or this server's own   POST .../lists/sync
POST /api/servers/:id/lists/ban/entries {steamId,reason,expiresAt}       ban on this server only, placed on sight if the player is away (Bans)   PATCH {reason,expiresAt} / DELETE .../entries/:steamId
POST /api/servers/:id/lists/reserve/entries {steamId,reason,expiresAt}   reserve on this server only (Reserved slots)   DELETE .../entries/:steamId
GET  /api/actions                     lists actions with the capability each needs
GET  /api/audit?server=&actor=&action=&outcome=&q=&from=&to=&before=&limit=
GET  /api/audit/export?format=csv|json GET /api/audit/meta
GET  /api/steam/profiles?ids=a,b      GET /api/health
```

Actions, by the capability each needs: `capabilities status health serverId players maps lightings
experiences alternators catalog rotation bans reserved sponsor` (View) ·
`broadcast whisper` (Chat) · `kick kill changeTeam` (Kick, kill, move) · `endMatch restartMatch
changeMap setWeather setNextMap` (Match control) · `rotationAdd rotationRemove rotationMove
rotationReorder` (Live rotation) · `ban unban` (Bans) · `reservedAdd reservedRemove` (Reserved
slots) · `rotationSave rotationSettings` (Save rotation) · `config settings configValidate configApply` (Config &
settings) · `serverLog` (Audit trail) · `raw` (Raw RCON).

## Notes and limits

- Analytics are derived from observation: player sessions are accurate to the cadence in force
  (a second or two on a busy server). A player missing from the list for under a minute is still
  in their session (the game reports nobody while a new map loads), and a leave is dated to the
  last time they were seen. Match boundaries are inferred from map changes, the
  faction scores falling back to zero and, on builds that send one, the match clock. Nothing is
  deleted: raw samples, their hourly rollups (behind the 30-day charts), sessions and matches are
  kept for good. On TimescaleDB, samples older than two weeks are compressed in place.
- Several `web` processes can share one database and one worker; the worker's lease makes exactly
  one process observe, and a second worker takes over within seconds if the first stops renewing.
  Run `WARCON_ROLE=all` as a single replica only: two `all` processes would each keep their own
  live view and lanes, and browsers on the one that does not hold the lease would see nothing live.
- Apart from the kill feed, the game has no push API. Freshness is the observation cadence, which the owner sets; the
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
