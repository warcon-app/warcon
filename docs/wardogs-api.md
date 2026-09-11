# WARDOGS dedicated-server RCON API (WDRCON)

Reverse-engineered on 2026-09-08 from the official web console at `http://rcon.wardogs.com`, re-checked
against the 2026-09-10 redeploy of the site
(`js/api.js`, `js/mock-server.js`, `js/config-editor.js`, `ServerSettings.ini`). The console is a
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
| GET | `/v1/capabilities` | | `{ routes: ["GET /v1/status", ...], config: { writable } }` | Console feature-detects `PATCH /v1/players/{id}` (change team) and `PUT /v1/config`. |
| GET | `/v1/status` | | `{ serverName, map, experiences[], lighting, alternator, scoreTick:{current,min,max}, scoreCap, matchSeconds, players:{current,max}, factionScores:[{name,colorHex,score}], rotation:{nowIndex,nextIndex} }` | Live build CL-499480 (2026-09-11) sends **no `scoreCap` and no `matchSeconds`**; the mock has them, Warcon treats both as optional. `players.max` is the engine's clamped value (98 for `MaxPlayers=100`). |
| GET | `/v1/players` | | `{ players:[{name, steamId, faction, kills, deaths, cash, pingMs}], count }` | Confirmed on CL-499480. List responses all carry `count`. |
| POST | `/v1/players/{steamId}/kick` | `{ reason }` | `{ message }` | |
| POST | `/v1/players/{steamId}/kill` | | `{ message }` | |
| POST | `/v1/players/{steamId}/message` | `{ message }` | `{ message }` | Whisper. |
| PATCH | `/v1/players/{steamId}` | `{ faction }` | `{ message }` | Faction **name** (e.g. `Valkyra`), resolved via `factionScores[].colorHex`. Optional route. The console follows it with `POST .../kill` so the player respawns on the new side; a failed kill (no living character) is ignored. Warcon does the same. |
| POST | `/v1/broadcast` | `{ message }` | `{ message }` | ≤200 chars in the console. |
| GET | `/v1/bans` | | `{ bans:[{steamId, bannedAtUtc, bannedBy, reason}], count }` | Entries from `+DefaultBannedPlayerIds` come back with `bannedBy:"config"`, `reason:null`, `bannedAtUtc:"0001-01-01T00:00:00.000Z"`; Warcon blanks that date. |
| POST | `/v1/bans` | `{ steamId, reason? }` | `{ message }` | Persists to `+DefaultBannedPlayerIds`. |
| DELETE | `/v1/bans/{steamId}` | | `{ message }` | Unknown id: `404 { code:"ban_not_found", message:"Error: SteamId … is not currently banned." }`. |
| GET | `/v1/reserved-slots` | | `{ reservedSlots:[steamId] }` | Permanent only on real servers. |
| POST | `/v1/reserved-slots` | `{ steamId }` | `{ message }` | Limited by `MaxReservedSlots`. **Not served by live build CL-499480**; Warcon disables the control and the org list sync reports it instead of misreading the 404. |
| DELETE | `/v1/reserved-slots/{steamId}` | | `{ message }` | **Not served by live build CL-499480.** |
| GET | `/v1/catalog/maps` | | `{ maps:[{id, displayName}] }` | Map ids: `Kavkazi` (Bakurani), `Europe` (Ozeti), `NorthAmerica` (Zestafona). |
| GET | `/v1/catalog/lightings` | | `{ lightings:[{id, displayName}] }` | `DayStartClear`, `DayEarlyClear`, `DayEarlyFog`, `DayClear`, `DayLateClear`, `DayLateGray`, `DayLateGrayFog`, `DayEndClear`. |
| GET | `/v1/catalog/experiences` | | `{ experiences:[{id, displayName}] }` | Game modes (`*_KOTH_01`) and modifiers (`KOTH_InfantryOnly`, `KOTH_Hardcore`). |
| GET | `/v1/catalog/maps/{map}/experiences` | | `{ experiences:[id] }` | |
| GET | `/v1/catalog/maps/{map}/alternators` | | `{ alternators:[{tag, displayName}] }` | Control-zone alternators, e.g. `ZoneAlternator.Factory.Circle`. |
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
| GET | `/v1/health` | | `{ status:"ok", uptimeSeconds, connections:{active}, gameThreadQueue:{inFlight, depth, rejectedTotal} }` | Served by CL-499480; the web console never calls it. Warcon action `health`. |
| GET | `/v1/audit?limit=N` | | `{ limit, entries:[{timestampUtc, peer, sessionId, event, detail}], count }` | Listener log. The mock's events are `ACCEPT`, `AUTH_OK`, `AUTH_FAIL`, `REJECT`, `COMMAND`, `CLOSE`; CL-499480 writes two lines per request, `AUTH_OK` (detail null) then `HTTP` with detail `GET /v1/players -> 200`. On the TLR host every peer is `127.0.0.1:<port>` because a local proxy fronts the listener (`BindAddress=127.0.0.1`), so the per-IP rate limit there is shared by every client. N ≤ 500. |
| GET | `/v1/config` | | `{ revision, writable, text, sections:[{section, appliesWhen, description, allowedKeys[], keyOverrides:[{key, appliesWhen, description}]}], warnings[] }` | Whole `ServerSettings.ini`. CL-499480's schema (mirrored in `mockgame.ts`): `WDGameSession` applied (`ServerImageURL` pending, password and join limits applied on the next session update), `Engine.GameSession` next-restart, `WDGameStateSession` / `KOTH` / `PreMatch` next-match, rotation applied ("rebuilt immediately; used from the next map change"), `WDRCONSettings` and `WDServerFeed` next-restart. |
| POST | `/v1/config/validate` | text/plain ini | apply result | Dry run. |
| PUT | `/v1/config?force=true&fullApply=true` | text/plain ini, `If-Match: "rev"` | `{ ok, revision, outcomes:[{section,state,detail}], shadowed[], stripped[], errors[], changed[], conflict[], warnings[], timingsMs }` | `state` ∈ `applied`, `next-match`, `next-restart`, `pending`. 412 on revision mismatch unless `force`. |

"Set as next map" is not a route: the console finds (or adds) the selection in the rotation and
moves it into the slot after the `now` entry with repeated `/move` calls. Warcon does the same server-side.

### What live build CL-499480 actually serves (captured 2026-09-11)

`GET /v1/capabilities` on the TLR server returned 28 routes: everything above **except**
`POST`/`DELETE /v1/reserved-slots`, the four `/v1/rotation/...` write routes, `PATCH /v1/settings`
and `PUT /v1/sponsor`, plus one the console does not know, `GET /v1/health`. Its player routes are
spelled `{id}` rather than `{steamId}`. The document also carries `apiVersion`, `build`,
`auth:{scheme:"bearer",header:"Authorization"}`, `limits:{maxBodyBytes,maxRequestsPerMinutePerIp}`
and `config:{writable,document:"/v1/config"}`. Warcon reads the flags it needs into `Features`
(`reservedSlots`, `rotationEdit`, `rotationSave`, `liveSettings`) and disables the matching
controls, pointing at the config document instead. The authoritative list for any server is its own
`routes` array; Warcon shows it under Servers, Test, "Routes this build serves".

## ServerSettings.ini keys the server honours

```
[/Script/WDGame.WDGameSession]           ServerName, ServerPassword, ServerMin/MaxPlayerCash, ServerMin/MaxPlayerLevel,
                                          ServerImageURL, MaxReservedSlots, +DefaultReservedPlayerIds, +DefaultBannedPlayerIds
[/Script/Engine.GameSession]              MaxPlayers
[MatchState.PreMatch.WaitingForPlayers.PlayerCount]  MinimumRequiredPlayers
[MatchState.Playing.KOTH]                 ScorePeriod (18-30)
[/Script/WDGame.WDGameStateSession]       bLockOverpopulatedTeamsConfig, OverpopulatedTeamThresholdConfig
[/Script/WDGame.WDServerMapRotationSettings]  bEnabled, RotationMode, +RotationEntries=(Map="",Experience(s)="",Lighting="",ZoneAlternator="")
[/Script/WDRCON.WDRCONSettings]           bEnabled, BindAddress, Port, Password, PasswordHash, AllowedOrigins
[WDServerFeed]                            Url, Token          (CL-499480: "kill-event feed endpoint and its ingest token")
```

`allowedKeys` on CL-499480 also lists `PlayerIdentityEntries` under `WDGameSession` and
`AllowedOrigins` under the RCON block; neither is documented in the reference ini, and nothing on
rcon.wardogs.com mentions any of the three. `WDServerFeed` (`Url` + `Token`, "kill-event feed
endpoint and its ingest token") is most likely the game's own telemetry: the server pushing kill
events to Bulkhead's ingest service for stats. It is not documented for hosts, its default is not
visible in the document (the TLR file has no such section, so it runs on built-in defaults), and
repointing it would divert the developer's data. Leave it alone; Warcon keeps building kill and
cash data from the scoreboard.

Only `ScorePeriod`, `bEnabled` and `RotationMode` have live routes; everything else changes via the
config document (PUT `/v1/config`) or by editing the ini and restarting.

## Steam lookup sidecar

The console optionally calls `GET /api/steam/profiles?ids=a,b,c` with header `X-Steam-Api-Key` on
whatever host serves it, expecting `{ "<steamId>": { name, avatar } }`. Warcon implements the same
route using a server-side `STEAM_API_KEY` secret instead of a per-browser key.
