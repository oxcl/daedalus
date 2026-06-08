import { ProviderConfig, ProviderModelEntry } from "./config";

export interface Storage {
  listConfigs(): Promise<Map<string, ProviderConfig>>;
  getConfig(provider: string): Promise<ProviderConfig | null>;
  putConfig(provider: string, config: ProviderConfig): Promise<void>;
  getKeys(provider: string): Promise<{ apiKeys: string[]; activeKeyIndex: number } | null>;
  putKeys(provider: string, keys: string[], activeKeyIndex: number): Promise<void>;
}

interface ConfigFile {
  [provider: string]: {
    baseUrl: string | Record<string, string>;
    models: (string | { name: string; providerName: string })[];
  };
}

interface KeysFile {
  [provider: string]: {
    apiKeys: string[];
    activeKeyIndex: number;
  };
}

function getXdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`;
}

function getXdgDataHome(): string {
  return process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`;
}

function configPath(): string {
  return `${getXdgConfigHome()}/daedalus/providers.json`;
}

function keysPath(): string {
  return `${getXdgDataHome()}/daedalus/keys.json`;
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = filePath.substring(0, filePath.lastIndexOf("/"));
  await Bun.spawn(["mkdir", "-p", dir]).exited;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(data, null, 2));
  await Bun.spawn(["mv", tmpPath, filePath]).exited;
}

function normalizeModelEntry(entry: string | { name: string; providerName: string }): ProviderModelEntry {
  if (typeof entry === "string") {
    return { name: entry, providerName: entry };
  }
  return { name: entry.name, providerName: entry.providerName };
}

function parseProviderConfig(raw: Record<string, unknown>): ProviderConfig {
  const config = raw as Record<string, unknown>;

  if (!config || typeof config !== "object") {
    throw new Error("Invalid provider config: not an object");
  }

  if (!Array.isArray(config.models)) {
    throw new Error("Invalid provider config: models must be an array");
  }

  const baseUrlIsObject = typeof config.baseUrl === "object" && config.baseUrl !== null && !Array.isArray(config.baseUrl);
  const apiKeysIsObject = typeof config.apiKeys === "object" && config.apiKeys !== null && !Array.isArray(config.apiKeys);

  if (baseUrlIsObject !== apiKeysIsObject) {
    throw new Error("Invalid provider config: baseUrl and apiKeys must both be simple (string/array) or both be objects");
  }

  let baseUrls: string[];
  let apiKeys: string[];

  if (baseUrlIsObject) {
    const baseUrlObj = config.baseUrl as Record<string, string>;
    const apiKeysObj = config.apiKeys as Record<string, string[]>;
    const ids = Object.keys(baseUrlObj).sort();
    baseUrls = ids.map((id) => {
      const url = baseUrlObj[id];
      if (typeof url !== "string" || url.length === 0) {
        throw new Error(`Invalid provider config: baseUrl["${id}"] must be a non-empty string`);
      }
      return url;
    });
    apiKeys = [];
    for (const id of ids) {
      const keys = apiKeysObj[id];
      if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error(`Invalid provider config: apiKeys["${id}"] must be a non-empty array`);
      }
      apiKeys.push(...keys);
    }
  } else {
    if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
      throw new Error("Invalid provider config: baseUrl must be a non-empty string");
    }
    if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
      throw new Error("Invalid provider config: apiKeys must be a non-empty array");
    }
    baseUrls = [config.baseUrl as string];
    apiKeys = config.apiKeys as string[];
  }

  if (baseUrls.length === 0) {
    throw new Error("Invalid provider config: baseUrls must not be empty");
  }
  if (apiKeys.length === 0) {
    throw new Error("Invalid provider config: apiKeys must not be empty");
  }

  const activeKeyIndex =
    typeof config.activeKeyIndex === "number" ? config.activeKeyIndex : 0;

  return {
    apiKeys,
    baseUrls,
    models: config.models.map(normalizeModelEntry),
    activeKeyIndex,
  };
}

export async function createStorage(): Promise<Storage> {
  const configFile = configPath();
  const keysFile = keysPath();

  return {
    async listConfigs(): Promise<Map<string, ProviderConfig>> {
      const configs = new Map<string, ProviderConfig>();
      const configData = await readJson<ConfigFile>(configFile);
      const keysData = await readJson<KeysFile>(keysFile);

      if (!configData) return configs;

      for (const [provider, config] of Object.entries(configData)) {
        const keys = keysData?.[provider] || { apiKeys: [], activeKeyIndex: 0 };
        try {
          const parsed = parseProviderConfig({
            ...config,
            apiKeys: keys.apiKeys,
            activeKeyIndex: keys.activeKeyIndex,
          });
          configs.set(provider, parsed);
        } catch {
        }
      }

      return configs;
    },

    async getConfig(provider: string): Promise<ProviderConfig | null> {
      const configData = await readJson<ConfigFile>(configFile);
      const keysData = await readJson<KeysFile>(keysFile);

      if (!configData || !(provider in configData)) return null;

      const config = configData[provider];
      const keys = keysData?.[provider] || { apiKeys: [], activeKeyIndex: 0 };

      try {
        return parseProviderConfig({
          ...config,
          apiKeys: keys.apiKeys,
          activeKeyIndex: keys.activeKeyIndex,
        });
      } catch {
        return null;
      }
    },

    async putConfig(provider: string, config: ProviderConfig): Promise<void> {
      const configData = (await readJson<ConfigFile>(configFile)) || {};
      const keysData = (await readJson<KeysFile>(keysFile)) || {};

      const existingKeys = keysData[provider] || { apiKeys: config.apiKeys, activeKeyIndex: config.activeKeyIndex };

      let baseUrl: string | Record<string, string>;
      if (config.baseUrls.length === 1) {
        baseUrl = config.baseUrls[0];
      } else {
        baseUrl = Object.fromEntries(config.baseUrls.map((url, i) => [String(i), url]));
      }

      configData[provider] = {
        baseUrl,
        models: config.models.map((m) => (m.name === m.providerName ? m.name : { name: m.name, providerName: m.providerName })),
      };

      keysData[provider] = {
        apiKeys: existingKeys.apiKeys.length > 0 ? existingKeys.apiKeys : config.apiKeys,
        activeKeyIndex: existingKeys.activeKeyIndex,
      };

      await writeJsonAtomic(configFile, configData);
      await writeJsonAtomic(keysFile, keysData);
    },

    async getKeys(provider: string): Promise<{ apiKeys: string[]; activeKeyIndex: number } | null> {
      const keysData = await readJson<KeysFile>(keysFile);
      return keysData?.[provider] || null;
    },

    async putKeys(provider: string, apiKeys: string[], activeKeyIndex: number): Promise<void> {
      const keysData = (await readJson<KeysFile>(keysFile)) || {};
      keysData[provider] = { apiKeys, activeKeyIndex };
      await writeJsonAtomic(keysFile, keysData);
    },
  };
}

export { configPath, keysPath };