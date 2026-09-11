# Map imagery attribution

The images in this directory are © BULKHEAD, the developer of WARDOGS. They are the map, time-of-day
and weather previews served by the official WARDOGS RCON console at `rcon.wardogs.com`
(`img/maps/<MapId>/<Lighting>-<variant>.webp`), mirrored unchanged by `scripts/fetch-map-art.sh`
so that Warcon, a community tool with no affiliation to BULKHEAD or Team17, can show the same
previews to server operators. Warcon credits them in its page footer.

They are **not** covered by the MIT licence in the repository root, which applies to Warcon's own
code and assets only. Do not reuse them outside a WARDOGS server-administration context; if you
fork Warcon for another purpose, delete this directory. BULKHEAD may ask for them to be removed at
any time, in which case Warcon degrades to text labels without them.

Layout: one folder per server map id (`Kavkazi` = Bakurani, `Europe` = Ozeti, `NorthAmerica` =
Zestafona), one file per lighting preset and crop: `720` (1280×720), `square` (576×720) and
`wide` (1920×149).
