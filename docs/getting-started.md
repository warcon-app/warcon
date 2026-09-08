# Getting started with Warcon

This is the short, plain-language version. If you are comfortable with Docker and `.env` files, the
[README](../README.md) has everything in more detail.

Warcon is a web page you host yourself. You open it in a browser, log in, and control your WARDOGS
servers from there. Nobody on your team needs the RCON password; they get their own login instead.

## What you need

1. **A machine to run it on.** A cheap VPS, a spare PC, or the same box your game server runs on.
   It needs to be switched on whenever people want to use the panel.
2. **Docker** installed on that machine. Get it from <https://docs.docker.com/get-docker/>
   (Docker Desktop on Windows or Mac, Docker Engine on Linux). Docker Compose comes with it.
3. **Your game server's RCON details:** its IP address or hostname, the RCON port (usually `7776`)
   and the RCON password. See [Turning on RCON on the game server](#turning-on-rcon-on-the-game-server)
   below if you have not set this up yet.

You will type a few commands into a terminal (Terminal on Mac, PowerShell or Git Bash on Windows,
any shell on Linux). Copy and paste them exactly.

## Step 1: get the files

```bash
git clone https://github.com/warcon-app/warcon.git warcon
cd warcon
```

No git? Download the ZIP from <https://github.com/warcon-app/warcon>, unzip it, and open a terminal
in that folder.

## Step 2: create the settings file

Warcon reads its settings from a file called `.env`. Start from the example:

```bash
cp .env.example .env
```

Open `.env` in any text editor and change these four lines. Leave everything else alone.

| Line                 | What to put there                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET` | A long random string. Generate one with the command below.                                       |
| `ENCRYPTION_KEY`     | A different long random string. Generate another one.                                            |
| `POSTGRES_PASSWORD`  | Any password you like. You will never have to type it again.                                     |
| `ORIGIN`             | The address people will type into their browser. See below.                                      |

To generate a random string, run this once per secret and paste the result:

```bash
openssl rand -base64 32
```

If that command is not found, this does the same thing using Docker:

```bash
docker run --rm alpine sh -c "head -c 32 /dev/urandom | base64"
```

For `ORIGIN`, use the exact address you will open in the browser, with no trailing slash:

- Running it on your own PC to try it out: `ORIGIN=http://localhost:3000`
- Running it on a VPS with IP `203.0.113.10`: `ORIGIN=http://203.0.113.10:3000`
- Running it behind a domain with HTTPS: `ORIGIN=https://rcon.yourclan.com` (see the README's
  reverse proxy section for that setup)

If `ORIGIN` does not match what is in the address bar, sign-in will not work. This is the most
common mistake.

**Keep `.env` safe and back it up.** `ENCRYPTION_KEY` protects the stored RCON passwords. If you
lose it, you will have to re-enter every server's RCON password. Never change it later.

## Step 3: start it

```bash
docker compose up -d
```

The first run downloads and builds everything, which can take a few minutes. When it finishes, open
the `ORIGIN` address in your browser. If you see nothing, wait 30 seconds and refresh.

To see what it is doing:

```bash
docker compose logs -f
```

Press `Ctrl+C` to stop watching. Warcon keeps running in the background and restarts by itself if
the machine reboots.

## Step 4: create your owner account

The very first visit shows a **setup** form. Pick a username and a strong password. This is the
**owner** account: it can do everything, including adding servers and users. There is only one
setup screen, and it disappears once the owner exists.

## Step 5: try the demo server first

Warcon ships with a fake game server so you can click around before touching a real one. Go to
**Servers → Add server** and enter:

| Field         | Value  |
| ------------- | ------ |
| Name          | Demo   |
| Host          | `demo` |
| Port          | `1`    |
| Scheme        | `http` |
| RCON password | `demo` |

Save it, open it from the dashboard, and have a look at the scoreboard, map rotation, analytics and
so on. The numbers are made up. Delete it whenever you like.

## Step 6: add your real server

**Servers → Add server** again, this time with your real details:

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| Name          | Whatever you call the server                                 |
| Host          | The game server's IP address or hostname                     |
| Port          | The RCON port from `ServerSettings.ini`, usually `7776`      |
| Scheme        | `http` (unless you set up HTTPS on the game server yourself) |
| RCON password | The RCON password from `ServerSettings.ini`                  |

Press **Test** before saving. If it fails, see [If Test fails](#if-test-fails) below.

## Step 7: let your team in

1. **Users & Access → Add user.** Give them a username and a temporary password. They will be asked
   to change it on first login.
2. Click **Access** next to the user and choose a role for each server:

| Role       | Can                                                                       |
| ---------- | ------------------------------------------------------------------------- |
| `viewer`   | Look, but not touch. Scoreboard, analytics, logs, config (read only).     |
| `operator` | Everyday moderation: kick, kill, whisper, broadcast, change map, end match. |
| `admin`    | Everything on that server: bans, reserved slots, config changes.          |

Only the owner can add servers and users. Every action anyone takes is recorded in **Audit**.

## Turning on RCON on the game server

On the game server, open `ServerSettings.ini` and find (or add) this section:

```ini
[/Script/WDRCON.WDRCONSettings]
bEnabled=True
BindAddress=0.0.0.0
Port=7776
Password=pick-a-long-random-password
```

Restart the game server afterwards. Then make sure Warcon's machine is allowed to reach port `7776`
on the game server. On most hosting providers this is a firewall or "ports" page in their control
panel; allow only the IP address of the machine running Warcon, not the whole internet. The RCON
password travels with every request, so the firewall is what keeps it private.

If Warcon runs on the same machine as the game server, you can keep `BindAddress=127.0.0.1` instead.
Then open `docker-compose.yml`, remove the `#` from the two `extra_hosts` lines, run
`docker compose up -d` again, and use `host.docker.internal` as the Host when adding the server.

## Everyday things

**Update to the latest version**

```bash
git pull
docker compose up -d --build
```

**Stop it** with `docker compose down`. **Start it again** with `docker compose up -d`. Your data
and settings are kept.

**Back it up.** Two things matter: the `.env` file, and the database. Back up the database with:

```bash
docker compose exec db pg_dump -U warcon warcon > warcon-backup.sql
```

## If something goes wrong

**The page does not load.** Run `docker compose ps`. Both `warcon` and `db` should say running or
healthy. If not, `docker compose logs warcon` usually says why. On a VPS, check that port `3000`
is open in the provider's firewall.

**Sign-in says "Cross-site POST form submissions are forbidden", or drops me back on the sign-in
page.** `ORIGIN` in `.env` does not match the address in your browser. Fix it, then run
`docker compose up -d` again to apply.

### If Test fails

- **Cannot connect / timed out.** Warcon's machine cannot reach the game server's RCON port. Check
  `bEnabled=True`, `BindAddress`, the port number, that the game server was restarted after editing
  the ini, and the firewall on the game host.
- **401 / unauthorized.** Wrong RCON password. Copy it again from `ServerSettings.ini`.
- **It works from the official console but not from Warcon.** The official console runs from your
  browser, so it uses your PC's IP. Warcon uses the IP of the machine it runs on. Allow that IP in
  the game host's firewall too.

**I want to start over.** This deletes all Warcon data, including users and the audit trail. Your
game servers are not affected.

```bash
docker compose down -v
```
