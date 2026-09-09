#!/usr/bin/env bash
# End-to-end smoke test against a running Warcon on a FRESH database (WARCON_URL, default http://127.0.0.1:5199).
set -u
B=${WARCON_URL:-http://127.0.0.1:5199}
J1=$(mktemp); J2=$(mktemp); J3=$(mktemp)
pass=0; fail=0
check() { if [[ "$3" == *"$2"* ]]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1 :: expected '$2' in: ${3:0:400}"; fi; }
req() { local jar=$1 m=$2 p=$3 body=${4:-}
  if [ -n "$body" ]; then curl -s -m 30 -b "$jar" -c "$jar" -X "$m" -H 'Content-Type: application/json' -H 'X-Requested-With: warcon' -d "$body" "$B$p"
  else curl -s -m 30 -b "$jar" -c "$jar" -X "$m" -H 'X-Requested-With: warcon' "$B$p"; fi; }
form() { local jar=$1 p=$2 data=$3; curl -s -m 30 -o /dev/null -w '%{http_code} %{redirect_url}' -b "$jar" -c "$jar" -H "Origin: $B" -H 'Accept: text/html' -H 'Content-Type: application/x-www-form-urlencoded' --data "$data" "$B$p"; }
pagecode() { curl -s -m 30 -o /dev/null -w '%{http_code}' -b "$1" "$B$2"; }

echo "== health & first run"
check health '"ok":true' "$(curl -s $B/api/health)"
check root-redirects-setup '/setup' "$(curl -s -o /dev/null -w '%{redirect_url}' $B/)"
check signin-redirects-setup '/setup' "$(curl -s -o /dev/null -w '%{redirect_url}' $B/sign-in)"
check api-unauth 'Sign in required' "$(req $J2 GET /api/servers)"
check csrf-blocked 'X-Requested-With' "$(curl -s -X POST -H 'Content-Type: application/json' -d '{}' $B/api/servers)"
check setup-weak-pw '400' "$(form $J1 /setup 'username=james&password=short')"
check setup-ok "303 $B/" "$(form $J1 /setup 'username=james&password=correct-horse-battery&displayName=James')"
check setup-twice '303' "$(form $J2 /setup 'username=x&password=correct-horse-battery')"
check me-owner 'role:"owner"' "$(curl -s -b $J1 $B/ | grep -o 'role:"owner"' | head -1)"

echo "== sign-in"
check login-bad '401' "$(form $J2 '/sign-in?/password' 'username=james&password=wrong-password-1')"
check login-ok '303' "$(form $J2 '/sign-in?/password' 'username=james&password=correct-horse-battery')"
check login-page-authed-redirect '303' "$(curl -s -o /dev/null -w '%{http_code}' -b $J2 $B/sign-in)"

echo "== orgs"
check org-list-default '"slug":"default"' "$(req $J1 GET /api/orgs)"
R=$(req $J1 POST /api/orgs '{"name":"Smoke Clan"}'); check org-create '"id"' "$R"
ORG=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check org-list-created '"slug":"smoke-clan"' "$(req $J1 GET /api/orgs)"
check org-members-owner '"username":"james"' "$(req $J1 GET /api/orgs/$ORG/members)"

echo "== servers"
check server-create-no-org 'orgId' "$(req $J1 POST /api/servers '{"name":"No Org","host":"demo","port":9,"scheme":"http","password":"demo"}')"
R=$(req $J1 POST /api/servers "{\"orgId\":\"$ORG\",\"name\":\"Demo One\",\"host\":\"demo\",\"port\":1,\"scheme\":\"http\",\"password\":\"demo\",\"notes\":\"mock\"}"); check server-create '"id"' "$R"
SID=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
R=$(req $J1 POST /api/servers "{\"orgId\":\"$ORG\",\"name\":\"Bad PW\",\"host\":\"demo\",\"port\":2,\"scheme\":\"http\",\"password\":\"wrong\"}"); SID2=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check org-server-count '"serverCount":2' "$(req $J1 GET /api/orgs)"
check server-list-no-password '0' "$(req $J1 GET /api/servers | grep -c password_enc)"
check server-list-demo-flag '"demo":true' "$(req $J1 GET /api/servers)"
check server-test '"serverName":"Warcon Demo Server' "$(req $J1 POST /api/servers/$SID/test)"
check server-test-badpw 'rejected the stored RCON password' "$(req $J1 POST /api/servers/$SID2/test)"
check server-update '"ok":true' "$(req $J1 PATCH /api/servers/$SID2 '{"name":"Bad PW renamed","password":"demo"}')"
check server-summary '"scores"' "$(req $J1 GET /api/servers/$SID/summary)"

echo "== rcon reads"
check status '"scores"' "$(req $J1 GET /api/servers/$SID/rcon/status)"
check players '"players"' "$(req $J1 GET /api/servers/$SID/rcon/players)"
check catalog '"lightings"' "$(req $J1 GET /api/servers/$SID/rcon/catalog)"
check experiences-map 'Bakurani_KOTH_01' "$(req $J1 GET "/api/servers/$SID/rcon/experiences?map=Kavkazi")"
check rotation '"nowIndex":0' "$(req $J1 GET /api/servers/$SID/rcon/rotation)"
check capabilities '"changeTeam":true' "$(req $J1 GET /api/servers/$SID/rcon/capabilities)"
check config-read 'ServerName=' "$(req $J1 GET /api/servers/$SID/rcon/config)"
check serverlog '"entries"' "$(req $J1 GET "/api/servers/$SID/rcon/serverLog?limit=5")"
check unknown-action 'Unknown action' "$(req $J1 GET /api/servers/$SID/rcon/nope)"
check get-mutating-405 'must be POSTed' "$(req $J1 GET /api/servers/$SID/rcon/kick)"
check actions-list '"kick":{"level":"operator"' "$(req $J1 GET /api/actions)"

echo "== rcon mutations"
check broadcast 'Announcement sent' "$(req $J1 POST /api/servers/$SID/rcon/broadcast '{"message":"hello"}')"
check kick 'Kicked Ghostpepper' "$(req $J1 POST /api/servers/$SID/rcon/kick '{"steamId":"76561198100000101","reason":"test"}')"
check kick-badid '17-digit' "$(req $J1 POST /api/servers/$SID/rcon/kick '{"steamId":"abc"}')"
check ban 'Banned' "$(req $J1 POST /api/servers/$SID/rcon/ban '{"steamId":"76561198100000102","reason":"aimbot"}')"
check unban 'Unbanned' "$(req $J1 POST /api/servers/$SID/rcon/unban '{"steamId":"76561198100000102"}')"
check changeteam 'Moved' "$(req $J1 POST /api/servers/$SID/rcon/changeTeam '{"steamId":"76561198100000105","faction":"Valkyra"}')"
check setnext 'Next map set to Europe' "$(req $J1 POST /api/servers/$SID/rcon/setNextMap '{"map":"Europe","experiences":["KOTH_InfantryOnly"],"lighting":"DayEarlyFog"}')"
check rotationadd 'Added rotation entry' "$(req $J1 POST /api/servers/$SID/rcon/rotationAdd '{"map":"NorthAmerica","experiences":["Detroit_KOTH_01","KOTH_Hardcore"],"lighting":"DayClear"}')"
check rotationmove 'Moved rotation entry' "$(req $J1 POST /api/servers/$SID/rcon/rotationMove '{"index":3,"direction":"up"}')"
check settings 'ScoreTick set to 20' "$(req $J1 POST /api/servers/$SID/rcon/settings '{"scoreTick":20}')"
check reserved-add 'Reserved slot added' "$(req $J1 POST /api/servers/$SID/rcon/reservedAdd '{"steamId":"76561198100000999"}')"
check sponsor 'submitted' "$(req $J1 POST /api/servers/$SID/rcon/setSponsor '{"imageUrl":"https://example.com/x.png"}')"
check config-validate '"ok":true' "$(req $J1 POST /api/servers/$SID/rcon/configValidate '{"text":"[/Script/WDGame.WDGameSession]\r\nServerName=Renamed\r\n"}')"
check config-validate-bad 'could not be parsed' "$(req $J1 POST /api/servers/$SID/rcon/configValidate '{"text":"garbage line\r\n"}')"
check config-apply-conflict '"conflict":true' "$(req $J1 POST /api/servers/$SID/rcon/configApply '{"text":"[/Script/WDGame.WDGameSession]\r\nServerName=Renamed\r\n","revision":"stale"}')"
CFG=$(req $J1 GET /api/servers/$SID/rcon/config); REV=$(echo "$CFG" | sed -E 's/.*"revision":"([^"]+)".*/\1/')
BODY="{\"text\":\"[/Script/WDGame.WDGameSession]\\r\\nServerName=Renamed\\r\\n\",\"revision\":\"$REV\"}"
check config-apply-ok '"ok":true' "$(req $J1 POST /api/servers/$SID/rcon/configApply "$BODY")"
check raw-blocked-path 'must start with /v1/' "$(req $J1 POST /api/servers/$SID/rcon/raw '{"method":"GET","path":"/etc/passwd"}')"
check raw-ok '"status":200' "$(req $J1 POST /api/servers/$SID/rcon/raw '{"method":"GET","path":"/v1/status"}')"

echo "== users & rbac"
R=$(req $J1 POST /api/users '{"username":"bob","password":"bobs-long-password","displayName":"Bob","role":"member","mustChangePassword":false}'); check user-create '"id"' "$R"
UID_BOB=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check user-dup 'taken' "$(req $J1 POST /api/users '{"username":"bob","password":"bobs-long-password"}')"
check user-list '"username":"bob"' "$(req $J1 GET /api/users)"
check user-list-forbidden-anon 'Sign in required' "$(req $J3 GET /api/users)"
check bob-login '303' "$(form $J3 '/sign-in?/password' 'username=bob&password=bobs-long-password')"
check bob-no-servers '"servers":[]' "$(req $J3 GET /api/servers)"
check bob-not-owner 'Owner access required' "$(req $J3 GET /api/users)"
check bob-users-page-403 '403' "$(pagecode $J3 /users)"
check bob-server-404 'Server not found' "$(req $J3 GET /api/servers/$SID/rcon/status)"
GB="{\"grants\":[{\"serverId\":\"$SID\",\"role\":\"viewer\"}]}"
check grant-viewer '"role":"viewer"' "$(req $J1 PUT /api/users/$UID_BOB/grants "$GB")"
check bob-sees-server '"role":"viewer"' "$(req $J3 GET /api/servers)"
check bob-org-member '"username":"bob"' "$(req $J1 GET /api/orgs/$ORG/members)"
check bob-status-ok '"scores"' "$(req $J3 GET /api/servers/$SID/rcon/status)"
check bob-kick-denied "needs the 'operator' role" "$(req $J3 POST /api/servers/$SID/rcon/kick '{"steamId":"76561198100000103"}')"
GB="{\"grants\":[{\"userId\":\"$UID_BOB\",\"role\":\"operator\"}]}"
check server-grants-put '"role":"operator"' "$(req $J1 PUT /api/servers/$SID/grants "$GB")"
check server-grants-get '"username":"bob"' "$(req $J1 GET /api/servers/$SID/grants)"
check bob-kick-ok 'Kicked' "$(req $J3 POST /api/servers/$SID/rcon/kick '{"steamId":"76561198100000103"}')"
check bob-ban-denied "needs the 'admin' role" "$(req $J3 POST /api/servers/$SID/rcon/ban '{"steamId":"76561198100000106"}')"
check bob-server-page '200' "$(pagecode $J3 /server/$SID)"
check bob-audit-own-only '0' "$(req $J3 GET '/api/audit' | grep -o '"actorName":"james"' | wc -l | tr -d ' ')"
check bob-audit-has-own '"actorName":"bob"' "$(req $J3 GET '/api/audit')"
check user-disable '"ok":true' "$(req $J1 PATCH /api/users/$UID_BOB '{"disabled":true}')"
check bob-signed-out 'Sign in required' "$(req $J3 GET /api/servers)"
check bob-login-disabled '403' "$(form $J3 '/sign-in?/password' 'username=bob&password=bobs-long-password')"
check user-enable '"ok":true' "$(req $J1 PATCH /api/users/$UID_BOB '{"disabled":false}')"
check user-reset-pw '"ok":true' "$(req $J1 PATCH /api/users/$UID_BOB '{"password":"another-long-password","mustChangePassword":true}')"
check bob-login-new '303' "$(form $J3 '/sign-in?/password' 'username=bob&password=another-long-password')"
check bob-forced-change 'must_change_password' "$(req $J3 GET /api/servers)"
check bob-forced-redirect '/account?force=1' "$(curl -s -o /dev/null -w '%{redirect_url}' -b $J3 $B/)"
check bob-change-pw "303 $B/" "$(form $J3 '/account?/password&force=1' 'current=another-long-password&next=bobs-final-password&again=bobs-final-password')"
check bob-unlocked '"servers"' "$(req $J3 GET /api/servers)"
check demote-last-owner 'last owner' "$(req $J1 PATCH /api/users/$(req $J1 GET /api/users | grep -o '"id":"[^"]*","username":"james"' | sed -E 's/"id":"([^"]+)".*/\1/') '{"role":"member"}')"
check user-delete '"ok":true' "$(req $J1 DELETE /api/users/$UID_BOB)"
check bob-gone 'Sign in required' "$(req $J3 GET /api/servers)"

echo "== lockout"
J4=$(mktemp)
for i in 1 2 3 4 5 6 7 8; do form $J4 '/sign-in?/password' 'username=locky&password=nope-nope-nope' >/dev/null; done
check locked-out '429' "$(form $J4 '/sign-in?/password' 'username=locky&password=nope-nope-nope')"

echo "== audit"
check audit-list '"action":"rcon.kick"' "$(req $J1 GET '/api/audit?limit=200')"
check audit-login '"action":"login"' "$(req $J1 GET '/api/audit?action=login')"
check audit-denied '"outcome":"denied"' "$(req $J1 GET '/api/audit?outcome=denied')"
req $J1 POST /api/servers/$SID/rcon/raw '{"method":"POST","path":"/v1/broadcast","body":{"message":"hi","password":"secret-value"}}' >/dev/null
check audit-redacted '[redacted]' "$(req $J1 GET '/api/audit?action=rcon.raw&limit=5')"
check audit-not-leaked '0' "$(req $J1 GET '/api/audit?action=rcon.raw&limit=5' | grep -c secret-value)"
check audit-server-filter '"action":"rcon.broadcast"' "$(req $J1 GET "/api/audit?server=$SID&action=rcon.broadcast")"
check audit-meta '"actors"' "$(req $J1 GET /api/audit/meta)"
check audit-export-csv 'id,ts,actorName' "$(req $J1 GET '/api/audit/export?format=csv' | head -1)"
check audit-export-json '"category"' "$(req $J1 GET '/api/audit/export?format=json' | head -40)"
check steam-disabled 'not configured' "$(req $J1 GET '/api/steam/profiles?ids=76561198100000101')"

echo "== player intel"
P1=76561198100000104
check dossier '"steamId":"'$P1'"' "$(req $J1 GET /api/servers/$SID/players/$P1)"
check dossier-badid '17-digit' "$(req $J1 GET /api/servers/$SID/players/abc)"
check marks '"marks"' "$(req $J1 GET "/api/servers/$SID/players/marks?ids=$P1,76561198100000105&names=a%0Ab")"
check note-add '"body":"keeps team-killing"' "$(req $J1 POST /api/servers/$SID/players/$P1/notes '{"body":"keeps team-killing"}')"
check note-empty 'empty' "$(req $J1 POST /api/servers/$SID/players/$P1/notes '{"body":"  "}')"
NOTE=$(req $J1 GET /api/servers/$SID/players/$P1 | grep -o '"notes":\[{"id":[0-9]*' | grep -o '[0-9]*$')
check watch-on '"ok":true' "$(req $J1 PUT /api/servers/$SID/players/$P1/watch '{"watched":true,"reason":"tk"}')"
check dossier-watched '"watched":true,"reason":"tk"' "$(req $J1 GET /api/servers/$SID/players/$P1)"
check marks-watched '"watched":true' "$(req $J1 GET "/api/servers/$SID/players/marks?ids=$P1")"
check note-delete '"ok":true' "$(req $J1 DELETE /api/servers/$SID/players/$P1/notes/$NOTE)"
check steam-refresh-disabled 'not configured' "$(req $J1 POST /api/servers/$SID/players/$P1/steam)"
check audit-player '"action":"player.watch"' "$(req $J1 GET '/api/audit?action=player.watch')"

echo "== triggers"
check trigger-badkind 'Unknown trigger kind' "$(req $J1 POST /api/servers/$SID/triggers '{"kind":"nope"}')"
check trigger-badcfg 'empty' "$(req $J1 POST /api/servers/$SID/triggers '{"kind":"welcome","config":{"message":""}}')"
R=$(req $J1 POST /api/servers/$SID/triggers '{"kind":"welcome","name":"Hello","enabled":true,"config":{"message":"Welcome {name} to {server}"}}'); check trigger-create '"kind":"welcome"' "$R"
TID=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check trigger-list '"name":"Hello"' "$(req $J1 GET /api/servers/$SID/triggers)"
check trigger-update '"enabled":false' "$(req $J1 PATCH /api/servers/$SID/triggers/$TID '{"enabled":false}')"
check trigger-dryrun '"fires"' "$(req $J1 POST /api/servers/$SID/triggers/dry-run '{"kind":"welcome","config":{"message":"hi {name}"}}')"
check trigger-dryrun-risk 'Steam lookup is off' "$(req $J1 POST /api/servers/$SID/triggers/dry-run '{"kind":"risk_kick","config":{"watchlist":true}}')"
check trigger-dryrun-broadcast '"kind":"broadcast"' "$(req $J1 POST /api/servers/$SID/triggers/dry-run '{"kind":"broadcast","config":{"messages":["a"],"everyMinutes":1}}')"
R=$(req $J1 POST /api/servers/$SID/triggers '{"kind":"risk_kick","name":"Watch kick","enabled":true,"config":{"watchlist":true,"reason":"watched"}}'); TID2=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
R=$(req $J1 POST /api/servers/$SID/triggers '{"kind":"welcome","name":"Hello 2","enabled":true,"config":{"message":"Welcome {name}"}}'); TID3=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check trigger-delete '"ok":true' "$(req $J1 DELETE /api/servers/$SID/triggers/$TID)"
check trigger-gone 'not found' "$(req $J1 PATCH /api/servers/$SID/triggers/$TID '{"enabled":true}')"

echo "== webhooks"
check webhook-badurl 'Discord webhook URL' "$(req $J1 POST /api/orgs/$ORG/webhooks '{"label":"x","url":"https://example.com/hook","events":["bans"]}')"
check webhook-noevents 'at least one' "$(req $J1 POST /api/orgs/$ORG/webhooks '{"label":"x","url":"https://discord.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","events":[]}')"
R=$(req $J1 POST /api/orgs/$ORG/webhooks '{"label":"#log","url":"https://discord.com/api/webhooks/123456789012345678/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","events":["bans","triggers"]}'); check webhook-create '"urlHint":"discord.com/api/webhooks/123456789012345678/…"' "$R"
WID=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check webhook-no-url-leak '0' "$(req $J1 GET /api/orgs/$ORG/webhooks | grep -c aaaaaaaaaaaaaaaa)"
check webhook-update '"enabled":false' "$(req $J1 PATCH /api/orgs/$ORG/webhooks/$WID '{"enabled":false}')"
check webhook-test-fails '"ok":false' "$(req $J1 POST /api/orgs/$ORG/webhooks/$WID/test)"
check webhook-delete '"ok":true' "$(req $J1 DELETE /api/orgs/$ORG/webhooks/$WID)"

echo "== org lists"
L1=76561198100000501
check lists-get '"kind":"ban"' "$(req $J1 GET /api/orgs/$ORG/lists)"
check lists-badkind 'No such list' "$(req $J1 GET /api/orgs/$ORG/lists/nope/entries)"
LB="{\"steamId\":\"$L1\",\"reason\":\"smoke\"}"
check list-add "\"steamId\":\"$L1\"" "$(req $J1 POST /api/orgs/$ORG/lists/ban/entries "$LB")"
check list-dup 'already on' "$(req $J1 POST /api/orgs/$ORG/lists/ban/entries "$LB")"
check list-badid '17-digit' "$(req $J1 POST /api/orgs/$ORG/lists/ban/entries '{"steamId":"x"}')"
check list-expiry-past 'future' "$(req $J1 POST /api/orgs/$ORG/lists/ban/entries '{"steamId":"76561198100000502","expiresAt":"2020-01-01T00:00:00Z"}')"
check list-entries "\"steamId\":\"$L1\"" "$(req $J1 GET /api/orgs/$ORG/lists/ban/entries)"
check list-count '"entryCount":1' "$(req $J1 GET /api/orgs/$ORG/lists)"
check reserve-add '"priority":5' "$(req $J1 POST /api/orgs/$ORG/lists/reserve/entries '{"steamId":"76561198100000601","priority":5}')"
check list-remove '"ok":true' "$(req $J1 DELETE /api/orgs/$ORG/lists/ban/entries/$L1)"
check list-remove-gone 'not on the' "$(req $J1 DELETE /api/orgs/$ORG/lists/ban/entries/$L1)"
check list-readd "\"steamId\":\"$L1\"" "$(req $J1 POST /api/orgs/$ORG/lists/ban/entries "$LB")"
check list-history '"removal":"manual"' "$(req $J1 GET "/api/orgs/$ORG/lists/ban/entries?includeRemoved=1")"
check audit-list-add '"action":"list.add"' "$(req $J1 GET '/api/audit?action=list.add')"
# carol: outsider -> viewer (still no lists) -> server admin (editor, but not the org overview)
R=$(req $J1 POST /api/users '{"username":"carol","password":"carols-long-password","displayName":"Carol","role":"member","mustChangePassword":false}'); UID_CAROL=$(echo "$R" | sed -E 's/.*"id":"([^"]+)".*/\1/')
J5=$(mktemp); form $J5 '/sign-in?/password' 'username=carol&password=carols-long-password' >/dev/null
check lists-outsider 'not found' "$(req $J5 GET /api/orgs/$ORG/lists)"
req $J1 PUT /api/users/$UID_CAROL/grants "{\"grants\":[{\"serverId\":\"$SID\",\"role\":\"viewer\"}]}" >/dev/null
check lists-viewer-denied 'not found' "$(req $J5 GET /api/orgs/$ORG/lists)"
req $J1 PUT /api/users/$UID_CAROL/grants "{\"grants\":[{\"serverId\":\"$SID\",\"role\":\"admin\"}]}" >/dev/null
check lists-editor '"role":"editor"' "$(req $J5 GET /api/orgs/$ORG/lists)"
check lists-editor-add '"steamId":"76561198100000503"' "$(req $J5 POST /api/orgs/$ORG/lists/ban/entries '{"steamId":"76561198100000503"}')"
check lists-editor-orgs-link "/orgs/$ORG/bans" "$(curl -s -b $J5 $B/orgs)"
check page-editor-bans '200' "$(pagecode $J5 "/orgs/$ORG/bans")"
check page-editor-overview '403' "$(pagecode $J5 "/orgs/$ORG")"
# sync: adding an entry pushes it to the demo server straight away
check sync-applied "$L1" "$(req $J1 GET /api/servers/$SID/rcon/bans)"
check sync-state-managed "\"$L1\":{\"state\":\"applied\",\"managed\":true}" "$(req $J1 GET /api/servers/$SID/lists/state)"
check sync-reserve-applied '76561198100000601' "$(req $J1 GET /api/servers/$SID/rcon/reserved)"
check sync-local-ban '"76561198100000301":{"state":"local","managed":false}' "$(req $J1 GET /api/servers/$SID/lists/state)"
check sync-remove '"ok":true' "$(req $J1 DELETE /api/orgs/$ORG/lists/ban/entries/$L1)"
check sync-removed '0' "$(req $J1 GET /api/servers/$SID/rcon/bans | grep -c $L1)"
check sync-local-kept '76561198100000301' "$(req $J1 GET /api/servers/$SID/rcon/bans)"
check sync-now '"sync"' "$(req $J1 POST /api/orgs/$ORG/lists/sync)"
check sync-server-now '"ok":true' "$(req $J1 POST /api/servers/$SID/lists/sync)"
check sync-view-servers '"reservedCap"' "$(req $J1 GET /api/orgs/$ORG/lists)"
# cap: the demo server holds 2 seeded slots + 1 added above + the org's 601; capping it at 3 makes the next org slot overflow
CFG=$(req $J1 GET /api/servers/$SID/rcon/config); REV=$(echo "$CFG" | sed -E 's/.*"revision":"([^"]+)".*/\1/')
BODY="{\"text\":\"[/Script/WDGame.WDGameSession]\\r\\nServerName=Renamed\\r\\nMaxReservedSlots=3\\r\\n\",\"revision\":\"$REV\"}"
req $J1 POST /api/servers/$SID/rcon/configApply "$BODY" >/dev/null
check reserve-full 'Reserved slots are full' "$(req $J1 POST /api/orgs/$ORG/lists/reserve/entries '{"steamId":"76561198100000602"}')"
check reserve-full-state '"state":"failed"' "$(req $J1 GET /api/orgs/$ORG/lists/reserve/entries)"
check audit-sync '"action":"lists.sync"' "$(req $J1 GET '/api/audit?action=lists.sync')"

echo "== analytics"
sleep 12
check analytics '"population"' "$(req $J1 GET "/api/servers/$SID/analytics?range=24h")"
check analytics-sessions '"steamId"' "$(req $J1 GET "/api/servers/$SID/analytics?range=24h")"
check analytics-anon 'Sign in required' "$(req $J3 GET "/api/servers/$SID/analytics")"
check analytics-page '200' "$(pagecode $J1 "/server/$SID/analytics")"
# The demo server gains players at random; the welcome trigger fires one poll after a join.
for i in $(seq 1 30); do R=$(req $J1 GET '/api/audit?action=trigger.welcome&limit=5'); [[ "$R" == *'"action":"trigger.welcome"'* ]] && break; sleep 3; done
check trigger-fired '"action":"trigger.welcome"' "$R"
check trigger-firecount '"fireCount":' "$(req $J1 GET /api/servers/$SID/triggers | grep -o '"fireCount":[1-9]' | head -1)"
req $J1 DELETE /api/servers/$SID/triggers/$TID2 >/dev/null; req $J1 DELETE /api/servers/$SID/triggers/$TID3 >/dev/null

echo "== pages (owner)"
for p in / /audit /users /servers /orgs "/orgs/$ORG" "/orgs/$ORG/bans" "/orgs/$ORG/reserved" /account "/server/$SID" "/server/$SID/players" "/server/$SID/players/$P1" "/server/$SID/automation" "/server/$SID/rotation" "/server/$SID/config" "/server/$SID/log" "/audit?outcome=denied&q=kick"; do check "page $p" '200' "$(pagecode $J1 "$p")"; done
check page-unknown-server '404' "$(pagecode $J1 /server/nope)"
check server-delete '"ok":true' "$(req $J1 DELETE /api/servers/$SID2)"
check page-sessions 'this session' "$(curl -s -b $J1 $B/account)"
check sign-out '303' "$(curl -s -o /dev/null -w '%{http_code}' -b $J1 -c $J1 -H "Origin: $B" -X POST $B/sign-out)"
check signed-out 'Sign in required' "$(req $J1 GET /api/servers)"
echo; echo "passed=$pass failed=$fail"
