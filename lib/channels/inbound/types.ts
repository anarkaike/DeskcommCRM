import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelProvider } from "../types";

/** Evento canônico produzido após autenticar e interpretar payload do canal. */
export interface InboundMessageEvent {
  organizationId: string;
  channel: ChannelProvider;
  channelSessionId: string;
  contactId: string;
  conversationId: string;
  externalId: string;
  text: string | null;
  media?: { kind: "image" | "audio" | "document" | "video"; reference: string; mime: string | null };
  sentAt: string;
  contactName: string | null;
  origin: string;
  metadata: Record<string, unknown>;
  inboxOnly?: boolean;
}

/** Driver específico autentica, valida, resolve identidade e traduz o payload. */
export interface InboundChannelDriver {
  readonly provider: ChannelProvider;
  ingest(admin: SupabaseClient, input: {
    organizationId: string;
    connectionId: string;
    update: Record<string, unknown>;
  }): Promise<"ingested" | "duplicate" | "ignored">;
}
