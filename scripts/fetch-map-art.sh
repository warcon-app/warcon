#!/usr/bin/env sh
# Mirrors the map art the official WARDOGS RCON console serves (rcon.wardogs.com, HTTP only) into
# static/maps so warcon can show it over https. Images are BULKHEAD's; warcon credits them in
# the footer. Re-run when the game adds a map or lighting preset.
set -eu
BASE="http://rcon.wardogs.com/img/maps"
OUT="$(cd "$(dirname "$0")/.." && pwd)/static/maps"
MAPS="Kavkazi Europe NorthAmerica Russia"
LIGHTS="DayStartClear DayEarlyClear DayEarlyFog DayClear DayLateClear DayLateGray DayLateGrayFog DayEndClear DayLateRain"
VARIANTS="square wide 720"
# Sabatulo (Russia, Season 3) takes four of the lightings, and the console has art for those alone.
lights_for() {
	case "$1" in
	Russia) echo "DayClear DayLateClear DayLateGray DayLateRain" ;;
	*) echo "$LIGHTS" ;;
	esac
}
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
for m in $MAPS; do
	for l in $(lights_for "$m"); do
		for v in $VARIANTS; do
			f="$m/$l-$v.webp"
			[ -s "$OUT/$f" ] && continue
			# Fetched aside first: a map's folder is made with its first image, so a map the console
			# has no art for leaves no empty folder behind.
			: >"$TMP"
			if curl -fsS --max-time 60 -o "$TMP" "$BASE/$f" && [ -s "$TMP" ]; then
				mkdir -p "$OUT/$m" && cp "$TMP" "$OUT/$f" && chmod 644 "$OUT/$f" && echo "fetched $f"
			else
				echo "missing $f" >&2
			fi
		done
	done
done
