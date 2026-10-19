import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelProvider } from "../types";

/** Evento canônico produzido depois de autenticar e interpretar o payload do canal. */
export interface InboundTextEvent {
  organizationId: string;
  channel: ChannelProvider;
  channelSessionId: string;
  contactId: string;
  conversationId: string;
  externalId: string;
  text: string;
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
