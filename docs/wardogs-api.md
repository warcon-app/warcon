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
  usually `{ "message": "..." }`.
* Config routes use `text/plain` bodies and `If-Match: "<revision>"`; `412` means revision mismatch.

## Routes

| Method | Path | Body / query | Response | Notes |
|---|---|---|---|---|
| GET | `/v1/capabilities` | | `{ routes: ["GET /v1/status", ...], config: { writable } }` | Console feature-detects `PATCH /v1/players/{id}` (change team) and `PUT /v1/config`. |
| GET | `/v1/status` | | `{ serverName, map, experiences[], lighting, alternator, scoreTick:{current,min,max}, scoreCap, matchSeconds, players:{current,max}, factionScores:[{name,colorHex,score}], rotation:{nowIndex,nextIndex} }` | |
| GET | `/v1/players` | | `{ players:[{name, steamId, faction, kills, deaths, cash, pingMs}] }` | |
| POST | `/v1/players/{steamId}/kick` | `{ reason }` | `{ message }` | |
| POST | `/v1/players/{steamId}/kill` | | `{ message }` | |
| POST | `/v1/players/{steamId}/message` | `{ message }` | `{ message }` | Whisper. |
| PATCH | `/v1/players/{steamId}` | `{ faction }` | `{ message }` | Faction **name** (e.g. `Valkyra`), resolved via `factionScores[].colorHex`. Optional route. The console follows it with `POST .../kill` so the player respawns on the new side; a failed kill (no living character) is ignored. Warcon does the same. |
| POST | `/v1/broadcast` | `{ message }` | `{ message }` | ≤200 chars in the console. |
| GET | `/v1/bans` | | `{ bans:[{steamId, bannedAtUtc, bannedBy, reason}] }` | |
| POST | `/v1/bans` | `{ steamId, reason? }` | `{ message }` | Persists to `+DefaultBannedPlayerIds`. |
| DELETE | `/v1/bans/{steamId}` | | `{ message }` | |
| GET | `/v1/reserved-slots` | | `{ reservedSlots:[steamId] }` | Permanent only on real servers. |
| POST | `/v1/reserved-slots` | `{ steamId }` | `{ message }` | Limited by `MaxReservedSlots`. |
| DELETE | `/v1/reserved-slots/{steamId}` | | `{ message }` | |
| GET | `/v1/catalog/maps` | | `{ maps:[{id, displayName}] }` | Map ids: `Kavkazi` (Bakurani), `Europe` (Ozeti), `NorthAmerica` (Zestafona). |
| GET | `/v1/catalog/lightings` | | `{ lightings:[{id, displayName}] }` | `DayStartClear`, `DayEarlyClear`, `DayEarlyFog`, `DayClear`, `DayLateClear`, `DayLateGray`, `DayLateGrayFog`, `DayEndClear`. |
| GET | `/v1/catalog/experiences` | | `{ experiences:[{id, displayName}] }` | Game modes (`*_KOTH_01`) and modifiers (`KOTH_InfantryOnly`, `KOTH_Hardcore`). |
| GET | `/v1/catalog/maps/{map}/experiences` | | `{ experiences:[id] }` | |
| GET | `/v1/catalog/maps/{map}/alternators` | | `{ alternators:[{tag, displayName}] }` | Control-zone alternators, e.g. `ZoneAlternator.Factory.Circle`. |
| POST | `/v1/match/map` | `{ map, experiences?, lighting?, zoneAlternator? }` | `{ message }` | Travels when the match-end screen finishes. |
| POST | `/v1/match/end` | | `{ message }` | Advances rotation (or reloads current map when rotation off). |
| POST | `/v1/match/restart` | | `{ message }` | Reloads current map, rotation pointer untouched, config not re-read. |
| PUT | `/v1/world/lighting` | `{ lighting }` | `{ message }` | |
| GET | `/v1/rotation` | | `{ enabled, mode:"ordered"\|"random", entries:[{map, experiences[], lighting, zoneAlternator?, status:"now"\|"next"\|"", denied}] }` | `denied` = entry references an experience the server does not know. |
| POST | `/v1/rotation/entries` | map selection | `{ message }` | Live edit. |
| DELETE | `/v1/rotation/entries/{index}` | | `{ message }` | |
| POST | `/v1/rotation/entries/{index}/move` | `{ direction:"up"\|"down" }` | `{ message }` | The console reorders by repeating this. |
| POST | `/v1/rotation/save` | | `{ message }` | Writes rotation to the config; needs `-StandaloneConfig=<path>`. |
| PATCH | `/v1/settings` | `{ scoreTick?, rotationEnabled?, rotationMode? }` | `{ message }` | The only live settings routes. |
| GET | `/v1/sponsor` | | `{ imageUrl }` | |
| ~~PUT~~ | ~~`/v1/sponsor`~~ | | `405 PUT is not supported on this endpoint` | **Removed.** `api.js` still defines `setSponsor` but nothing calls it; the console's "Server Image" card is the `ServerImageURL` config field applied through `PUT /v1/config` (reported `pending` while the server fetches and checks the image). No live route exists without a config document. |
| GET | `/v1/audit?limit=N` | | `{ entries:[{timestampUtc, peer, sessionId, event, detail}] }` | Listener log. Events: `ACCEPT`, `AUTH_OK`, `AUTH_FAIL`, `REJECT`, `COMMAND`, `CLOSE`. N ≤ 500. |
| GET | `/v1/config` | | `{ revision, writable, text, sections:[{section, appliesWhen, description, keyOverrides[]}], warnings[] }` | Whole `ServerSettings.ini`. |
| POST | `/v1/config/validate` | text/plain ini | apply result | Dry run. |
| PUT | `/v1/config?force=true&fullApply=true` | text/plain ini, `If-Match: "rev"` | `{ ok, revision, outcomes:[{section,state,detail}], shadowed[], stripped[], errors[], changed[], conflict[], warnings[], timingsMs }` | `state` ∈ `applied`, `next-match`, `next-restart`, `pending`. 412 on revision mismatch unless `force`. |

"Set as next map" is not a route: the console finds (or adds) the selection in the rotation and
moves it into the slot after the `now` entry with repeated `/move` calls. Warcon does the same server-side.

## ServerSettings.ini keys the server honours

```
[/Script/WDGame.WDGameSession]           ServerName, ServerPassword, ServerMin/MaxPlayerCash, ServerMin/MaxPlayerLevel,
                                          ServerImageURL, MaxReservedSlots, +DefaultReservedPlayerIds, +DefaultBannedPlayerIds
[/Script/Engine.GameSession]              MaxPlayers
[MatchState.PreMatch.WaitingForPlayers.PlayerCount]  MinimumRequiredPlayers
[MatchState.Playing.KOTH]                 ScorePeriod (18-30)
[/Script/WDGame.WDGameStateSession]       bLockOverpopulatedTeamsConfig, OverpopulatedTeamThresholdConfig
[/Script/WDGame.WDServerMapRotationSettings]  bEnabled, RotationMode, +RotationEntries=(Map="",Experience(s)="",Lighting="",ZoneAlternator="")
[/Script/WDRCON.WDRCONSettings]           bEnabled, BindAddress, Port, Password, PasswordHash
```

Only `ScorePeriod`, `bEnabled` and `RotationMode` have live routes; everything else changes via the
config document (PUT `/v1/config`) or by editing the ini and restarting.

## Steam lookup sidecar

The console optionally calls `GET /api/steam/profiles?ids=a,b,c` with header `X-Steam-Api-Key` on
whatever host serves it, expecting `{ "<steamId>": { name, avatar } }`. Warcon implements the same
route using a server-side `STEAM_API_KEY` secret instead of a per-browser key.
