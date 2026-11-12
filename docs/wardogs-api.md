# WARDOGS dedicated-server RCON API (WDRCON)

Reverse-engineered on 2026-09-08 from the official web console at `http://rcon.wardogs.com`, re-checked
against the 2026-09-10, 2026-09-14 and 2026-11-12 (Season 3) redeploys of the site
(`js/api.js`, `js/mock-server.js`, `js/config-editor.js`, `ServerSettings.ini`) and against live builds
CL-501228 on 2026-09-14 and CL-507060 (update 0.1.2) on 2026-09-30. The console is a
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
| POST | `/v1/players/{steamId}/message` | `{ message }` | `{ message }` | Whisper. Capped like a broadcast since update 0.1.2 (the patch notes say both; only the broadcast was tried). |
| PATCH | `/v1/players/{steamId}` | `{ faction }` | `{ message }` | Faction **name** (e.g. `Valkyra`), resolved via `factionScores[].colorHex`. Optional route. The console follows it with `POST .../kill` so the player respawns on the new side; a failed kill (no living character) is ignored. Warcon does the same. |
| POST | `/v1/broadcast` | `{ message }` | `{ ok, pending, message }` | ≤200 chars in the console. **Since update 0.1.2 the game takes at most 256 characters** (CL-507060, 2026-09-30, on an empty server): 256 answered `{ ok:true, pending:false, message:"OK: broadcast delivered to 0 player(s)." }`, 257 was refused, not cut: `400 { error:{ code:"message_too_long", message:"Error: message is 257 characters; the limit is 256." } }`. It counts characters, not bytes: 200 accented characters (388 bytes of UTF-8) were delivered too. Emoji were not tried; JavaScript counts most as two, so Warcon's cut can only come in under the game's. Warcon cuts whispers and broadcasts at 256 (`MAX_CHAT` in `src/lib/chat.ts`), rendered rule texts included; kick and ban reasons stay at 200. `MOCK_LIVE_BUILD` refuses the same way. |
| GET | `/v1/bans` | | `{ bans:[{steamId, bannedAtUtc, bannedBy, reason}], count }` | Entries from `+DefaultBannedPlayerIds` come back with `bannedBy:"config"`, `reason:null`, `bannedAtUtc:"0001-01-01T00:00:00.000Z"`; Warcon blanks that date. |
| POST | `/v1/bans` | `{ steamId, reason? }` | `{ message }` | Persists to `+DefaultBannedPlayerIds`. |
| DELETE | `/v1/bans/{steamId}` | | `{ message }` | Unknown id: `404 { code:"ban_not_found", message:"Error: SteamId … is not currently banned." }`. |
| GET | `/v1/reserved-slots` | | `{ reservedSlots:[steamId], count }` | Permanent only on real servers (the console carries a `reservedExpiry` flag and `expiresAtUtc`, but only its mock sets them). The list has no length limit: anyone on it skips the join queue; `MaxReservedSlots` only says how many player slots are held back for them. |
| POST | `/v1/reserved-slots` | `{ steamId }` | `{ message }` | **Not served by live builds CL-499480 / CL-501228.** Both the console (since 2026-09-14) and Warcon then edit `DefaultReservedPlayerIds` in the config document instead: `GET /v1/config`, add the id, `PUT /v1/config` with `If-Match` (`src/lib/reserved-doc.ts`, `reservedViaConfig` in `actions.ts`); Warcon keeps the live-route error codes (`already_reserved`, `reserved_not_found`) so the org list sync behaves the same either way. The console's mock refused adds beyond `MaxReservedSlots` with a `reserved_full` 409; no real server does, and Warcon no longer imitates it. **The running server does not re-read the array until it restarts** (seen 2026-09-15 on a CL-501228 host: withdrawn from the document, still returned by `GET /v1/reserved-slots` five minutes later, and the 24-hour self-restart is when it clears). Warcon re-reads the live list after every document edit and reports `pendingRestart`; the slots page badges such ids "leaves at restart" / "arrives at restart" and offers no second Withdraw. `MOCK_LIVE_BUILD` reproduces it. |
| DELETE | `/v1/reserved-slots/{steamId}` | | `{ message }` | **Not served by live builds**; same document fallback. |
| GET | `/v1/catalog/maps` | | `{ maps:[{id, displayName}] }` | Map ids: `Kavkazi` (Bakurani), `Europe` (Ozeti), `NorthAmerica` (Zestafona) and, from Season 3, `Russia` (Sabatulo). |
| GET | `/v1/catalog/lightings` | | `{ lightings:[{id, displayName}] }` | `DayStartClear`, `DayEarlyClear`, `DayEarlyFog`, `DayClear`, `DayLateClear`, `DayLateGray`, `DayLateGrayFog`, `DayEndClear`; Season 2 (CL-516586) adds the rain preset `DayLateRain` (the official console's demo data and map art have it since 2026-10-15). Warcon's pickers list whatever the server sends, less what the map picked does not take: the list is one for every map, though Sabatulo takes four of them (Season 3, below). |
| GET | `/v1/catalog/experiences` | | `{ experiences:[{id, displayName}] }` | Game modes (`*_KOTH_01`; Season 3's `Moscow_KOTH_01` is Sabatulo's) and modifiers (`KOTH_InfantryOnly`, `KOTH_Hardcore`, Season 3's `KOTH_LimitedGear`). Nothing in the answer says which an id is: a game mode is named for its place, a modifier for the mode it changes (`isMod` in `src/lib/format.ts`). |
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
so the worker's hold can be watched. Where a live build's rotation pointer goes when the document
rewrites the rotation mid-match has not been seen: the demo keeps it on the entry being played,
`MOCK_ROTATION_POINTER=index` keeps its place instead and `=top` goes to the top of the list at the
next map change (the Rotation shuffle rule reads the rotation back to tell which). The
authoritative list for any server is its own `routes` array; Warcon shows it under Servers, Test,
"Routes this build serves".

### Update 0.1.2, live build CL-507060 (read 2026-09-30)

Read on a live server through the panel: the same 29 routes and the same `capabilities`
document as CL-501228 (`limits` still names no chat length), and the same shapes from every read
route (`/v1/health`, `/v1/status`, `/v1/rotation`, `/v1/bans`, `/v1/reserved-slots`, the five
catalog routes, `/v1/sponsor`, `/v1/audit`, `GET /v1/config`), although the patch notes say
responses now default to "Standard" detail instead of "Full" and that config responses no longer
expose server internals. The one loss seen: a config validate answer no longer carries
`timingsMs`. Refusals read as before: `404 not_found "No such endpoint."` for a route the build
lacks, `405 method_not_allowed`, `404 player_not_found "Error: no player matching '<id>'."` from
message, kick, kill, `PATCH` and `POST /v1/bans` for a player who is not on (so a ban still needs
the player connected), and `404 ban_not_found` from unbanning an id that is not banned. The
player list's fields were not seen (the server was empty). The RCON block's `allowedKeys` gained
`AllowedHosts` (who may reach the listener; format not seen, read at startup) and lost
`bWriteAuditLogFile`. The daily restart time the update adds is not a key the document takes: no
section allows one, so hosts set it outside `ServerSettings.ini`, and no route reports it.
Whispers and broadcasts are capped (see `/v1/broadcast` above).

### Season 3, live build CL-533689 (the team's server notes, the console's redeploy and a first live read, all 2026-11-12)

**The rotation.** From the notes the WARDOGS team sent server admins on 2026-11-12:

- A new map, **Sabatulo**: `Map="Russia"`, game mode `Moscow_KOTH_01`.
- A new modifier, **Limited Gear** (`KOTH_LimitedGear`): it limits the vendor to a fixed list of
  items and turns off some stationary weapons and the hot-zone magnet buildable. It is not a game
  mode: it goes on a game mode as Infantry Only and Hardcore do, the game mode first, on any map
  and beside other modifiers, as in
  `+RotationEntries=(Map="Europe",Experiences="Madrid_KOTH_01+KOTH_InfantryOnly+KOTH_LimitedGear",Lighting="DayClear")`.
  An entry with the modifier alone has no game mode and starts no match. (The notes say this of
  Limited Gear. Whether an Infantry Only or Hardcore entry needs a game mode too has not been seen:
  the console's demo rotation has an Infantry Only entry with none, so Warcon marks only the first.)
- **Allow lists.** A server plays only the maps and experiences on its allow lists,
  `+AllowedMaps=Russia`, `+AllowedExperiences=Moscow_KOTH_01` and
  `+AllowedExperiences=KOTH_LimitedGear` under `[/Script/WDGame.WDServerMapRotationSettings]` in the
  hosting provider's patch `Game.ini`. A host cannot set them in `ServerSettings.ini`, and a
  rotation entry that names a map, game mode or lighting not on the lists is skipped. (Rain was
  the same in Season 2: a server lists `DayLateRain` only where it is allowed.)
- **Sabatulo takes four lightings**: `DayClear`, `DayLateClear`, `DayLateGray` and `DayLateRain`.
  The notes spell the third `DayLateGrey`; the console's table, its demo data and its art
  (`img/maps/Russia/`, those four alone) all have `DayLateGray`, so an entry written as the notes
  have it names a lighting no server lists. No route reports which lightings a map takes: the
  console hard-codes it (`MAP_LIGHTINGS` in its `js/app.js`) and narrows its lighting picker by
  it, and Warcon does the same (`takesLighting` in `src/lib/format.ts`). What the game answers
  when asked for another lighting on Sabatulo (a rotation entry, `POST /v1/match/map`,
  `PUT /v1/world/lighting`) has not been seen; the demo server refuses it and denies the entry.

What Warcon does with it: the pickers offer Sabatulo its four lightings and treat Limited Gear as a
modifier; the Map rotation tab marks an entry that names something the server does not list, a
lighting its map does not take, or Limited Gear with no game mode, and shows `denied` from
`GET /v1/rotation` beside the staged entries too; the Weather cycle rule passes over the lightings
Sabatulo does not take while the server is on it, and holds back a change decided before the
server moved there. `MOCK_LIVE_BUILD` or not, the demo server lists
the Season 3 map, game mode and modifier.

**Live servers that day.** At 14:22 to 14:32 UTC every hosted server that answered (79) still
ran Season 2's `++Wardogs+Live-CL-516586`; by 14:53 UTC five reported
**`++Wardogs+Live-CL-533689`**. One of those, read through the panel (`capabilities`, the raw
status and the catalog):

- **34 routes**: Season 2's 31 and exactly `GET /v1/chat`, `GET /v1/chat/terms` and
  `POST /v1/chat/terms`. Nothing else in the document changed (`apiVersion` 1, the same limits).
- **Status** gains `welcomeMessage: { maxLines: 128, maxLineLength: 128, minFontSize: 8,
  maxFontSize: 24, maxCloseDelaySeconds: 60 }` and `afk: { timeoutSeconds: 600,
  minTimeoutSeconds: 300, maxTimeoutSeconds: 1800 }`.
- **Catalog**: the map `Russia`, the game mode `Moscow_KOTH_01` and the modifier
  `KOTH_LimitedGear`, and beside it a second id, `LimitedGear`, without the mode's prefix (Warcon
  reads both as the modifier). That server listed seven lightings (the two fog presets were not
  among them, the grey one is `DayLateGray`) and no `Bakurani_KOTH_01`: what a server lists is
  its own.
- What a live catalog's names look like, which the demo's do not: a map's `displayName` is its id
  (`Kavkazi`, `Russia`), an experience's is `Moscow KOTH 01` or `KOTH LimitedGear`, a lighting's
  is its id, and the status names the map as players know it (`Bakurani`). So "Sabatulo" comes
  from Warcon's own table (`MAP_DISPLAY`), not from the game.
- **A feed that sends nothing.** A second server, read at 15:37 UTC, 21 minutes after it
  restarted onto the build, with 99 players on Sabatulo and a match in play: the panel had
  received no batch since the restart, and the game's `GET /v1/feed` reported the feed enabled,
  its one endpoint healthy, `sentTotal` 0, nothing queued and no HTTP answer yet. With lines that
  work the game had sent nothing at all, which is what `pausedForTerms` below describes (the
  panel that read it did not yet pass the flag on, so the flag itself was not seen).

**The welcome popup.** From the notes the WARDOGS team sent server admins on 2026-11-12 ("Server
Welcome Messages") and the check the console runs on each line (`js/welcome-text.js`, a port of
Unreal's rich text markup reader):

- The four keys sit in `[/Script/WDGame.WDGameStateSession]` and apply from the next match:
  `ServerWelcomeMessageLines` (the text), `bServerWelcomeMessageEnabled`,
  `ServerWelcomeMessageCloseDelaySeconds` (the Close button stays locked for 0 to 60 seconds) and
  `bServerWelcomeMessageSkipForStreamers`. The console writes the text as the server writes any
  array, `!ServerWelcomeMessageLines=ClearArray` and one `.ServerWelcomeMessageLines=` line for
  each line of the popup (`.` adds a value even when the list has it, where `+` would add a blank
  or a repeated line once), an empty value for a blank spacer.
- A line is plain text and tags. A tag is `<Name>text</>`, or `<Name attr="value" …>text</>` with
  one space before each attribute and straight double quotes, always closed by `</>`; the text of
  a tag ends at the first `</>`, so tags do not nest. The popup keeps `<Header>`, `<Bold>` and
  `<Italic>` (any tag without attributes is taken for a style; what the game draws for a name it
  has no style for has not been seen) and `<text>` with `color="#RRGGBB"`, `size="8"` to `"24"`
  and `fontface="Bold"` or `"Italic"`, in any mix. Any other tag with attributes (a link, a Header
  with a colour) shows as typed. `&lt;` `&gt;` `&amp;` `&quot;` are the characters themselves.
- The limits: 128 lines, 128 visible characters a line (tags do not count, an entity counts as
  one), font sizes 8 to 24; `GET /v1/status` reports them as `welcomeMessage` (seen on CL-533689,
  above). In game, anything over a limit is cut. Over RCON the document is refused, with the line
  named, when the popup has more lines than the limit, a line longer than the limit, a tag with
  attributes that is not `<text>`, a `<text>` attribute other than `color`, `size` and
  `fontface`, or a size that is not a whole number in range written plainly (`16`, not `016`,
  `16.5` or ` 16`). The console's own demo server does not act that refusal out, so its shape on
  the wire has not been seen: the demo refuses its AFK timeout with 400 `config_invalid`, "The
  config was refused." and `errors: [{ section, key, message }]`, and Warcon's demo answers a
  refused popup the same way.

What Warcon does with it: the Config tab's form has the three plain keys as fields and an editor
for the text (`src/lib/welcome-text.ts` reads a line as the console does, says what the game
refuses and what it would show as typed, and draws the preview; `src/lib/welcome-doc.ts` reads
and writes the array). It checks against the limits the status reports, read from the status as
the game sent it (`raw`, which only Config & settings gets), and otherwise against the ones above.
A line goes into the file in quotes, its own quotes and backslashes escaped, when it starts with a
quote, has white space at either end, ends in a backslash or holds `//` (the console's rule), and
also when it holds `{`, `}` or `|`: Unreal's own reader of such files drops braces and ends a line
at a bar outside quotes, and whether the game's does has not been seen. No route or action is the
popup's own; an older build shows no sign of it (no limits, no key in its `sections`), which the
form says in a note without locking anything, since `sections` has been wrong about what a server
takes before. The demo server has the popup (limits, the four keys in its schema, a seeded text,
the refusal) except under `MOCK_LIVE_BUILD`, which stands in for a build from before it.

The live read above confirms the limits in the status, the same five numbers. Not seen on a live
server: the rest (the document was not read); whether `sections` names the four keys; whether a
line over a limit written into the file by hand makes the game refuse every later apply over RCON
(reserved slots, the live name and the rotation go through the same document); how often a player
gets the popup.

**The rest of the redeploy** (13:22 UTC, the console's build stamp `eb816a7`). Read from the
console's own client and demo code, so the shapes are what the console expects of a Season 3
server. The live read above confirms the three chat routes and the two status fields, and shows
a feed sending nothing; what the chat routes answer, the feed's flag itself and the players' new
fields have not been seen from a live server. Warcon uses the feed's flag and the three chat
routes:

- **Chat.** `GET /v1/chat/terms` answers `{ requiredVersion, acceptedVersion, accepted, text }` and
  `POST /v1/chat/terms { version }` accepts them (`{ ok, pending, message }`; 400 `missing_version`
  or `terms_version_mismatch`). Until then `GET /v1/chat` answers 409 `chat_terms_not_accepted`;
  after, `GET /v1/chat?after=<seq>&limit=<n>` answers `{ latestSeq, messages:[{ seq, sentUtc,
  channel, faction, steamId, realName, hiddenName, anonymous, text, rawText, ping }], count }`:
  `text` as players saw it (the chat filter's stars), `rawText` as typed, `ping` for a ping
  callout, channels such as Team, Global, Squad, Proximity and Vehicle. The console shows its Chat
  view when `capabilities` lists all three routes, reads 200 messages at a time every 3 s, and
  keeps 1,000 rows. Its bundled terms (version 1; a server may send its own text): chat is shown
  only so that the server can be moderated, is live and held only in the server's memory for the
  current map, and "You must not record, store, export, publish or share players' chat or
  identities beyond what moderating this server requires."
  The console's other bundled points: chat is not stored for the reader by Bulkhead, the reader
  answers for the privacy and data-protection law that applies to them, and "Bulkhead may revoke
  access for misuse." The console's config schema has no key for an acceptance.
  What Warcon does with them (`src/lib/chat-read.ts`, the actions `chatTerms`, `chatTermsAccept`
  and `chat`): the server's Chat tab shows the terms and the lines to those who hold _Read chat_
  (the organisation's owners and the site owner, until an owner gives it to a role; no built-in
  role has it and an API key cannot hold it); accepting the terms is for an owner, in person, and
  the audit trail keeps who accepted which version; the lines are read every four seconds per
  open tab, at the priority of the worker's own looks, and kept nowhere; the raw action refuses
  `/v1/chat` and everything under it. The answers are read leniently, since no live one has been
  seen (a required version of 0, no `messages` beside a `latestSeq`, `seq` as digits). A game
  that numbers from the start again is told as the console tells it, by a `latestSeq` below the
  last line read, and also by its start time moving on. The demo server serves the three routes,
  with its own stand-in terms and a scripted chat.
- **The event feed waits on those terms.** `GET /v1/feed` gains `pausedForTerms`, which the console
  shows as "Paused: the event feed sends nothing until the chat terms are accepted." Whether an
  acceptance outlasts a restart is not known. This one Warcon reads (`feedReportOf` and the `terms`
  fault in `src/lib/feed-report.ts`): a silent feed's warning on the Config card says the game is
  holding the feed back, before any fault of the file's lines (a feed switched off in the file
  comes first).
- **Players** gain `hiddenName` (the name other players see) and `anonymous` (anonymous mode: other
  players see only the hidden name) in `GET /v1/players`.
- **Status** gains, beside the welcome popup's limits (above), `afk: { timeoutSeconds,
  minTimeoutSeconds, maxTimeoutSeconds }` (600, 300 and 1800 in the demo and on CL-533689).
- **Config.** Beside the welcome popup's four keys (above), a new section
  `[/Script/BHAFKDetection.BHAFKDetectionSettings]` holds `DefaultAFKTimeOutSeconds`, the idle time
  before the game kicks a player, read when a match starts. A quoted value now escapes `"` and `\`
  with a backslash, which is how a welcome line carries its own quotes.

## ServerSettings.ini keys the server honours

```
[/Script/WDGame.WDGameSession]           ServerName, ServerPassword, ServerMin/MaxPlayerCash, ServerMin/MaxPlayerLevel,
                                          ServerImageURL, MaxReservedSlots, +DefaultReservedPlayerIds, +DefaultBannedPlayerIds
[/Script/Engine.GameSession]              MaxPlayers
[MatchState.PreMatch.WaitingForPlayers.PlayerCount]  MinimumRequiredPlayers
[MatchState.Playing.KOTH]                 ScorePeriod (18-30)
[/Script/WDGame.WDGameStateSession]       bLockOverpopulatedTeamsConfig, OverpopulatedTeamThresholdConfig; Season 3 (see above):
                                          bServerWelcomeMessageEnabled, ServerWelcomeMessageCloseDelaySeconds,
                                          bServerWelcomeMessageSkipForStreamers, ServerWelcomeMessageLines
[/Script/WDGame.WDServerMapRotationSettings]  bEnabled, RotationMode, +RotationEntries=(Map="",Experience(s)="",Lighting="",ZoneAlternator="")
[/Script/WDRCON.WDRCONSettings]           bEnabled, BindAddress, Port, Password, PasswordHash, AllowedOrigins, AllowedHosts (CL-507060;
                                          CL-501228 had bWriteAuditLogFile instead)
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
on either side. Only `killed` was seen; other types may exist. Whether the game buffers while the
endpoint is down is not known. Warcon serves the endpoint at `POST /api/ingest/events` and writes
`Url=<origin>` with a per-server token (README, "Kill feed"); a config written before the suffix
was known (`Url=<origin>/api/feed/events`) needs Configure again, and Warcon keeps building the
scoreboard's kill and cash totals as before.

**Season 2 (v0.2.0, CL-516586, 2026-10-15).** The game strips `[WDServerFeed]` on any apply and
reads its feed from the RCON block instead: `bEventFeedEnabled`, a list `EventFeedEndpoints` of
`(Url="…",Token="…")`, and `EventFeedServerName` (the batch's `serverName`). Each is
`writable:false` ("Set only in the server's config file; RCON cannot change it."), and validate
and apply drop them without a word, so the host pastes them into the file (README, "Kill feed").
A file the game wrote held `bEventFeedEnabled=True`, `!EventFeedEndpoints=ClearArray`,
`.EventFeedEndpoints=(Url="…",Token=…)` and `EventFeedServerName=…`. `GET /v1/feed` answers
`{enabled, endpointCount, anyUnhealthy, endpoints:[]}`; an endpoint's shape was not seen. Unlike
`[WDServerFeed]`, the game posts to such a `Url` exactly as written (the console's
`ServerSettings.ini` says so, and on 2026-10-15 lines naming the panel's origin alone did not
reach it), so the line names `/api/ingest/events` in full.

The batches also carry four new types beside `killed`, each with `eventId`, `eventTime`, `matchId`
and `mapName` as above (posted on Discord by a host on 2026-10-15, ids blanked):

```
{ "type": "player_joined", "playerName": "…", "playerId": "-0000-000000000000",
  "playerSteamId": "7656119…", "players": 42 }            // players: a count of who is on
{ "type": "player_left", …the same fields }
{ "type": "match_state", "state": "MatchState.Playing.KOTH" }   // no matchId in PreMatch and
                                                                // PreMatch.WaitingForWorldLoad
{ "type": "match_ended", "eventTime": 7658.5545631460845, "players": 98,
  "winningFaction": "Lonestar",
  "factionScores": [ { "faction": "Lonestar", "score": 100 }, { "faction": "Valkyra", "score": 0 },
                     { "faction": "Manticore", "score": 59 } ] }
```

`playerId` has the short form of `killerId` and `victimId`. The states: `MatchState.PreMatch`,
`.PreMatch.WaitingForWorldLoad`, `.PreMatch.WaitingForPlayers`,
`.PreMatch.WaitingForPlayers.PlayerCount`, `.Playing`, `.Playing.KOTH` and `.PostMatch` (two
config sections carry the same names). Since pre-match has no `matchId` until the world has
loaded, `matchId` is presumably per match on Season 2 (it stayed the same across a map change on
CL-501228); not confirmed. Not known either: the order of `match_ended` and `PostMatch`, how long
post-match lasts, whether a forced end (`POST /v1/match/end`) or a restart posts a result,
whether `winningFaction` can be empty (a tie), and whether `players` counts the player joining or
leaving.

What Warcon does with them (`src/lib/server/match-feed.ts`): the last `match_state` of a batch is
written to `server_live.match_state` at receipt and handed to the worker, and the server's Overview
shows it while the server answers and unless it came before the game process last started. A
`match_ended` is the game's result of the match: its scores and winner (a winner not among the
scores counts as none, and then the leader of the scores wins, as for a look) replace what the
looks saw when the look that sees the match end comes within five minutes, or correct the match
that look closed when they arrive within two minutes after it; a result naming other factions
than the scoreboard's is not used, since every player's result would then be lost. The looks still
decide where matches start and end. Every state and result is kept in `match_events` as it came
(receipt time, its place in the batch, `eventTime`, `matchId` or null, map, state, and for a result
`players`, `winningFaction` as sent and the scores), so the order and timing above can be read off
the fleet; a resent batch is not kept twice, and a state the same as the last one kept for the
server (same game run, state and `matchId`) is counted as `repeat` in
`warcon_feed_kills_total{result}` and not kept, written to `server_live` or handed to the worker.
Joins and leaves are counted (`result="other"`, with the states and results) and not used: the
polled `/v1/players` is the record. Only kills count towards the 200 per batch; the 64 KB body limit
bounds the rest. The demo server's feed sends joins, leaves (kicks and bans too), the states (with
no `matchId` in pre-match, a new one each match) and a result when a side reaches the cap or the
match is ended by hand.

**The start-up map.** Hosts report (2026-10-16) that a Season 2 server comes up after a restart on
standard Bakurani, not on its rotation, and moves on to the rotation only once that match ends: an
infantry-only rotation opens every day on a standard match. Ending that match (`POST /v1/match/end`,
the console's force end) moves the server on to its rotation, which is how hosts skip it by hand
and what the Skip map after restart rule sends. Not seen yet: what `rotation.nowIndex` says on the
start-up map, and whether an end during its pre-match goes straight to the rotation's next entry.
`MOCK_STARTUP_MAP=true` makes the demo servers come up that way (standard Bakurani at a time of day
their rotation does not have, `nowIndex` -1, the top of the rotation next).

Only `ScorePeriod`, `bEnabled` and `RotationMode` have live routes; everything else changes via the
config document (PUT `/v1/config`) or by editing the ini and restarting.

## Steam lookup sidecar

The console optionally calls `GET /api/steam/profiles?ids=a,b,c` with header `X-Steam-Api-Key` on
whatever host serves it, expecting `{ "<steamId>": { name, avatar } }`. Warcon implements the same
route using a server-side `STEAM_API_KEY` secret instead of a per-browser key.
