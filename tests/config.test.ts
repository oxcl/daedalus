import { describe, it, expect } from "vitest";
import {
  loadConfigs,
  buildModelIndex,
  ModelNotFoundError,
  ProviderConfig,
} from "../src/config";

function mockKV(
  entries: Record<string, unknown>,
): KVNamespace {
  const keys = Object.keys(entries).map((name) => ({ name, list: undefined as never }));
  return {
    list: async ({ prefix }: { prefix: string }) => ({
      keys: keys.filter((k) => k.name.startsWith(prefix)),
      list_complete: true,
      cacheStatus: null,
    }),
    get: async (key: string, type?: string) => {
      if (!(key in entries)) return null;
      const val = entries[key];
      if (type === "json") return val;
      return JSON.stringify(val);
    },
  } as unknown as KVNamespace;
}

const openaiConfig: ProviderConfig = {
  apiKeys: ["sk-openai-1", "sk-openai-2"],
  baseUrl: "https://api.openai.com/v1",
  models: [
    { name: "gpt-4o", providerName: "gpt-4o" },
    { name: "o1", providerName: "o1-2024-12-17" },
  ],
  activeKeyIndex: 0,
};

const deepseekConfig: ProviderConfig = {
  apiKeys: ["sk-ds-1"],
  baseUrl: "https://api.deepseek.com/v1",
  models: [
    { name: "deepseek-chat", providerName: "deepseek-chat" },
    { name: "o1", providerName: "deepseek-o1" },
  ],
  activeKeyIndex: 0,
};

describe("loadConfigs", () => {
  it("reads all provider:* entries from KV", async () => {
    const kv = mockKV({
      "provider:openai": openaiConfig,
      "provider:deepseek": deepseekConfig,
    });

    const configs = await loadConfigs(kv);
    expect(configs.size).toBe(2);
    expect(configs.has("openai")).toBe(true);
    expect(configs.has("deepseek")).toBe(true);
  });

  it("returns empty map when no providers exist", async () => {
    const kv = mockKV({});
    const configs = await loadConfigs(kv);
    expect(configs.size).toBe(0);
  });

  it("skips entries with invalid config", async () => {
    const kv = mockKV({
      "provider:openai": openaiConfig,
      "provider:bad": { not: "valid" },
    });

    const configs = await loadConfigs(kv);
    expect(configs.size).toBe(1);
    expect(configs.has("openai")).toBe(true);
  });
});

describe("parseProviderConfig", () => {
  it("normalizes string model entries", async () => {
    const kv = mockKV({
      "provider:test": {
        apiKeys: ["key1"],
        baseUrl: "https://api.test.com/v1",
        models: ["model-a", "model-b"],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(kv);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "model-a", providerName: "model-a" },
      { name: "model-b", providerName: "model-b" },
    ]);
  });

  it("normalizes object model entries", async () => {
    const kv = mockKV({
      "provider:test": {
        apiKeys: ["key1"],
        baseUrl: "https://api.test.com/v1",
        models: [{ name: "gpt-4o", providerName: "gpt-4o-2024-08-06" }],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(kv);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "gpt-4o", providerName: "gpt-4o-2024-08-06" },
    ]);
  });

  it("handles mixed string and object model entries", async () => {
    const kv = mockKV({
      "provider:test": {
        apiKeys: ["key1"],
        baseUrl: "https://api.test.com/v1",
        models: [
          "gpt-4o",
          { name: "o1", providerName: "o1-2024-12-17" },
          "deepseek-chat",
        ],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(kv);
    const config = configs.get("test")!;
    expect(config.models).toEqual([
      { name: "gpt-4o", providerName: "gpt-4o" },
      { name: "o1", providerName: "o1-2024-12-17" },
      { name: "deepseek-chat", providerName: "deepseek-chat" },
    ]);
  });

  it("defaults activeKeyIndex to 0 when missing", async () => {
    const kv = mockKV({
      "provider:test": {
        apiKeys: ["key1"],
        baseUrl: "https://api.test.com/v1",
        models: [],
      },
    });

    const configs = await loadConfigs(kv);
    const config = configs.get("test")!;
    expect(config.activeKeyIndex).toBe(0);
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
