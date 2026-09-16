import { requestUrl, type RequestUrlParam } from "obsidian";
import type { PluginSettings, OllamaResponse, OpenAIResponse, ChatMessage } from "../types";
import { tf } from "../i18n/index";

/** 统一的 POST JSON 请求，连接失败时给出可操作的提示。 */
async function postJson(init: RequestUrlParam): Promise<unknown> {
	try {
		const res = await requestUrl(init);
		return res.json;
	} catch (err) {
		const detail = (err as Error)?.message || String(err);
		throw new Error(tf("无法连接 {url}，请确认服务已启动、接口地址与 API Key 正确", { url: init.url }) + (detail ? "（" + detail + "）" : ""));
	}
}

export interface ChatLLMOptions {
	system?: string;
	/** base64 编码的图片数组（不含 data URL 前缀），用于多模态视觉识别 */
	images?: string[];
}

export interface OllamaChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OllamaChatResponse {
	message?: { content?: string };
}

export async function chatLLM(cfg: PluginSettings, prompt: string, opts?: ChatLLMOptions): Promise<string> {
	const images = opts?.images || [];
	if (cfg.apiType === "ollama") {
		const url = cfg.baseUrl + "/api/generate";
		const body: Record<string, unknown> = { model: cfg.modelName, prompt, stream: false, temperature: cfg.temperature };
		if (images.length > 0) body.images = images;
		const data = await postJson({
			url,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(body),
		}) as OllamaResponse;
		return data.response || "";
	}
	const url = cfg.baseUrl + "/v1/chat/completions";
	const messages: unknown[] = [];
	if (opts?.system) messages.push({ role: "system", content: opts.system });
	if (images.length > 0) {
		messages.push({
			role: "user",
			content: [
				{ type: "text", text: prompt },
				...images.map(b64 => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } })),
			],
		});
	} else {
		messages.push({ role: "user", content: prompt });
	}
	const data = await postJson({
		url,
		method: "POST",
		contentType: "application/json",
		headers: { "Authorization": "Bearer " + cfg.apiKey },
		body: JSON.stringify({
			model: cfg.modelName,
			temperature: cfg.temperature,
			stream: false,
			messages,
		}),
	}) as OpenAIResponse;
	return data.choices?.[0]?.message?.content || "";
}

/**
 * 多轮对话调用：OpenAI 兼容走 /v1/chat/completions（含历史），Ollama 走 /api/chat。
 * messages 为按时间顺序的完整对话历史（不含 system，system 通过 opts.system 传入）。
 */
export async function chatMessage(
	cfg: PluginSettings,
	messages: ChatMessage[],
	opts?: ChatLLMOptions,
): Promise<string> {
	const history = messages.map(m => ({ role: m.role, content: m.content }));
	if (cfg.apiType === "ollama") {
		const url = cfg.baseUrl + "/api/chat";
		const msgs: OllamaChatMessage[] = [];
		if (opts?.system) msgs.push({ role: "system", content: opts.system });
		msgs.push(...(history as OllamaChatMessage[]));
		const data = await postJson({
			url,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ model: cfg.modelName, messages: msgs, stream: false, temperature: cfg.temperature }),
		}) as OllamaChatResponse;
		return data.message?.content || "";
	}
	const messagesArr: unknown[] = [];
	if (opts?.system) messagesArr.push({ role: "system", content: opts.system });
	messagesArr.push(...history);
	const data = await postJson({
		url: cfg.baseUrl + "/v1/chat/completions",
		method: "POST",
		contentType: "application/json",
		headers: { "Authorization": "Bearer " + cfg.apiKey },
		body: JSON.stringify({
			model: cfg.modelName,
			temperature: cfg.temperature,
			stream: false,
			messages: messagesArr,
		}),
	}) as OpenAIResponse;
	return data.choices?.[0]?.message?.content || "";
}
