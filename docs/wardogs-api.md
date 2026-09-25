# WARDOGS dedicated-server RCON API (WDRCON)

Reverse-engineered on 2026-09-08 from the official web console at `http://rcon.wardogs.com`, re-checked
against the 2026-09-10 and 2026-09-14 redeploys of the site
(`js/api.js`, `js/mock-server.js`, `js/config-editor.js`, `ServerSettings.ini`) and against live build
CL-501228 on 2026-09-14. The console is a
static, plain-HTTP-only site that talks to the game server **directly from the browser**, which is
why it cannot be served over HTTPS. Warcon moves that traffic server-side: browsers talk HTTPS to
Warcon, and Warcon's own process talks plain HTTP to the listener.

## Transport

* Plain HTTP/1.1 JSON API on the port from `[/Script/WDRCON.WDRCONSettings] Port` (default 7776).
* `Authorization: Bearer <rcon password>` on every request. The password is `Password=` in the
  ini (or auto-generated into `Saved/RCON/ADMIN-PASSWORD.txt`), or a pre-hashed `PasswordHash=`.
* `BindAddress=127.0.0.1` allows a plaintext password. `0.0.0.0` "needs TLS + PasswordHash"
  according to the ini comments, yet the official console only ever uses `http://`. In practice
  hosts put the listener behind a reverse proxy or expose it plain. Warcon supports both schemes.
* Errors: non-2xx with JSON `{ "error": { "code", "message" } }`. Success bodies for mutations are
  usually `{ "message": "..." }`. A route the build does not serve is `404 { code:"not_found",
  message:"No such endpoint." }` and a wrong method `405 { code:"method_not_allowed", message:"PUT is
  not supported on this endpoint." }`; missing items use their own codes (`ban_not_found`). Warcon's
  client renames the first to `no_route` so "not served" is never mistaken for "not there".
* Config routes use `text/plain` bodies and `If-Match: "<revision>"`; `412` means revision mismatch.
  Since CL-501228 `GET /v1/config` also sends the revision as `ETag: "<revision>"`, and every
  response carries `Access-Control-Expose-Headers: ETag, Retry-After`: the per-IP limit below is
  answered with `429` and a `Retry-After`. Warcon reads both (`etagOf`, `parseRetryAfterMs` in
  `src/lib/server/rcon.ts`); a 429 holds the worker's next look for the stated time (1–60 s, 5 s
  when absent) without counting as an outage, and aborts a list sync run so it retries later.
* Limits reported by a live build on 2026-09-11 (`capabilities` via a third-party CLI, build
  `++Wardogs+Live-CL-499480`, "API version 1"): **600 requests/min per client IP** and a
  **65,536-byte body cap**; that build served 28 routes, so real servers lack some of the routes
  below (the web console feature-detects). Warcon's worker at the tightest allowed cadence (players
  every 500 ms, status every 1 s) sends 180/min per server, under the cap with room for page reads;
  the browser console alone would add about 47/min. Config documents over 64 KiB will be refused by
  the listener; the TLR document with 78 rotation entries is about 10 KB.

## Routes

| Method | Path | Body / query | Response | Notes |
|---|---|---|---|---|
| GET | `/v1/capabilities` | | `{ apiVersion, build, auth:{scheme,header}, limits:{maxBodyBytes,maxRequestsPerMinutePerIp}, config:{writable,document}, routes:["GET /v1/status", ...] }` | Console feature-detects `PATCH /v1/players/{id}` (change team), `GET /v1/server-id` and `PUT /v1/config`. Warcon shows `build` and the routes under Servers → Test, and the worker re-reads it hourly. |
| GET | `/v1/server-id` | | `{ serverId: "<uuid>" }` | **New in CL-501228.** The server's join code, issued by the WARDOGS backend; read-only. Warcon action `serverId`; shown as "Join code" in the server header (click to copy), the connection test and, as a copyable code block, on the Discord status card. |
| GET | `/v1/status` | | `{ serverName, map, experiences[], lighting, alternator, scoreTick:{current,min,max}, scoreCap, matchSeconds, players:{current,max}, factionScores:[{name,colorHex,score}], rotation:{nowIndex,nextIndex} }` | Live builds CL-499480 (2026-09-11) and CL-501228 (2026-09-17, TLR host) send **no `scoreCap` and no `matchSeconds`**; the mock has them, Warcon treats both as optional. So on live servers a new match is only visible as a map change (or, on servers that feed kills, as the feed's `eventTime` resetting), and the cap a faction plays to is not readable. `MOCK_LIVE_BUILD` drops both from the mock too. `players.max` is the public cap: `MaxPlayers` less `MaxReservedSlots` (98 for `MaxPlayers=100`, `MaxReservedSlots=2`); Warcon shows the held-back slots beside it from the config document. |
| GET | `/v1/players` | | `{ players:[{name, steamId, faction, kills, deaths, cash, pingMs}], count }` | Confirmed on CL-499480. List responses all carry `count`. |
| POST | `/v1/players/{steamId}/kick` | `{ reason }` | `{ message }` | |
| POST | `/v1/players/{steamId}/kill` | | `{ message }` | |
| POST | `/v1/players/{steamId}/message` | `{ message }` | `{ message }` | Whisper. |
| PATCH | `/v1/players/{steamId}` | `{ faction }` | `{ message }` | Faction **name** (e.g. `Valkyra`), resolved via `factionScores[].colorHex`. Optional route. The console follows it with `POST .../kill` so the player respawns on the new side; a failed kill (no living character) is ignored. Warcon does the same. |
| POST | `/v1/broadcast` | `{ message }` | `{ message }` | ≤200 chars in the console. |
| GET | `/v1/bans` | | `{ bans:[{steamId, bannedAtUtc, bannedBy, reason}], count }` | Entries from `+DefaultBannedPlayerIds` come back with `bannedBy:"config"`, `reason:null`, `bannedAtUtc:"0001-01-01T00:00:00.000Z"`; Warcon blanks that date. |
| POST | `/v1/bans` | `{ steamId, reason? }` | `{ message }` | Persists to `+DefaultBannedPlayerIds`. |
| DELETE | `/v1/bans/{steamId}` | | `{ message }` | Unknown id: `404 { code:"ban_not_found", message:"Error: SteamId … is not currently banned." }`. |
| GET | `/v1/reserved-slots` | | `{ reservedSlots:[steamId], count }` | Permanent only on real servers (the console carries a `reservedExpiry` flag and `expiresAtUtc`, but only its mock sets them). The list has no length limit: anyone on it skips the join queue; `MaxReservedSlots` only says how many player slots are held back for them. |
| POST | `/v1/reserved-slots` | `{ steamId }` | `{ message }` | **Not served by live builds CL-499480 / CL-501228.** Both the console (since 2026-09-14) and Warcon then edit `DefaultReservedPlayerIds` in the config document instead: `GET /v1/config`, add the id, `PUT /v1/config` with `If-Match` (`src/lib/reserved-doc.ts`, `reservedViaConfig` in `actions.ts`); Warcon keeps the live-route error codes (`already_reserved`, `reserved_not_found`) so the org list sync behaves the same either way. The console's mock refused adds beyond `MaxReservedSlots` with a `reserved_full` 409; no real server does, and Warcon no longer imitates it. **The running server does not re-read the array until it restarts** (seen 2026-09-15 on a CL-501228 host: withdrawn from the document, still returned by `GET /v1/reserved-slots` five minutes later, and the 24-hour self-restart is when it clears). Warcon re-reads the live list after every document edit and reports `pendingRestart`; the slots page badges such ids "leaves at restart" / "arrives at restart" and offers no second Withdraw. `MOCK_LIVE_BUILD` reproduces it. |
| DELETE | `/v1/reserved-slots/{steamId}` | | `{ message }` | **Not served by live builds**; same document fallback. |
| GET | `/v1/catalog/maps` | | `{ maps:[{id, displayName}] }` | Map ids: `Kavkazi` (Bakurani), `Europe` (Ozeti), `NorthAmerica` (Zestafona). |
| GET | `/v1/catalog/lightings` | | `{ lightings:[{id, displayName}] }` | `DayStartClear`, `DayEarlyClear`, `DayEarlyFog`, `DayClear`, `DayLateClear`, `DayLateGray`, `DayLateGrayFog`, `DayEndClear`. |
| GET | `/v1/catalog/experiences` | | `{ experiences:[{id, displayName}] }` | Game modes (`*_KOTH_01`) and modifiers (`KOTH_InfantryOnly`, `KOTH_Hardcore`). |
| GET | `/v1/catalog/maps/{map}/experiences` | | `{ map, experiences:[id], count }` | |
| GET | `/v1/catalog/maps/{map}/alternators` | | `{ map, alternators:[{index, tag, displayName}], count }` | Control-zone alternators, e.g. `ZoneAlternator.Bakurani.Default.Circle`; `index`/`map`/`count` appeared in CL-501228. |
| POST | `/v1/match/map` | `{ map, experiences?, lighting?, zoneAlternator? }` | `{ message }` | Travels when the match-end screen finishes. |
| POST | `/v1/match/end` | | `{ message }` | Advances rotation (or reloads current map when rotation off). |
| POST | `/v1/match/restart` | | `{ message }` | Reloads current map, rotation pointer untouched, config not re-read. |
| PUT | `/v1/world/lighting` | `{ lighting }` | `{ message }` | |
| GET | `/v1/rotation` | | `{ enabled, mode:"ordered"\|"random", entries:[{index, map, experiences[], lighting, zoneAlternator?, status:"now"\|"next"\|null, denied}] }` | `denied` = entry references an experience the server does not know. CL-499480 sends `index` per entry and `status:null` for plain entries. |
| POST | `/v1/rotation/entries` | map selection | `{ message }` | Live edit. **Not served by live build CL-499480** (nor the three routes below): the rotation there is edited only through the config document. |
| DELETE | `/v1/rotation/entries/{index}` | | `{ message }` | **Not served by CL-499480.** |
| POST | `/v1/rotation/entries/{index}/move` | `{ direction:"up"\|"down" }` | `{ message }` | The console reorders by repeating this. **Not served by CL-499480**, so "set as next map" is impossible there. |
| POST | `/v1/rotation/save` | | `{ message }` | Writes rotation to the config; needs `-StandaloneConfig=<path>`. **Not served by CL-499480.** |
| PATCH | `/v1/settings` | `{ scoreTick?, rotationEnabled?, rotationMode? }` | `{ message }` | The only live settings route. **Not served by CL-499480**: `ScorePeriod`, `bEnabled`, `RotationMode` go through the config document there. |
| GET | `/v1/sponsor` | | `{ imageUrl }` | On the TLR server the file holds `ServerImageURL="https://tlrgaming.com/…"` (quoted) yet this returns `"https:"`: the advertised value is whatever the server last accepted, and that host is not on `ImageURLWhitelist`, so the stale startup parse (cut at `//`) stands until an allow-listed URL is applied. |
| ~~PUT~~ | ~~`/v1/sponsor`~~ | | `405 PUT is not supported on this endpoint` | **Removed.** `api.js` still defines `setSponsor` but nothing calls it; the console's "Server Image" card is the `ServerImageURL` config field applied through `PUT /v1/config` (reported `pending` while the server fetches and checks the image). No live route exists without a config document. |
| GET | `/v1/health` | | `{ status:"ok", uptimeSeconds, connections:{active}, gameThreadQueue:{inFlight, depth, rejectedTotal} }` | Served by CL-499480; the web console never calls it. Warcon action `health`. The worker reads it with every status observation and keeps `now - uptimeSeconds` as `server_live.started_at`: the header shows the uptime and whether the game's own 24-hour restart (fixed in WARDOGS, `RESTART_AFTER_HOURS` in `src/lib/uptime.ts`) is due. WARDOGS does not restart on the mark but when the round then in progress ends, so past the threshold the header and the Discord status cards say "restarts after this round". Not yet verified on the TLR host whether `uptimeSeconds` counts from the game process or from the listener. |
| GET | `/v1/audit?limit=N` | | `{ limit, entries:[{timestampUtc, peer, sessionId, event, detail}], count }` | Listener log. The mock's events are `ACCEPT`, `AUTH_OK`, `AUTH_FAIL`, `REJECT`, `COMMAND`, `CLOSE`; CL-499480 writes two lines per request, `AUTH_OK` (detail null) then `HTTP` with detail `GET /v1/players -> 200`. On the TLR host every peer is `127.0.0.1:<port>` because a local proxy fronts the listener (`BindAddress=127.0.0.1`), so the per-IP rate limit there is shared by every client. N ≤ 500. |
| GET | `/v1/config` | | `{ revision, writable, text, sections:[{section, appliesWhen, description, allowedKeys[], keyOverrides:[{key, appliesWhen, description, writable, lockedBy}]}], warnings[] }` (+ `ETag`) | Whole `ServerSettings.ini`. **CL-501228** adds `writable` and `lockedBy` per key override: a key pinned by a launch argument (`ServerName` by `-RCON_FixedServerName`, `Port` by `-RCONPort` on the TLR host) comes back `writable:false` with the switch in `lockedBy` and "Pinned by -RCONPort on this server's command line. The value is shown but cannot be changed here." The console shows a "Fixed" badge and disables the input; Warcon does the same (`lockedFor` / `lockedKeys` in `src/lib/config-fields.ts`) and lists pinned keys under the document. CL-499480's schema (mirrored in `mockgame.ts`): `WDGameSession` applied (`ServerImageURL` pending, password and join limits applied on the next session update), `Engine.GameSession` next-restart, `WDGameStateSession` / `KOTH` / `PreMatch` next-match, rotation applied ("rebuilt immediately; used from the next map change"), `WDRCONSettings` and `WDServerFeed` next-restart. |
| POST | `/v1/config/validate` | text/plain ini | apply result | Dry run. |
| PUT | `/v1/config?force=true&fullApply=true` | text/plain ini, `If-Match: "rev"` | `{ ok, revision, outcomes:[{section,state,detail}], shadowed[], stripped[], errors[], changed[], conflict[], warnings[], timingsMs }` | `state` ∈ `applied`, `next-match`, `next-restart`, `pending`. 412 on revision mismatch unless `force`. |

"Set as next map" is not a route: the console finds (or adds) the selection in the rotation and
moves it into the slot after the `now` entry with repeated `/move` calls. Warcon does the same server-side.

### What live build CL-501228 actually serves (captured 2026-09-14)

`GET /v1/capabilities` on the TLR server (`++Wardogs+Live-CL-501228`, the patch of 2026-09-14)
returned 29 routes: everything above **except** `POST`/`DELETE /v1/reserved-slots`, the four
`/v1/rotation/...` write routes, `PATCH /v1/settings` and `PUT /v1/sponsor`, plus two the console
did not originally know, `GET /v1/health` and (new in this build) `GET /v1/server-id`. CL-499480
(2026-09-11) served the same 28 minus `server-id`. Player routes are spelled `{id}` rather than
`{steamId}`. The document also carries `apiVersion`, `build`,
`auth:{scheme:"bearer",header:"Authorization"}`, `limits:{maxBodyBytes,maxRequestsPerMinutePerIp}`
and `config:{writable,document:"/v1/config"}`. Warcon reads the flags it needs into `Features`
(`reservedSlots`, `rotationEdit`, `rotationSave`, `liveSettings`, `serverId`). Without
`rotationEdit` the Map rotation tab keeps its table and buttons but stages edits and writes the
rotation section of the config document in one apply (`src/lib/rotation-doc.ts`); without
`reservedSlots` the Reserved slots tab and the org list sync write `DefaultReservedPlayerIds` the
same way (`src/lib/reserved-doc.ts`); the remaining controls disable and point at the document.
The worker re-reads capabilities and the server id once an hour per server (and after an outage)
into `server_live`, so the header, the Discord status cards and the list sync share one answer;
Servers → Test reads them fresh and drops the caches. Set `MOCK_LIVE_BUILD=true` to make the demo
servers behave like this build (routes, pinned `ServerName`/`Port`, the live build string), and
`MOCK_RATE_LIMIT_EVERY=N` to have the demo answer every Nth request with a 429 and `Retry-After: 2`
so the worker's hold can be watched. The
authoritative list for any server is its own `routes` array; Warcon shows it under Servers, Test,
"Routes this build serves".

## ServerSettings.ini keys the server honours

```
[/Script/WDGame.WDGameSession]           ServerName, ServerPassword, ServerMin/MaxPlayerCash, ServerMin/MaxPlayerLevel,
                                          ServerImageURL, MaxReservedSlots, +DefaultReservedPlayerIds, +DefaultBannedPlayerIds
[/Script/Engine.GameSession]              MaxPlayers
[MatchState.PreMatch.WaitingForPlayers.PlayerCount]  MinimumRequiredPlayers
[MatchState.Playing.KOTH]                 ScorePeriod (18-30)
[/Script/WDGame.WDGameStateSession]       bLockOverpopulatedTeamsConfig, OverpopulatedTeamThresholdConfig
[/Script/WDGame.WDServerMapRotationSettings]  bEnabled, RotationMode, +RotationEntries=(Map="",Experience(s)="",Lighting="",ZoneAlternator="")
[/Script/WDRCON.WDRCONSettings]           bEnabled, BindAddress, Port, Password, PasswordHash, AllowedOrigins, bWriteAuditLogFile
[WDServerFeed]                            Url, Token          (CL-499480: "kill-event feed endpoint and its ingest token")
```

`MaxReservedSlots` is not a limit on `DefaultReservedPlayerIds`: the server takes the list at
any length, and everyone on it skips the join queue (also with `MaxReservedSlots=0`). It is the
number of `MaxPlayers` held back from public joins for them, which is why the TLR server with
`MaxPlayers=100` and `MaxReservedSlots=2` reports `players.max` 98: 98 public + 2 reserved.

`allowedKeys` on CL-499480 also lists `PlayerIdentityEntries` under `WDGameSession` and
`AllowedOrigins` under the RCON block, and CL-501228 adds `bWriteAuditLogFile` there (presumably
whether the listener log `GET /v1/audit` shows is also written to disk); none is documented in the
reference ini, and nothing on rcon.wardogs.com mentions any of the four. Warcon leaves the RCON
block to the raw editor, as before. `WDServerFeed` (`Url` + `Token`) is a push feed the host may point anywhere: once both keys are
set (read at startup), the game process POSTs JSON to **`Url` + `/api/ingest/events`** (the
suffix is the game's own and is always appended; `Url` is a base, confirmed 2026-09-17 by a
capture on the hosted panel where `Url=https://console.warcon.app/api/feed/events` produced posts
to `/api/feed/events/api/ingest/events`) with `Authorization: Bearer <Token>` and user agent
`Wardogs/++Wardogs+Live-CL-501228 (http-eventloop) Linux/debian12`. A quoted `Url="https://…"`
is read correctly at startup. Captured on 2026-09-16 from the TLR server through a request bin
set as the base (3 h 26 m, 1900 posts, 2435 kills):

```
{ "serverId": "<uuid>",          // a per-boot game instance id, not the join code from GET /v1/server-id
  "serverName": "...",
  "events": [ { "eventId": "<uuid>", "type": "killed", "eventTime": 3317.77, "matchId": "<uuid>",
                "mapName": "Kavkazi", "killerName", "killerId", "killerSteamId", "victimName",
                "victimId", "victimSteamId", "cause": "Id.Item.AK74M", "distance": 704.87,
                "contextTags": ["Meta.Progression.Context.Player.KillContext.Headshot",
                                "Meta.PlayerKillFlag.Player.Local.Kill", "Meta.PlayerKillFlag.Player.Local.Death"] } ] }
```

Batches flush about every two seconds (one to ten events, in clock order). `eventTime` is the
match clock (it reset at the map change, like `matchSeconds`); `matchId` did **not** change at the
map change, so treat it as per boot too. `killerName`/`killerId`/`killerSteamId` are absent on
environment deaths, `cause` on falls, `distance` (Unreal units, centimetres) on vehicle
explosions and most suicides. Tags seen: `Headshot`, `Penetration`, `Ricochet`, `WeaponMelee`,
`VehicleExplosion`, `RoadKill`, `Falling` (all `Meta.Progression.Context.Player.KillContext.*`),
`Suicide` and the constant `Local.Kill`/`Local.Death` (`Meta.PlayerKillFlag.Player.*`). No faction
on either side. Only `killed` was seen; other types may exist. Warcon retains every event's
original JSON and event type, while kill views and statistics use only complete `killed` events.
Whether the game buffers while the endpoint is down is not known. Warcon serves the endpoint at
`POST /api/ingest/events` and writes
`Url=<origin>` with a per-server token (README, "Kill feed"); a config written before the suffix
was known (`Url=<origin>/api/feed/events`) needs Configure again, and Warcon keeps building the
scoreboard's kill and cash totals as before.

Only `ScorePeriod`, `bEnabled` and `RotationMode` have live routes; everything else changes via the
config document (PUT `/v1/config`) or by editing the ini and restarting.

## Steam lookup sidecar

The console optionally calls `GET /api/steam/profiles?ids=a,b,c` with header `X-Steam-Api-Key` on
whatever host serves it, expecting `{ "<steamId>": { name, avatar } }`. Warcon implements the same
route using a server-side `STEAM_API_KEY` secret instead of a per-browser key.
