import { requestUrl } from "obsidian";
import type { PluginSettings, OllamaResponse, OpenAIResponse } from "../types";

export interface ChatLLMOptions {
	system?: string;
	/** base64 编码的图片数组（不含 data URL 前缀），用于多模态视觉识别 */
	images?: string[];
}

export async function chatLLM(cfg: PluginSettings, prompt: string, opts?: ChatLLMOptions): Promise<string> {
	const images = opts?.images || [];
	if (cfg.apiType === "ollama") {
		const url = cfg.baseUrl + "/api/generate";
		const body: Record<string, unknown> = { model: cfg.modelName, prompt, stream: false, temperature: cfg.temperature };
		if (images.length > 0) body.images = images;
		const res = await requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify(body),
		});
		const data = res.json as OllamaResponse;
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
	const res = await requestUrl({
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
	});
	const data = res.json as OpenAIResponse;
	return data.choices?.[0]?.message?.content || "";
}
