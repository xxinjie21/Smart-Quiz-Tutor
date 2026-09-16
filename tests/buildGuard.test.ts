import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const mainJsPath = fileURLToPath(new URL("../main.js", import.meta.url));
const code = readFileSync(mainJsPath, "utf8");

describe("build output guardrails", () => {
	it("does not call eval()", () => {
		expect(code).not.toMatch(/\beval\s*\(/);
	});

	it("does not inject <script> elements via createElement", () => {
		expect(code).not.toMatch(/createElement\(\s*["']script["']\s*\)/);
	});

	it("does not contain a raw <script> tag string", () => {
		expect(code).not.toMatch(/<script[\s>]/i);
	});
});
