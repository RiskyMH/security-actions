import Database from "bun:sqlite";
import { DUE_CUTOFF_MS } from "./schedule";

export interface GuildConfigRow {
    id: string;
    pause_dms: number;
    pause_invites: number;
    delete_alert: number;
    last_refreshed: number;
}

export const db = new Database(process.env.DB_PATH || "db.sqlite", { create: true });
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000");
db.run(`
  CREATE TABLE IF NOT EXISTS guilds (
    id TEXT PRIMARY KEY,
    pause_dms INTEGER NOT NULL DEFAULT 0,
    pause_invites INTEGER NOT NULL DEFAULT 0,
    delete_alert INTEGER NOT NULL DEFAULT 1,
    last_refreshed INTEGER NOT NULL DEFAULT 0
  )
`);

export const getGuildConfig = (id: string): GuildConfigRow | null =>
    db.query<GuildConfigRow, [string]>("SELECT * FROM guilds WHERE id = ?").get(id);

export const getDueGuilds = (cutoff = Date.now() - DUE_CUTOFF_MS): GuildConfigRow[] =>
    db.query<GuildConfigRow, [number]>(
        `SELECT * FROM guilds
         WHERE (pause_dms = 1 OR pause_invites = 1) AND last_refreshed <= ?
         ORDER BY last_refreshed ASC`
    ).all(cutoff);

export const upsertGuildConfig = (cfg: GuildConfigRow) =>
    db.query<GuildConfigRow, [string, number, number, number, number]>(
        `INSERT INTO guilds (id, pause_dms, pause_invites, delete_alert, last_refreshed)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            pause_dms = excluded.pause_dms,
            pause_invites = excluded.pause_invites,
            delete_alert = excluded.delete_alert,
            last_refreshed = excluded.last_refreshed`
    ).run(cfg.id, cfg.pause_dms, cfg.pause_invites, cfg.delete_alert, cfg.last_refreshed);

export const markGuildRefreshed = (id: string) =>
    db.query("UPDATE guilds SET last_refreshed = ? WHERE id = ?").run(Date.now(), id);

export const removeGuild = (id: string) =>
    db.query("DELETE FROM guilds WHERE id = ?").run(id);
