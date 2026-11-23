import { ComponentType, discordFetch as discordFetch_, InteractionCallbackType, InteractionType, MessageFlags, MessageType, PermissionFlags, verifyDiscordSignature as verifyDiscordSignature_, type DiscordGuild, type DiscordInteraction, type DiscordMessage } from "./discord";
import { getDueGuilds, getGuildConfig, markGuildRefreshed, removeGuild, upsertGuildConfig, type GuildConfigRow } from "./db";
import { getDisableUntil, nextRefreshTime } from "./schedule";

const BOT_TOKEN = process.env.DISCORD_TOKEN!;
const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY!;
const PORT = Number(process.env.PORT ?? 3000);

// Extract bot user ID from token
const BOT_USER_ID = atob(BOT_TOKEN.split(".")[0]!);

const discordFetch = discordFetch_(BOT_TOKEN);
const verifyDiscordSignature = await verifyDiscordSignature_(PUBLIC_KEY);

async function applyGuildIncidentActions(config: GuildConfigRow): Promise<boolean> {
    const untilIso = getDisableUntil();

    const putRes = await discordFetch(`/guilds/${config.id}/incident-actions`, {
        method: "PUT",
        body: JSON.stringify({
            dms_disabled_until: config.pause_dms ? untilIso : undefined,
            invites_disabled_until: config.pause_invites ? untilIso : undefined,
        }),
    });

    if (putRes.status === 404) {
        removeGuild(config.id);
    } else if (!putRes.ok) {
        console.log(`PUT for /guilds/:id/incident-actions: ${putRes.status} ${await putRes.text()}`);
        return false;
    }

    // Delete the message that discord created notifying the server that incident mode was enabled
    // because we do this every day, this will get spammy
    if (config.delete_alert) {
        const guildGetRes = await discordFetch(`/guilds/${config.id}`);
        const guild = (await guildGetRes.json()) as DiscordGuild;

        const alertChannelId =
            guild.safety_alerts_channel_id ??
            guild.public_updates_channel_id ??
            guild.system_channel_id;

        if (alertChannelId) {
            await Bun.sleep(50);

            const msgsRes = await discordFetch(`/channels/${alertChannelId}/messages?limit=25`);
            if (msgsRes.ok) {
                const messages = (await msgsRes.json()) as DiscordMessage[];
                const alertMsgs = messages.filter(m =>
                    m.type === MessageType.GuildIncidentAlertModeEnabled &&
                    m.author.id === BOT_USER_ID
                );

                for (const alertMsg of alertMsgs) {
                    const res = await discordFetch(
                        `/channels/${alertChannelId}/messages/${alertMsg.id}`,
                        { method: "DELETE" }
                    );
                    if (!res.ok) {
                        console.warn(
                            `Failed to delete alert message: ${res.status} ${await res.text()}`
                        );
                    }
                }
            }
        }
    }

    return true;
}

let isRunningRefresh = false;
async function runRefresh(reason: "cron" | "startup"): Promise<void> {
    if (isRunningRefresh) return;
    isRunningRefresh = true;

    try {
        const dueGuilds = getDueGuilds();
        if (dueGuilds.length === 0) {
            return;
        }

        console.info(`[REFRESH:${reason.toUpperCase()}] Updating ${dueGuilds.length} due guilds...`);

        for (const guild of dueGuilds) {
            const ok = await applyGuildIncidentActions(guild);
            if (ok) markGuildRefreshed(guild.id);

            if ((isRunningRefresh as boolean) === false) {
                return console.info(`[REFRESH:${reason.toUpperCase()}] Stopped early due to shutdown.`);
            }
            await Bun.sleep(150);
        }

    } finally {
        isRunningRefresh = false;
    }
}

const reply = (content: string, ephemeral: boolean = true) =>
    Response.json({
        type: InteractionCallbackType.ChannelMessageWithSource,
        data: {
            flags: ephemeral ? MessageFlags.Ephemeral : undefined,
            content,
        },
    });

const followup = (application_id: string, token: string, content: string, ephemeral: boolean = true) =>
    discordFetch(`/webhooks/${application_id}/${token}`, {
        method: "POST",
        body: JSON.stringify({
            flags: ephemeral ? MessageFlags.Ephemeral : undefined,
            content,
        }),
    });

function buildConfigModalResponse(existing: GuildConfigRow | null) {
    return Response.json({
        type: InteractionCallbackType.Modal,
        data: {
            custom_id: ModalCustomId.IncidentConfig,
            title: "Incident Lock Configuration",
            components: [
                {
                    type: ComponentType.Label,
                    label: "Security Actions to Keep Enabled",
                    description: "Leave both unchecked to disable automatic locking.",
                    component: {
                        type: ComponentType.CheckboxGroup,
                        custom_id: ModalCustomId.ActionsGroup,
                        required: false,
                        min_values: 0,
                        max_values: 2,
                        options: [
                            {
                                label: "Pause Direct Messages",
                                value: IncidentActionOption.PauseDms,
                                description: "Continuously refresh the 24h DM pause.",
                                default: Boolean(existing?.pause_dms),
                            },
                            {
                                label: "Pause Invites",
                                value: IncidentActionOption.PauseInvites,
                                description: "Continuously refresh the 24h Invite pause.",
                                default: Boolean(existing?.pause_invites),
                            },
                        ],
                    },
                },
                {
                    type: ComponentType.Label,
                    label: "Cleanup System Message",
                    description: "Automatically delete the alert message by automod that security actions actions were enabled.",
                    component: {
                        type: ComponentType.Checkbox,
                        custom_id: ModalCustomId.DeleteAlertCheckbox,
                        default: existing ? Boolean(existing.delete_alert) : true,
                    },
                },
            ],
        },
    });
}

const hasFlag = <T extends bigint | number>(flags: T, flag: T) => (flags & flag) === flag;


export const enum IncidentActionOption {
    PauseDms = "pause_dms",
    PauseInvites = "pause_invites",
}

export const enum ModalCustomId {
    IncidentConfig = "incident_config_modal",
    ActionsGroup = "incident_actions_group",
    DeleteAlertCheckbox = "delete_alert_checkbox",
}

const server = Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method !== "POST") return new Response("Not found", { status: 404 });
        const rawBody = await req.text();
        if (!(await verifyDiscordSignature(req, rawBody))) {
            return new Response("Invalid signature", { status: 401 });
        }

        const interaction = JSON.parse(rawBody) as DiscordInteraction;
        if (interaction.type === InteractionType.Ping) {
            return Response.json({ type: InteractionCallbackType.Pong });
        }

        const guildId = interaction.guild_id;
        if (!guildId) {
            return reply("This command can only be used inside a server.", true);
        }

        if (
            interaction.type === InteractionType.ApplicationCommand &&
            interaction.data?.name === "config"
        ) {
            if (!hasFlag(BigInt(interaction?.member?.permissions ?? 0), BigInt(PermissionFlags.ManageGuild))) {
                return reply("You must have Manage Server permissions to use this command.", true);
            }
            if (!hasFlag(BigInt(interaction.app_permissions ?? 0), BigInt(PermissionFlags.ManageGuild))) {
                return reply("The bot must have Manage Server permissions to use this command.", true);
            }

            return buildConfigModalResponse(getGuildConfig(guildId));
        }

        if (
            interaction.type === InteractionType.ModalSubmit &&
            interaction.data?.custom_id === ModalCustomId.IncidentConfig
        ) {
            const components = interaction.data.components ?? [];
            let selectedActions: string[] = [];
            let deleteAlert = true;
            for (const wrapper of components) {
                const inner = wrapper.component;
                if (inner.type === ComponentType.CheckboxGroup && inner.custom_id === ModalCustomId.ActionsGroup) {
                    selectedActions = inner.values;
                } else if (inner.type === ComponentType.Checkbox && inner.custom_id === ModalCustomId.DeleteAlertCheckbox) {
                    deleteAlert = inner.value;
                }
            }

            const pauseDms = selectedActions.includes(IncidentActionOption.PauseDms);
            const pauseInvites = selectedActions.includes(IncidentActionOption.PauseInvites);
            if (!pauseDms && !pauseInvites) {
                removeGuild(guildId);
                return reply("Service disabled. No security actions are being auto-paused.", false);
            }

            const config: GuildConfigRow = {
                id: guildId,
                pause_dms: pauseDms ? 1 : 0,
                pause_invites: pauseInvites ? 1 : 0,
                delete_alert: deleteAlert ? 1 : 0,
                last_refreshed: Date.now(),
            };
            const ok = await applyGuildIncidentActions(config);
            if (!ok) {
                return reply(
                    "Failed to apply security actions. Ensure the bot has **Manage Server** permissions.",
                    true
                );
            }
            upsertGuildConfig(config);

            if (deleteAlert) {
                (async () => {
                    const guildGetRes = await discordFetch(`/guilds/${config.id}`);
                    const guild = (await guildGetRes.json()) as DiscordGuild;

                    const alertChannelId =
                        guild.safety_alerts_channel_id ??
                        guild.public_updates_channel_id ??
                        guild.system_channel_id;

                    if (alertChannelId) {
                        let hasAccess = null;
                        try {
                            const channelPermRes = await discordFetch(`/channels/${alertChannelId}/permissions/member/${BOT_USER_ID}`);
                            const channelPerms = (await channelPermRes.json()) as { permissions: string } | { code: number };
                            if ("code" in channelPerms && channelPerms.code === 50001 /* Missing Access */) {
                                hasAccess = false;
                            } else if ("permissions" in channelPerms) {
                                hasAccess = hasFlag(BigInt(channelPerms.permissions), BigInt(PermissionFlags.ViewChannel));
                            }
                        } catch (err) {
                            hasAccess = null;
                        }

                        if (hasAccess === false) {
                            return followup(interaction.application_id, interaction.token,
                                `Bot does not have access to the alert channel <#${alertChannelId}>. Won't be able to delete alert message.`,
                                true
                            );
                        }
                    }
                })();
            }

            const activeList = [
                pauseDms ? "Pause DMs" : null,
                pauseInvites ? "Pause Invites" : null,
            ].filter(Boolean).join(" & ");
            return reply(`Will apply **${activeList}** security actions every day!`, false);
        }
        return new Response("Unhandled interaction", { status: 400 });
    },
});
console.info(`Bot(${BOT_USER_ID}) listening on ${server.url}`);


const cmdRes = await discordFetch(`/applications/${BOT_USER_ID}/commands`, {
    method: "PUT",
    body: JSON.stringify([
        {
            name: "config",
            description: "Configure automatic incident security locks (forever enable dm/invite pauses).",
            default_member_permissions: PermissionFlags.ManageGuild.toString(),
            type: 1 /* ApplicationCommandType.ChatInput */,
            integration_types: [0 /* ApplicationIntegrationType.GuildInstall */],
            contexts: [0 /* InteractionContextType.Guild */],
        },
    ]),
});

if (cmdRes.ok) {
    console.info(`[COMMANDS] Registered /config slash command.`);
} else {
    throw new Error(`[COMMANDS] Failed to register commands: ${cmdRes.status} ${await cmdRes.text()}`);
}

// Self-reschedule off the epoch-derived slot rather than a `*/12` cron expression:
// 23h doesn't divide into a day, and this keeps the cadence stable across restarts.
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let scheduleStopped = false;
function scheduleNextRefresh() {
    if (scheduleStopped) return;
    refreshTimer = setTimeout(() => {
        void runRefresh("cron");
        scheduleNextRefresh();
    }, Math.max(0, nextRefreshTime() - Date.now()));
}
scheduleNextRefresh();
runRefresh("startup");


process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
});
process.on("SIGTERM", () => {
    console.info("SIGTERM received. Shutting down...");
    server.stop(false);
    scheduleStopped = true;
    clearTimeout(refreshTimer);
    isRunningRefresh = false;
});
