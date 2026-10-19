import { telegramInboundDriver } from "../telegram/driver";
import type { ChannelProvider } from "../types";
import type { InboundChannelDriver } from "./types";

/** Um único ponto para registrar drivers inbound. Não faz fallback para outro canal. */
const INBOUND_DRIVERS: Partial<Record<ChannelProvider, InboundChannelDriver>> = {
  telegram: telegramInboundDriver,
};

export function getInboundDriver(provider: ChannelProvider): InboundChannelDriver {
  const driver = INBOUND_DRIVERS[provider];
  if (!driver) throw new Error(`inbound_driver_not_configured: ${provider}`);
  return driver;
}

export function supportsInbound(provider: ChannelProvider): boolean {
  return INBOUND_DRIVERS[provider] !== undefined;
}
