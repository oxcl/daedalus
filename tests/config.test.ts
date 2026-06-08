import { describe, it, expect } from "vitest";
import {
  loadConfigs,
  buildModelIndex,
  ModelNotFoundError,
  ProviderConfig,
} from "../src/config";
import { Storage } from "../src/storage";

function mockStorage(
  entries?: Record<string, ProviderConfig>
): Storage {
  const configs = new Map<string, ProviderConfig>(
    entries ? Object.entries(entries) : []
  );

  return {
    async listConfigs() {
      return new Map(configs);
    },
    async getConfig(provider: string) {
      return configs.get(provider) || null;
    },
    async putConfig(provider: string, config: ProviderConfig) {
      configs.set(provider, config);
    },
    async getKeys() {
      return null;
    },
    async putKeys() {},
  };
}

function mockStorageWithRaw(
  entries?: Record<string, Record<string, unknown>>
): Storage {
  const configs = new Map<string, ProviderConfig>();
  if (entries) {
    for (const [provider, raw] of Object.entries(entries)) {
      try {
        const parsed = parseProviderConfigRaw(raw);
        configs.set(provider, parsed);
      } catch {
      }
    }
  }

  return {
    async listConfigs() {
      return new Map(configs);
    },
    async getConfig(provider: string) {
      return configs.get(provider) || null;
    },
    async putConfig(provider: string, config: ProviderConfig) {
      configs.set(provider, config);
    },
    async getKeys() {
      return null;
    },
    async putKeys() {},
  };
}

function parseProviderConfigRaw(raw: Record<string, unknown>): ProviderConfig {
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

  const activeKeyIndex =
    typeof config.activeKeyIndex === "number" ? config.activeKeyIndex : 0;

  return {
    apiKeys,
    baseUrls,
    models: (config.models as (string | { name: string; providerName: string })[]).map((entry) => {
      if (typeof entry === "string") {
        return { name: entry, providerName: entry };
      }
      return { name: entry.name, providerName: entry.providerName };
    }),
    activeKeyIndex,
  };
}

const openaiConfig: ProviderConfig = {
  apiKeys: ["sk-openai-1", "sk-openai-2"],
  baseUrls: ["https://api.openai.com/v1"],
  models: [
    { name: "gpt-4o", providerName: "gpt-4o" },
    { name: "o1", providerName: "o1-2024-12-17" },
  ],
  activeKeyIndex: 0,
};

const deepseekConfig: ProviderConfig = {
  apiKeys: ["sk-ds-1"],
  baseUrls: ["https://api.deepseek.com/v1"],
  models: [
    { name: "deepseek-chat", providerName: "deepseek-chat" },
    { name: "o1", providerName: "deepseek-o1" },
  ],
  activeKeyIndex: 0,
};

describe("loadConfigs", () => {
  it("reads all provider entries from storage", async () => {
    const storage = mockStorage({
      openai: openaiConfig,
      deepseek: deepseekConfig,
    });

    const configs = await loadConfigs(storage);
    expect(configs.size).toBe(2);
    expect(configs.has("openai")).toBe(true);
    expect(configs.has("deepseek")).toBe(true);
  });

  it("returns empty map when no providers exist", async () => {
    const storage = mockStorage();
    const configs = await loadConfigs(storage);
    expect(configs.size).toBe(0);
  });
});

describe("parseProviderConfig", () => {
  it("normalizes string model entries", async () => {
    const storage = mockStorage({
      test: {
        apiKeys: ["key1"],
        baseUrls: ["https://api.test.com/v1"],
        models: [
          { name: "model-a", providerName: "model-a" },
          { name: "model-b", providerName: "model-b" },
        ],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "model-a", providerName: "model-a" },
      { name: "model-b", providerName: "model-b" },
    ]);
  });

  it("normalizes object model entries", async () => {
    const storage = mockStorage({
      test: {
        apiKeys: ["key1"],
        baseUrls: ["https://api.test.com/v1"],
        models: [{ name: "gpt-4o", providerName: "gpt-4o-2024-08-06" }],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "gpt-4o", providerName: "gpt-4o-2024-08-06" },
    ]);
  });

  it("handles mixed string and object model entries", async () => {
    const storage = mockStorage({
      test: {
        apiKeys: ["key1"],
        baseUrls: ["https://api.test.com/v1"],
        models: [
          { name: "gpt-4o", providerName: "gpt-4o" },
          { name: "o1", providerName: "o1-2024-12-17" },
          { name: "deepseek-chat", providerName: "deepseek-chat" },
        ],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "gpt-4o", providerName: "gpt-4o" },
      { name: "o1", providerName: "o1-2024-12-17" },
      { name: "deepseek-chat", providerName: "deepseek-chat" },
    ]);
  });

  it("defaults activeKeyIndex to 0 when missing", async () => {
    const storage = mockStorage({
      test: {
        apiKeys: ["key1"],
        baseUrls: ["https://api.test.com/v1"],
        models: [],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.activeKeyIndex).toBe(0);
  });

  it("parses object-format baseUrl and apiKeys", async () => {
    const storage = mockStorageWithRaw({
      test: {
        apiKeys: { a: ["key-a1"], b: ["key-b1", "key-b2"] },
        baseUrl: { a: "https://a.example.com/v1", b: "https://b.example.com/v1" },
        models: ["model-1"],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.baseUrls).toEqual(["https://a.example.com/v1", "https://b.example.com/v1"]);
    expect(config.apiKeys).toEqual(["key-a1", "key-b1", "key-b2"]);
    expect(config.models).toEqual([{ name: "model-1", providerName: "model-1" }]);
  });

  it("sorts object-format baseUrl and apiKeys by key", async () => {
    const storage = mockStorageWithRaw({
      test: {
        apiKeys: { z: ["key-z"], a: ["key-a"] },
        baseUrl: { z: "https://z.example.com/v1", a: "https://a.example.com/v1" },
        models: ["model-1"],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    const config = configs.get("test")!;
    expect(config.baseUrls).toEqual(["https://a.example.com/v1", "https://z.example.com/v1"]);
    expect(config.apiKeys).toEqual(["key-a", "key-z"]);
  });

  it("rejects mismatched baseUrl and apiKeys formats", async () => {
    const storage = mockStorageWithRaw({
      test: {
        apiKeys: ["key1"],
        baseUrl: { a: "https://a.example.com/v1" },
        models: ["model-1"],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
    expect(configs.has("test")).toBe(false);
  });
});

describe("buildModelIndex", () => {
  it("builds index from multiple providers", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);

    const index = buildModelIndex(configs);

    const resolution = index.resolve("gpt-4o");
    expect(resolution.provider).toBe("openai");
    expect(resolution.providerModelName).toBe("gpt-4o");
  });

  it("returns first provider for duplicate generic names", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);

    const index = buildModelIndex(configs);

    const resolution = index.resolve("o1");
    expect(resolution.provider).toBe("openai");
    expect(resolution.providerModelName).toBe("o1-2024-12-17");
  });

  it("supports prefixed model resolution", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);

    const index = buildModelIndex(configs);

    const resolution = index.resolve("deepseek@o1");
    expect(resolution.provider).toBe("deepseek");
    expect(resolution.providerModelName).toBe("deepseek-o1");
  });

  it("prefixed resolution uses exact provider match", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);

    const index = buildModelIndex(configs);

    const resolution = index.resolve("openai@o1");
    expect(resolution.provider).toBe("openai");
    expect(resolution.providerModelName).toBe("o1-2024-12-17");
  });

  it("throws ModelNotFoundError for unknown model", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(() => index.resolve("nonexistent")).toThrow(ModelNotFoundError);
    expect(() => index.resolve("nonexistent")).toThrow(
      "Model 'nonexistent' not found in any provider",
    );
  });

  it("throws ModelNotFoundError for unknown prefixed model", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(() => index.resolve("openai@nonexistent")).toThrow(ModelNotFoundError);
  });

  it("throws ModelNotFoundError for unknown provider prefix", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(() => index.resolve("unknown@gpt-4o")).toThrow(ModelNotFoundError);
  });

  it("returns provider config reference in resolution", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    const resolution = index.resolve("gpt-4o");
    expect(resolution.providerConfig).toBe(openaiConfig);
  });

  it("resolveAll returns all providers for a generic model", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);
    const index = buildModelIndex(configs);

    const resolutions = index.resolveAll("o1");
    expect(resolutions).toHaveLength(2);
    expect(resolutions[0].provider).toBe("openai");
    expect(resolutions[1].provider).toBe("deepseek");
  });

  it("resolveAll returns single provider for unique model", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);
    const index = buildModelIndex(configs);

    const resolutions = index.resolveAll("gpt-4o");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].provider).toBe("openai");
  });

  it("resolveAll returns single resolution for prefixed model", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);
    const index = buildModelIndex(configs);

    const resolutions = index.resolveAll("openai@o1");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].provider).toBe("openai");
    expect(resolutions[0].providerModelName).toBe("o1-2024-12-17");
  });

  it("resolveAll throws ModelNotFoundError for unknown model", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(() => index.resolveAll("nonexistent")).toThrow(ModelNotFoundError);
  });

  it("resolveAll throws ModelNotFoundError for unknown provider prefix", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(() => index.resolveAll("unknown@gpt-4o")).toThrow(ModelNotFoundError);
  });
});

describe("model resolution integration", () => {
  it("resolves across multiple providers with mixed formats", () => {
    const configs = new Map([
      ["openai", openaiConfig],
      ["deepseek", deepseekConfig],
    ]);

    const index = buildModelIndex(configs);

    expect(index.resolve("gpt-4o").provider).toBe("openai");
    expect(index.resolve("deepseek-chat").provider).toBe("deepseek");
    expect(index.resolve("openai@o1").provider).toBe("openai");
    expect(index.resolve("deepseek@o1").provider).toBe("deepseek");
    expect(index.resolve("o1").provider).toBe("openai");
  });

  it("first configured provider wins for duplicate generic names", () => {
    const configs = new Map([
      ["deepseek", deepseekConfig],
      ["openai", openaiConfig],
    ]);

    const index = buildModelIndex(configs);

    const resolution = index.resolve("o1");
    expect(resolution.provider).toBe("deepseek");
    expect(resolution.providerModelName).toBe("deepseek-o1");
  });

  it("handles single provider", () => {
    const configs = new Map([["openai", openaiConfig]]);
    const index = buildModelIndex(configs);

    expect(index.resolve("gpt-4o").provider).toBe("openai");
    expect(index.resolve("o1").provider).toBe("openai");
  });
});
