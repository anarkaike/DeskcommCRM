import { ingestTelegramUpdate } from "./ingest";
import type { InboundChannelDriver } from "../inbound/types";

/** Composition root do driver Telegram; protocolo e identidade ficam no adapter inbound. */
export const telegramInboundDriver: InboundChannelDriver = {
  provider: "telegram",
  ingest: ingestTelegramUpdate,
};
