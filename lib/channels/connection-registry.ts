import type { ChannelProvider } from "./types";
import type { ChannelConnectionDriver } from "./connection-types";
import { telegramConnectionDriver } from "./telegram/connection-driver";

/** Registro explícito (Composition Root) das operações de conexão por provider. */
export class ChannelConnectionRegistry {
  private readonly drivers = new Map<ChannelProvider, ChannelConnectionDriver<unknown>>();

  register<TCredential>(driver: ChannelConnectionDriver<TCredential>): this {
    if (this.drivers.has(driver.provider)) throw new Error(`duplicate_channel_connection_driver: ${driver.provider}`);
    this.drivers.set(driver.provider, driver as ChannelConnectionDriver<unknown>);
    return this;
  }

  get(provider: ChannelProvider): ChannelConnectionDriver<unknown> {
    const driver = this.drivers.get(provider);
    if (!driver) throw new Error(`unknown_channel_connection_driver: ${provider}`);
    return driver;
  }

  providers(): ChannelProvider[] {
    return [...this.drivers.keys()];
  }
}

/** Registro padrão: novos providers são adicionados aqui uma vez. */
export const CHANNEL_CONNECTIONS = new ChannelConnectionRegistry()
  .register(telegramConnectionDriver);
