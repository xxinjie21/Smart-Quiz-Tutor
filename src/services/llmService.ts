import { requestUrl } from "obsidian";
import type { PluginSettings, OllamaResponse, OpenAIResponse } from "../types";

export async function chatLLM(cfg: PluginSettings, prompt: string, opts?: { system?: string }): Promise<string> {
	if (cfg.apiType === "ollama") {
		const url = cfg.baseUrl + "/api/generate";
		const res = await requestUrl({
			url,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ model: cfg.modelName, prompt, stream: false, temperature: cfg.temperature }),
		});
		const data = res.json as OllamaResponse;
		return data.response || "";
	}
	const url = cfg.baseUrl + "/v1/chat/completions";
	const res = await requestUrl({
		url,
		method: "POST",
		contentType: "application/json",
		headers: { "Authorization": "Bearer " + cfg.apiKey },
		body: JSON.stringify({
			model: cfg.modelName,
			temperature: cfg.temperature,
			stream: false,
			messages: [
				{ role: "system", content: opts?.system || "你是专业的试卷识别助手，严格按照指定格式输出题目。" },
				{ role: "user", content: prompt }
			]
		}),
	});
	const data = res.json as OpenAIResponse;
	return data.choices?.[0]?.message?.content || "";
}
