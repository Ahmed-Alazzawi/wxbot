/**
 * Calls to Discord's REST API.
 *
 * Replying to a slash command needs no token: we just return JSON.
 * Posting a message on our own (an alert) does need the bot token.
 */

import { errorFields, logEvent } from "./log";

const API = "https://discord.com/api/v10";

export type SendResult = "sent" | "gone" | "failed";

/**
 * Posts a message to a channel.
 * "gone" means the bot can't post there any more (channel deleted, bot
 * removed, or permission taken away), so the caller should stop trying.
 */
export async function sendChannelMessage(token: string, channelId: string, payload: unknown): Promise<SendResult> {
  try {
    const response = await fetch(`${API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bot ${token}` },
      body: JSON.stringify(payload),
    });
    if (response.ok) return "sent";
    if (response.status === 403 || response.status === 404) return "gone";
    logEvent("error", "discord_rejected_alert", { status: response.status, body: await response.text() });
    return "failed";
  } catch (err) {
    logEvent("error", "discord_unreachable", errorFields(err));
    return "failed";
  }
}
