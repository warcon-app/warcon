#!/usr/bin/env sh
# Mirrors the map art the official WARDOGS RCON console serves (rcon.wardogs.com, HTTP only) into
# static/maps so warcon can show it over https. Images are BULKHEAD's; warcon credits them in
# the footer. Re-run when the game adds a map or lighting preset.
set -eu
BASE="http://rcon.wardogs.com/img/maps"
OUT="$(cd "$(dirname "$0")/.." && pwd)/static/maps"
MAPS="Kavkazi Europe NorthAmerica"
LIGHTS="DayStartClear DayEarlyClear DayEarlyFog DayClear DayLateClear DayLateGray DayLateGrayFog DayEndClear"
VARIANTS="square wide 720"
for m in $MAPS; do
	mkdir -p "$OUT/$m"
	for l in $LIGHTS; do
		for v in $VARIANTS; do
			f="$m/$l-$v.webp"
			[ -s "$OUT/$f" ] && continue
			curl -fsS --max-time 30 -o "$OUT/$f" "$BASE/$f" && echo "fetched $f" || echo "missing $f" >&2
		done
	done
done
