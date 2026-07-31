import { MAX_EXTRACTED_TAGS, SYSTEM_TAGS } from "../constants";

const STOP_WORDS = new Set(["答案", "解析", "题目", "试题", "题干", "选项", "标准", "参考", "正确", "错误", "以上", "以下", "关于", "下列", "其中", "不正确", "正确的是", "错误的是", "单选题", "多选题", "判断题", "填空题", "简答题", "不属于", "以下哪", "下列哪", "对于", "能够", "使用", "以下哪个", "下列哪个", "不是", "属于", "属于以下", "正确答案", "错误答案", "以下说法", "下列说法", "功能", "描述", "实现", "包含", "具有", "通过", "进行", "一个", "多个", "所有", "每个", "可以", "应该", "需要", "已经", "没有", "不能", "将会", "以下关于", "下列关于", "关于以下", "说法正确", "说法错误", "正确的是", "错误的是"]);
const EN_STOP = new Set(["the", "this", "that", "with", "from", "will", "into", "each", "have", "has", "are", "was", "for", "not", "but", "can", "may", "its", "any", "all", "use", "used", "also", "via", "per", "our", "how", "when", "where", "what", "which", "does", "than", "then", "type", "true", "false", "null", "none", "other", "more", "most", "very", "such", "only", "just", "after", "before", "between", "under", "over"]);
const CN_STOP = new Set(["的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些", "什么", "为", "所", "以", "及", "或", "等", "之", "把", "被", "让", "给", "对", "从", "由", "但", "而", "且", "如果", "虽然", "因为", "所以", "这个", "那个", "这些", "那些", "如何", "怎样", "哪个", "哪些", "则", "后", "前", "内", "外", "中", "下", "间", "时", "年", "月", "日", "号", "个", "种", "次", "第", "该", "其", "此", "若", "当", "于", "作为", "已", "又", "只", "并", "即", "还", "仍", "却", "才", "非", "无", "未", "莫", "勿", "需", "可", "能", "会", "得", "做", "出", "来", "去", "过", "进", "开", "关", "用", "试", "问", "答", "记", "写", "读", "删", "增", "改", "查", "找", "看", "听", "说", "想", "知", "觉", "感", "受", "让", "叫", "请", "求", "许", "准", "禁", "止", "必", "须", "应", "该", "不", "没", "未", "曾", "已", "正", "在", "将", "要", "想", "愿", "肯", "敢", "能", "可", "许", "准", "予", "给", "与", "向", "往", "朝", "距", "离", "到", "至", "从", "自", "由", "经", "过", "通", "过", "凭", "借", "依", "靠", "按", "照", "据", "根", "据", "依", "照", "遵", "循", "顺", "沿", "随", "同", "跟", "和", "与", "及", "或", "还", "又", "也", "均", "都", "全", "总", "共", "计", "合", "共", "一", "共", "凡", "各", "每", "某", "有", "些", "任", "何", "所", "有", "全", "部", "整", "个", "一", "切", "凡", "是", "但", "凡", "只", "要", "一", "旦", "如", "若", "倘", "如", "假", "使", "既", "然", "虽", "然", "尽", "管", "无", "论", "不", "管", "哪", "怕", "即", "使", "哪", "怕", "再", "也", "不", "如", "果", "不", "然", "要", "不", "然", "否", "则", "或", "者", "还", "是", "不", "是", "有", "没", "有", "能", "不", "能", "可", "不", "可", "行", "不", "行", "对", "不", "对", "好", "不", "好", "是", "不", "是", "做", "不", "做", "用", "不", "用", "要", "不", "要"]);

export function extractKnowledgeTags(sourceName: string, questionText: string): string[] {
	const tagCount = new Map<string, number>();

	const nameClean = sourceName.replace(/\[\[|\]\]/g, "").replace(/_错题_\d{4}-\d{2}-\d{2}.*$/, "").replace(/_试题_\d{4}-\d{2}-\d{2}.*$/, "").replace(/\.md$/, "");
	const segments = nameClean.split(/[_\-\s·/\\]+/).filter(s => s.length >= 2);
	const CH_NUM = /^(第[一二三四五六七八九十百千\d]+[章节篇讲部]|[一二三四五六七八九十]+[、.])$/;
	const GENERIC = /^(概述|简介|总结|复习|练习|测试|模拟|真题|期[中末]|考[试查]|作业|课[堂程]|笔记|大纲|目录|附录|参考文献|前言|绪论|引言|摘要|附[录表]|appendix|introduction|summary|overview|review|practice|test|exam|homework|quiz|final|midterm|lecture|course|note|outline|index|appendix|reference|abstract|preface|foreword|body|content|chapter|section|part|volume|book|text|read|material|resource|document|file|doc|txt|pdf|docx|ppt|pptx|xls|xlsx|csv|zip|rar|7z|tar|gz)$/i;
	for (const seg of segments) {
		const s = seg.replace(/[0-9]/g, "").trim();
		if (s.length < 2) continue;
		if (CH_NUM.test(seg) || CH_NUM.test(s)) continue;
		if (GENERIC.test(s)) continue;
		tagCount.set(s, (tagCount.get(s) || 0) + 5);
	}

	const fullText = sourceName + " " + questionText;

	const enPat = /\b[A-Za-z][A-Za-z0-9]{1,30}\b/g;
	let m;
	while ((m = enPat.exec(fullText)) !== null) {
		const term = m[0];
		const lower = term.toLowerCase();
		if (EN_STOP.has(lower)) continue;
		if (SYSTEM_TAGS.includes(lower)) continue;
		if (/^\d+$/.test(term)) continue;
		tagCount.set(term, (tagCount.get(term) || 0) + 1);
	}

	const cnPat = /[\u4e00-\u9fa5]{2,8}/g;
	while ((m = cnPat.exec(fullText)) !== null) {
		const term = m[0];
		if (term.length < 2) continue;
		if (CN_STOP.has(term)) continue;
		if (SYSTEM_TAGS.includes(term)) continue;
		if (STOP_WORDS.has(term)) continue;
		if (/^(答案|解析|题目|试题|题干|选项|标准|参考|正确|错误|以上|以下|关于|下列|其中|不正确|单选|多选|判断|填空|简答)$/.test(term)) continue;
		if (/^第[一二三四五六七八九十百千\d]+$/.test(term)) continue;
		if (/^(下列|以下|关于|对于|通过|使用|实现|包含|具有|功能|描述|进行|属于|能够|可以|需要|已经|没有|不能|将会|以下关于|下列关于|以下说法|下列说法|说法正确|说法错误|正确的是|错误的是|正确答案|不正确|不属于|以下哪|下列哪|以下哪个|下列哪个)$/.test(term)) continue;
		tagCount.set(term, (tagCount.get(term) || 0) + 1);
	}

	const sorted = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);
	return sorted.slice(0, MAX_EXTRACTED_TAGS).map(e => e[0]);
}
