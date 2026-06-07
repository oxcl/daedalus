export interface ProviderModelEntry {
  name: string;
  providerName: string;
}

export interface ProviderConfig {
  apiKeys: string[];
  baseUrl: string;
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

function parseProviderConfig(raw: unknown): ProviderConfig {
  const config = raw as Record<string, unknown>;

  if (!config || typeof config !== "object") {
    throw new Error("Invalid provider config: not an object");
  }

  if (!Array.isArray(config.apiKeys) || config.apiKeys.length === 0) {
    throw new Error("Invalid provider config: apiKeys must be a non-empty array");
  }

  if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
    throw new Error("Invalid provider config: baseUrl must be a non-empty string");
  }

  if (!Array.isArray(config.models)) {
    throw new Error("Invalid provider config: models must be an array");
  }

  const activeKeyIndex =
    typeof config.activeKeyIndex === "number" ? config.activeKeyIndex : 0;

  return {
    apiKeys: config.apiKeys as string[],
    baseUrl: config.baseUrl as string,
    models: config.models.map(normalizeModelEntry),
    activeKeyIndex,
  };
}

export async function loadConfigs(
  kv: KVNamespace,
): Promise<Map<string, ProviderConfig>> {
  const configs = new Map<string, ProviderConfig>();
  const list = await kv.list({ prefix: "provider:" });

  for (const key of list.keys) {
    const providerName = key.name.replace(/^provider:/, "");
    const raw = await kv.get(key.name, "json");
    if (raw) {
      try {
        configs.set(providerName, parseProviderConfig(raw));
      } catch {
        // skip invalid configs
      }
    }
  }

  return configs;
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
