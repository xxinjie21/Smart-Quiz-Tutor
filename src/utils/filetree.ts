import type { TFile } from "obsidian";
import type { TreeNode } from "../types";

export function buildFileTree(files: TFile[]): TreeNode {
	const root: TreeNode = { name: "", path: "", isFolder: true, children: [] };
	for (const file of files) {
		const parts = file.path.split("/");
		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			let child = current.children.find(c => c.isFolder && c.name === parts[i]);
			if (!child) {
				child = { name: parts[i] || "", path: parts.slice(0, i + 1).join("/"), isFolder: true, children: [] };
				current.children.push(child);
			}
			current = child;
		}
		const fileName = parts[parts.length - 1] || "";
		current.children.push({ name: fileName, path: file.path, isFolder: false, file, children: [] });
	}
	return root;
}
