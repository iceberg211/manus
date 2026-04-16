/**
 * LLM Factory — 统一模型实例化，使用 LangChain 的 initChatModel。
 *
 * initChatModel 是 LangChain 的原生统一工厂，内置支持 20+ provider：
 * OpenAI, Anthropic, Azure, Google, Bedrock, Ollama, Groq, Mistral,
 * DeepSeek, xAI, Cerebras, Fireworks, Together AI, Perplexity, Cohere...
 *
 * 新模型名立即可用——不需要更新代码，provider 包按需安装即可。
 *
 * 用法:
 *   import { createLLM } from "./config/llmFactory.js";
 *   const model = await createLLM();           // config.llm.default
 *   const model = await createLLM("manus");    // config.llm.manus
 */
import { initChatModel } from "langchain/chat_models/universal";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { getConfig, type LLMSettings } from "./index.js";
import { logger } from "../utils/logger.js";

/**
 * 根据 config 创建 LLM 实例。
 *
 * @param configName — 对应 config.toml 中 [llm.xxx] 段名。默认 "default"。
 */
export async function createLLM(configName?: string): Promise<BaseChatModel> {
  const config = getConfig();
  const settings = config.llm[configName ?? "default"] ?? config.llm.default;

  if (!settings) {
    throw new Error(`LLM config '${configName}' not found and no default available`);
  }

  logger.debug({ apiType: settings.api_type, model: settings.model, configName }, "Creating LLM");

  // initChatModel 支持 "provider:model" 格式自动路由
  // 也支持 modelProvider 参数显式指定
  const modelProvider = mapApiTypeToProvider(settings.api_type);
  const modelName = settings.model;

  const model = await initChatModel(modelName, {
    modelProvider,
    temperature: settings.temperature,
    maxTokens: settings.max_tokens,
    // provider-specific 字段透传
    ...(settings.api_key ? { apiKey: settings.api_key } : {}),
    ...(settings.base_url ? { baseURL: settings.base_url, configuration: { baseURL: settings.base_url } } : {}),
    ...(settings.api_version ? { apiVersion: settings.api_version } : {}),
  });

  return model as unknown as BaseChatModel;
}

/**
 * 将 config.toml 中的 api_type 映射到 initChatModel 的 modelProvider。
 *
 * initChatModel 的 provider 名见 MODEL_PROVIDER_CONFIG:
 * openai, anthropic, azure_openai, google, google-genai, google-vertexai,
 * ollama, bedrock, bedrock_converse, groq, mistralai, deepseek, xai, ...
 */
function mapApiTypeToProvider(apiType: string): string | undefined {
  const map: Record<string, string> = {
    openai: "openai",
    azure: "azure_openai",
    anthropic: "anthropic",
    bedrock: "bedrock_converse",
    google: "google-genai",
    ollama: "ollama",
    groq: "groq",
    mistral: "mistralai",
    deepseek: "deepseek",
  };
  const type = (apiType || "openai").toLowerCase();
  return map[type] ?? type; // 未知类型直接透传，initChatModel 会尝试匹配
}
