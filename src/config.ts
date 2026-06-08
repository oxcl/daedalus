import { Storage } from "./storage";

export interface ProviderModelEntry {
  name: string;
  providerName: string;
}

export interface ProviderConfig {
  apiKeys: string[];
  baseUrls: string[];
  models: ProviderModelEntry[];
  activeKeyIndex: number;
}

export interface ModelResolution {
  provider: string;
  providerConfig: ProviderConfig;
  providerModelName: string;
}

function normalizeModelEntry(
  entry: string | { name: string; providerName: string },
): ProviderModelEntry {
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

export async function loadConfigs(
  storage: Storage,
): Promise<Map<string, ProviderConfig>> {
  return storage.listConfigs();
}

export async function updateActiveKeyIndex(
  storage: Storage,
  providerName: string,
  activeKeyIndex: number,
): Promise<void> {
  const config = await storage.getConfig(providerName);
  if (!config) {
    return;
  }
  await storage.putKeys(providerName, config.apiKeys, activeKeyIndex);
}

export interface ModelIndex {
  resolve(modelName: string): ModelResolution;
  resolveAll(modelName: string): ModelResolution[];
}

export function buildModelIndex(
  configs: Map<string, ProviderConfig>,
): ModelIndex {
  const genericIndex = new Map<string, ModelResolution>();
  const prefixedIndex = new Map<string, Map<string, ModelResolution>>();

  for (const [provider, config] of configs) {
    const providerModels = new Map<string, ModelResolution>();

    for (const model of config.models) {
      const resolution: ModelResolution = {
        provider,
        providerConfig: config,
        providerModelName: model.providerName,
      };

      providerModels.set(model.name, resolution);

      if (!genericIndex.has(model.name)) {
        genericIndex.set(model.name, resolution);
      }
    }

    prefixedIndex.set(provider, providerModels);
  }

  return {
    resolve(modelName: string): ModelResolution {
      const atIdx = modelName.indexOf("@");
      if (atIdx !== -1) {
        const provider = modelName.slice(0, atIdx);
        const name = modelName.slice(atIdx + 1);
        const providerModels = prefixedIndex.get(provider);
        if (!providerModels) {
          throw new ModelNotFoundError(modelName);
        }
        const resolution = providerModels.get(name);
        if (!resolution) {
          throw new ModelNotFoundError(modelName);
        }
        return resolution;
      }

      const resolution = genericIndex.get(modelName);
      if (!resolution) {
        throw new ModelNotFoundError(modelName);
      }
      return resolution;
    },

    resolveAll(modelName: string): ModelResolution[] {
      const atIdx = modelName.indexOf("@");
      if (atIdx !== -1) {
        const provider = modelName.slice(0, atIdx);
        const name = modelName.slice(atIdx + 1);
        const providerModels = prefixedIndex.get(provider);
        if (!providerModels) {
          throw new ModelNotFoundError(modelName);
        }
        const resolution = providerModels.get(name);
        if (!resolution) {
          throw new ModelNotFoundError(modelName);
        }
        return [resolution];
      }

      const results: ModelResolution[] = [];
      for (const [, providerModels] of prefixedIndex) {
        const resolution = providerModels.get(modelName);
        if (resolution) {
          results.push(resolution);
        }
      }
      if (results.length === 0) {
        throw new ModelNotFoundError(modelName);
      }
      return results;
    },
  };
}

export class ModelNotFoundError extends Error {
  constructor(modelName: string) {
    super(`Model '${modelName}' not found in any provider`);
    this.name = "ModelNotFoundError";
  }
}