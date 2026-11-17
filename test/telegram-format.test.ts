import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkTelegramText, formatTelegramText, renderTelegramMarkdown, type TelegramText } from "../src/telegram-format.ts";

function spans(rendered: TelegramText): { type: string; text: string; url?: string; language?: string }[] {
	return rendered.entities.map(({ type, offset, length, url, language }) => ({ type, text: rendered.text.slice(offset, offset + length),
		...(url ? { url } : {}), ...(language ? { language } : {}) }));
}

function validEntities(rendered: TelegramText): void {
	for (const [index, entity] of rendered.entities.entries()) {
		assert.ok(entity.offset >= 0 && entity.length > 0 && entity.offset + entity.length <= rendered.text.length);
		assert.equal(/[\uDC00-\uDFFF]/.test(rendered.text[entity.offset]!), false);
		assert.equal(/[\uD800-\uDBFF]/.test(rendered.text[entity.offset + entity.length - 1]!), false);
		for (const other of rendered.entities.slice(index + 1)) {
			const end = entity.offset + entity.length;
			const otherEnd = other.offset + other.length;
			if (other.offset >= end || entity.offset >= otherEnd) continue;
			assert.ok((entity.offset <= other.offset && end >= otherEnd) || (other.offset <= entity.offset && otherEnd >= end), "entities must nest instead of crossing");
			assert.equal([entity.type, other.type].some((type) => type === "code" || type === "pre"), false, "code entities must be exclusive");
			assert.notEqual(`${entity.type}:${other.type}`, "text_link:text_link");
		}
	}
}

test("Markdown projects headings, nested emphasis, strike, code and links into Telegram entities", () => {
	const rendered = renderTelegramMarkdown('# Report\n\n**bold _italic_** ~~gone~~ `x < y` [site](https://example.com)\n\n```ts\nconst x = "😀";\n```');
	assert.equal(rendered.text, 'Report\n\nbold italic gone x < y site\n\nconst x = "😀";');
	assert.deepEqual(spans(rendered), [
		{ type: "bold", text: "Report" }, { type: "bold", text: "bold italic" }, { type: "italic", text: "italic" },
		{ type: "strikethrough", text: "gone" }, { type: "code", text: "x < y" },
		{ type: "text_link", text: "site", url: "https://example.com" }, { type: "pre", text: 'const x = "😀";', language: "ts" },
	]);
	validEntities(rendered);
});

test("code is exclusive inside headings, emphasis and links, and adjacent nested styles never cross", () => {
	const rendered = renderTelegramMarkdown('# **a `code` b**\n\n[**x `code` y**](https://example.com) **a *b*** *c **d***');
	validEntities(rendered);
	assert.deepEqual(spans(rendered).filter((span) => span.type === "code"), [{ type: "code", text: "code" }, { type: "code", text: "code" }]);
	assert.ok(spans(rendered).some((span) => span.type === "text_link" && span.text === "x "));
	assert.ok(spans(rendered).some((span) => span.type === "text_link" && span.text === " y"));
});

test("the reported trailing-asterisk case uses Markdown bold while preserving the remaining literal star", () => {
	assert.deepEqual(renderTelegramMarkdown("**11***"), { text: "11*", entities: [{ type: "bold", offset: 0, length: 2 }] });
});

test("character references decode once in text and links while HTML and code remain literal", () => {
	const rendered = renderTelegramMarkdown('&#42; &amp; &lt; &gt; &quot; &apos; &#128512; &#38;amp; &copy;\n\n`&amp; &#42;`\n\n<b>&amp; &#42;</b>\n\n<div>&amp; &#42;</div>\n\n[x](https://example.com?a=1&amp;b=2&#38;c=3)');
	assert.equal(rendered.text, '* & < > " \' 😀 &amp; &copy;\n\n&amp; &#42;\n\n<b>& *</b>\n\n<div>&amp; &#42;</div>\n\nx');
	assert.deepEqual(spans(rendered), [{ type: "code", text: "&amp; &#42;" }, { type: "text_link", text: "x", url: "https://example.com?a=1&b=2&c=3" }]);
	assert.deepEqual(renderTelegramMarkdown('\\&amp; &#38;#42;'), { text: '&amp; &#42;', entities: [] });
	assert.deepEqual(spans(renderTelegramMarkdown('<https://example.com?a=1&amp;b=2>')), [{ type: "text_link", text: "https://example.com?a=1&amp;b=2", url: "https://example.com?a=1&amp;b=2" }]);
	validEntities(rendered);
});

test("GFM lists, task lists, quotes and tables retain a readable text layout", () => {
	const rendered = renderTelegramMarkdown('> **quote**\n>\n> - one\n>   - nested\n\n- [x] done\n- [ ] next\n\n3. three\n4. four\n\n| a | b |\n|---|---|\n| c | d |');
	assert.equal(rendered.text, '› quote\n\n› • one\n›   • nested\n\n• [x] done\n• [ ] next\n\n3. three\n4. four\n\na | b\nc | d');
	assert.deepEqual(spans(rendered), [{ type: "bold", text: "quote" }, { type: "bold", text: "a" }, { type: "bold", text: "b" }]);
	validEntities(rendered);
});

test("HTML stays literal, escapes lose only Markdown quoting, and images become links without fetching", () => {
	const rendered = renderTelegramMarkdown('\\*literal\\* <b>raw</b>\n\n<script>unsafe()</script>\n\n![diagram](https://example.com/diagram.png) ![private](file:///private/image.png)');
	assert.equal(rendered.text, '*literal* <b>raw</b>\n\n<script>unsafe()</script>\n\ndiagram private');
	assert.deepEqual(spans(rendered), [{ type: "text_link", text: "diagram", url: "https://example.com/diagram.png" }]);
});

test("only approved URL schemes receive link entities, including reference links and autolinks", () => {
	const rendered = renderTelegramMarkdown('[web][site] [email](mailto:a@example.com) [phone](tel:+123) [bad](javascript:alert(1)) [mention](tg://user?id=1) [relative](/admin) <https://example.org>\n\n[site]: https://example.com');
	assert.equal(rendered.text, 'web email phone bad mention relative https://example.org');
	assert.deepEqual(spans(rendered).map((span) => span.url), ['https://example.com', 'mailto:a@example.com', 'tel:+123', 'https://example.org']);
	validEntities(rendered);
});

test("Unicode entity offsets and lengths use Telegram UTF-16 units", () => {
	const rendered = renderTelegramMarkdown('😀 **汉字😀é** [链接](https://example.com)');
	assert.equal(rendered.text, '😀 汉字😀é 链接');
	assert.deepEqual(rendered.entities, [{ type: "bold", offset: 3, length: 6 }, { type: "text_link", url: "https://example.com", offset: 10, length: 2 }]);
	validEntities(rendered);
});

test("the complete Markdown document is rendered before chunking and entities are rebased", () => {
	const source = `**${"x".repeat(4095)}😀${"y".repeat(4096)}**`;
	const rendered = renderTelegramMarkdown(source);
	const chunks = formatTelegramText(source);
	assert.equal(chunks.length, 3);
	assert.equal(chunks.map((chunk) => chunk.text).join(""), rendered.text);
	assert.equal(rendered.text.includes("**"), false);
	assert.deepEqual(chunks.map((chunk) => chunk.entities), chunks.map((chunk) => [{ type: "bold", offset: 0, length: chunk.text.length }]));
	for (const chunk of chunks) { assert.ok(chunk.text.length <= 4096); validEntities(chunk); }
});

test("long code blocks retain valid pre entities and language on every chunk", () => {
	const code = `const a = "${"😀".repeat(5000)}";\nconst b = 1;`;
	const chunks = formatTelegramText(`\`\`\`javascript\n${code}\n\`\`\``);
	assert.ok(chunks.length > 2);
	assert.equal(chunks.map((chunk) => chunk.text).join(""), code);
	for (const chunk of chunks) {
		assert.deepEqual(chunk.entities, [{ type: "pre", language: "javascript", offset: 0, length: chunk.text.length }]);
		validEntities(chunk);
	}
});

test("quoted code and nested quotes stay readable without incompatible quote entities", () => {
	const rendered = renderTelegramMarkdown('> outer\n>\n> > inner **bold**\n>\n> ```js\n> a()\n> b()\n> ```');
	assert.equal(rendered.text, '› outer\n\n› › inner bold\n\n› a()\n› b()');
	assert.equal(spans(rendered).filter((span) => span.type === "pre").map((span) => span.text).join(""), 'a()\nb()');
	validEntities(rendered);
});

test("oversized documents and excessive nesting fall back to the complete original text", () => {
	for (const source of [`**${"x".repeat(128 * 1024)}**`, `${"> ".repeat(40)}deep`]) {
		assert.deepEqual(renderTelegramMarkdown(source), { text: source, entities: [] });
		assert.equal(formatTelegramText(source).map((chunk) => chunk.text).join(""), source);
	}
});

test("entity-dense messages preserve all text while bounding Telegram entity counts", () => {
	const source = Array.from({ length: 150 }, (_, index) => `**${index}**`).join(" ");
	const chunks = formatTelegramText(source);
	assert.equal(chunks.map((chunk) => chunk.text).join(""), Array.from({ length: 150 }, (_, index) => index).join(" "));
	assert.equal(chunks[0]!.entities.length, 100);
	validEntities(chunks[0]!);
});

test("explicit plain mode preserves machine text and chunk limits reject invalid values", () => {
	assert.deepEqual(formatTelegramText('**literal**\n<raw>\n', "plain"), [{ text: '**literal**\n<raw>\n', entities: [] }]);
	assert.deepEqual(chunkTelegramText({ text: "😀😀", entities: [] }, 3).map((chunk) => chunk.text), ["😀", "😀"]);
	assert.throws(() => chunkTelegramText({ text: "x", entities: [] }, 1), RangeError);
});
