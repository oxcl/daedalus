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
        baseUrl: "https://api.test.com/v1",
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
        baseUrl: "https://api.test.com/v1",
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
        baseUrl: "https://api.test.com/v1",
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
        baseUrl: "https://api.test.com/v1",
        models: [],
        activeKeyIndex: 0,
      },
    });

    const configs = await loadConfigs(storage);
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
