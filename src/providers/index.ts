import { MockProvider } from "./mock.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import type { ModelProvider } from "./types.js";

export const PROVIDERS = ["mock", "anthropic", "openai"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function createProvider(name: string | undefined): ModelProvider {
  const key = name ?? "mock";
  if (!isProviderName(key)) throw new Error(`Unknown provider "${key}". Use one of: ${PROVIDERS.join(", ")}.`);
  switch (key) {
    case "anthropic":
      return new AnthropicProvider();
    case "openai":
      return new OpenAIProvider();
    case "mock":
      return new MockProvider();
  }
}
