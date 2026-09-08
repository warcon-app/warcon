# Security

Warcon holds RCON passwords for game servers, so treat a vulnerability report as urgent.

Please report security issues privately through GitHub's "Report a vulnerability" button on this
repository rather than opening a public issue. Include steps to reproduce and the version or commit
you tested. You will get an acknowledgement within a few days.

Good practice when hosting: keep the RCON listener on `127.0.0.1` next to Warcon, set `ORIGIN` and
`ADDRESS_HEADER` only as documented, and back up `ENCRYPTION_KEY` separately from the database.
