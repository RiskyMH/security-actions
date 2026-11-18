# security-actions

Forever enable Discord [security actions](https://support.discord.com/hc/en-us/articles/17439993574167-Activity-Alerts-Security-Actions) for your server. This bot will automatically refresh the security actions every 24 hours, so you don't have to worry about them expiring. This means you can safely pause DMs and/or invites without worrying about them being re-enabled by Discord.

## Setup

Requires [Bun](https://bun.com).

```bash
bun install
bun run dev
```

Environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token. |
| `DISCORD_PUBLIC_KEY` | yes | Bot public key. |
| `PORT` | no | Port to listen on. Defaults to `3000`. |
| `DB_PATH` | no | Config DB. Defaults to `db.sqlite`. |

The bot is also fully containerized:

```bash
bun run docker:build   # build the image
bun run docker:deploy  # deploy with docker compose
bun run docker:logs    # tail the logs
```
