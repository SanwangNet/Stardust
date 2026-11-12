import { createConfigStore, type ConfigUpdate, type StardustConfig } from "./config.js";

export class SetupService {
  constructor(private readonly store: ReturnType<typeof createConfigStore> = createConfigStore()) {}

  getInitializationState(): { initialized: boolean } {
    return { initialized: this.store.loadConfig().initialized };
  }

  getSetupConfig(): Pick<StardustConfig, "service" | "server" | "web"> {
    const { service, server, web } = this.store.loadConfig();
    return { service, server, web };
  }

  async completeInitialization(input: ConfigUpdate): Promise<StardustConfig> {
    // initializeConfig performs the full read/check/write synchronously, before this promise settles.
    return this.store.initializeConfig(input);
  }
}

export const setupService = new SetupService();
