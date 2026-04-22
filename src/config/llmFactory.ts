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
 *   import { createLLM } from "@/config/llmFactory";
 *   const model = await createLLM();           // config.llm.default
 *   const model = await createLLM("manus");    // config.llm.manus
 */
import { initChatModel } from "langchain/chat_models/universal";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ensureConfigLoaded } from "@/config/index";
import { logger } from "@/utils/logger";

/**
 * 根据 config 创建 LLM 实例。
 *
 * @param configName — 对应 config.toml 中 [llm.xxx] 段名。默认 "default"。
 */
export async function createLLM(configName?: string): Promise<BaseChatModel> {
  const config = await ensureConfigLoaded();
  const settings = config.llm[configName ?? "default"] ?? config.llm.default;

  if (!settings) {
    throw new Error(`LLM config '${configName}' not found and no default available`);
  }

  logger.debug({ apiType: settings.api_type, model: settings.model, configName }, "Creating LLM");

  // 使用 LangChain 原生的 "provider:model" 约定，让 provider 路由由 LangChain 处理。
  // 对于千问这类 OpenAI 兼容接口，api_type=openai，model=qwen-plus 即可。
  const modelName = resolveModelIdentifier(settings.api_type, settings.model);

  const model = await initChatModel(modelName, {
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
 * 组合 LangChain 原生的 "provider:model" 标识。
 *
 * 约定：
 * - 如果 model 已经带 provider 前缀，直接透传
 * - 否则当 api_type 存在时，拼成 "api_type:model"
 * - 千问 / 其他 OpenAI 兼容接口：api_type=openai
 */
function resolveModelIdentifier(apiType: string, model: string): string {
  if (model.includes(":")) return model;
  const provider = apiType.trim();
  return provider ? `${provider}:${model}` : model;
}
