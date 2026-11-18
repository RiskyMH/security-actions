export const enum InteractionType {
    Ping = 1,
    ApplicationCommand = 2,
    MessageComponent = 3,
    ApplicationCommandAutocomplete = 4,
    ModalSubmit = 5,
}

export const enum InteractionCallbackType {
    Pong = 1,
    ChannelMessageWithSource = 4,
    DeferredChannelMessageWithSource = 5,
    Modal = 9,
}

export const enum ComponentType {
    ActionRow = 1,
    Button = 2,
    StringSelect = 3,
    TextInput = 4,
    Label = 18,
    CheckboxGroup = 22,
    Checkbox = 23,
}

export const enum MessageType {
    Default = 0,
    GuildIncidentAlertModeEnabled = 36,
    GuildIncidentAlertModeDisabled = 37,
}

export const enum MessageFlags {
    Ephemeral = 1 << 6, // 64
}

export const enum PermissionFlags {
    ManageGuild = 1 << 5,
    ViewChannel = 1 << 10,
}

export interface DiscordUser {
    id: string;
    username: string;
    bot?: boolean;
}

export interface DiscordMessage {
    id: string;
    channel_id: string;
    author: DiscordUser;
    type: MessageType;
    timestamp: string;
}

export interface DiscordGuild {
    id: string;
    system_channel_id: string | null;
    public_updates_channel_id: string | null;
    safety_alerts_channel_id: string | null;
    incidents_data: {
        invites_disabled_until: string | null;
        dms_disabled_until: string | null;
    } | null;
}

export interface ModalSubmitCheckboxGroup {
    type: ComponentType.CheckboxGroup;
    custom_id: string;
    values: string[];
}

export interface ModalSubmitCheckbox {
    type: ComponentType.Checkbox;
    custom_id: string;
    value: boolean;
}

type ModalSubmitInnerComponent = ModalSubmitCheckboxGroup | ModalSubmitCheckbox;

export interface ModalSubmitLabelComponent {
    type: ComponentType.Label;
    component: ModalSubmitInnerComponent;
}

export interface DiscordInteraction {
    id: string;
    type: InteractionType;
    guild_id?: string;
    application_id: string;
    token: string;
    data?: {
        name?: string;
        custom_id?: string;
        components?: ModalSubmitLabelComponent[];
    };
    member?: {
        permissions?: string;
    };
    app_permissions?: string;
}



export const discordFetch = (token: string) => async (path: string, options: RequestInit = {}): Promise<Response> => {
    const url = `https://discord.com/api${path}`;

    while (true) {
        const res = await fetch(url, {
            ...options,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bot ${token}`,
                ...options.headers,
            },
        });

        if (res.status === 429) {
            const retryAfter = Number(res.headers.get("Retry-After") ?? 5);
            console.warn(`[RATE LIMIT] Sleeping ${retryAfter}s on ${path}`);
            await Bun.sleep((retryAfter * 1000) + 250);
            continue;
        }

        const remaining = res.headers.get("X-RateLimit-Remaining");
        const resetAfter = res.headers.get("X-RateLimit-Reset-After");
        if (remaining === "0" && resetAfter) {
            await Bun.sleep((Number(resetAfter) * 1000) + 100);
        }

        return res;
    }
}

export const verifyDiscordSignature = async (publicKey: string) => {
    const key = await crypto.subtle.importKey(
        "raw",
        Uint8Array.fromHex(publicKey),
        { name: "Ed25519" },
        false,
        ["verify"]
    );
    const encoder = new TextEncoder();

    return async (request: Request, rawBody: string): Promise<boolean> => {
        const signature = request.headers.get("X-Signature-Ed25519");
        const timestamp = request.headers.get("X-Signature-Timestamp");
        if (!signature || !timestamp) return false;

        try {
            return await crypto.subtle.verify(
                "Ed25519",
                key,
                Uint8Array.fromHex(signature),
                encoder.encode(timestamp + rawBody)
            );
        } catch {
            return false;
        }
    }
}
