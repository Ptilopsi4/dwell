import { Lexer, type Token, type Tokens } from "marked";

export type TelegramTextFormat = "markdown" | "plain";
export interface TelegramEntity {
	type: "bold" | "italic" | "strikethrough" | "code" | "pre" | "text_link";
	offset: number;
	length: number;
	url?: string;
	language?: string;
}
export interface TelegramText { text: string; entities: TelegramEntity[] }
type Style = Omit<TelegramEntity, "offset" | "length">;
type Context = { styles: Style[]; prefix: string; depth: number; listDepth: number };

const MAX_INPUT = 128 * 1024;
const MAX_TOKENS = 20_000;
const MAX_DEPTH = 32;
const MAX_ENTITIES = 100;
const styleKey = (style: Style): string => `${style.type}:${style.url ?? ""}:${style.language ?? ""}`;
const styleOrder: Style["type"][] = ["bold", "italic", "strikethrough", "text_link", "code", "pre"];
const characterReferences: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function decodeReferences(text: string): string {
	// Marked decodes numeric references in text; links still carry their original references.
	// Keep other named HTML references literal rather than adding an HTML parser to this projection.
	return text.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:\d{1,7}|[xX][\da-fA-F]{1,6});/g, (reference) => {
		if (characterReferences[reference] !== undefined) return characterReferences[reference]!;
		const code = reference[2]!.toLowerCase() === "x" ? Number.parseInt(reference.slice(3, -1), 16) : Number(reference.slice(2, -1));
		return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "�" : String.fromCodePoint(code);
	});
}

function withStyle(styles: Style[], style: Style): Style[] {
	if (styles.some((existing) => existing.type === style.type)) return styles;
	return [...styles, style].sort((a, b) => styleOrder.indexOf(a.type) - styleOrder.indexOf(b.type));
}

function safeLink(value: string): string | undefined {
	if (/[\u0000-\u0020\u007f]/.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) return value;
	} catch { /* Relative links have no useful destination in a chat. */ }
	return undefined;
}

class TextWriter {
	#pieces: string[] = [];
	#length = 0;
	#newlines = 0;
	#open: { style: Style; offset: number }[] = [];
	#entities: TelegramEntity[] = [];
	#put(text: string, styles: Style[]): void {
		if (!text) return;
		let shared = 0;
		while (shared < styles.length && shared < this.#open.length
			&& styleKey(styles[shared]!) === styleKey(this.#open[shared]!.style)) shared++;
		while (this.#open.length > shared) {
			const { style, offset } = this.#open.pop()!;
			if (offset < this.#length) this.#entities.push({ ...style, offset, length: this.#length - offset });
		}
		for (const style of styles.slice(shared)) this.#open.push({ style, offset: this.#length });
		this.#pieces.push(text);
		this.#length += text.length;
		const tail = /\n*$/.exec(text)![0].length;
		this.#newlines = tail === text.length ? this.#newlines + tail : tail;
	}
	append(text: string, styles: Style[] = [], prefix = ""): void {
		if (!prefix) { this.#put(text, styles); return; }
		const lines = text.split(/(?<=\n)/);
		for (const line of lines) {
			if (!line) continue;
			if ((this.#length === 0 || this.#newlines > 0) && line !== "\n") this.#put(prefix, []);
			this.#put(line, styles);
		}
	}
	boundary(lines: number): void {
		if (this.#length && this.#newlines < lines) this.#put("\n".repeat(lines - this.#newlines), []);
	}
	finish(): TelegramText {
		// Closing the stack preserves nesting even when adjacent Markdown spans change order.
		while (this.#open.length) {
			const { style, offset } = this.#open.pop()!;
			if (offset < this.#length) this.#entities.push({ ...style, offset, length: this.#length - offset });
		}
		const text = this.#pieces.join("").replace(/\n+$/, "");
		const entities = this.#entities.map((entity) => ({ ...entity, length: Math.min(entity.length, text.length - entity.offset) }))
			.filter((entity) => entity.length > 0).sort((a, b) => a.offset - b.offset || b.length - a.length);
		return { text, entities };
	}
}

/** Project Markdown into Telegram text and UTF-16 entities without interpreting HTML. */
export function renderTelegramMarkdown(source: string): TelegramText {
	if (source.length > MAX_INPUT) return { text: source, entities: [] };
	try {
		const tokens = new Lexer({ gfm: true, breaks: false, pedantic: false }).lex(source);
		const writer = new TextWriter();
		let visited = 0;
		const render = (tokens: Token[], context: Context, block = false): void => {
			if (context.depth > MAX_DEPTH) throw new Error("Markdown nesting limit");
			for (const token of tokens) {
				if (++visited > MAX_TOKENS) throw new Error("Markdown token limit");
				const child = (children: Token[], styles = context.styles, isBlock = false, prefix = context.prefix, listDepth = context.listDepth) =>
					render(children, { styles, prefix, depth: context.depth + 1, listDepth }, isBlock);
				const append = (text: string, styles = context.styles) => writer.append(text, styles, context.prefix);
				switch (token.type) {
					case "space": case "def": break;
					case "heading":
						child(token.tokens!, withStyle(context.styles, { type: "bold" })); writer.boundary(2); break;
					case "paragraph": child(token.tokens!); writer.boundary(2); break;
					case "text":
						if (token.tokens) child(token.tokens); else append(decodeReferences(token.text));
						if (block) writer.boundary(1);
						break;
					case "escape": append(token.text); break;
					case "html": append(token.raw); if (token.block) writer.boundary(2); break;
					case "strong": case "em": case "del":
						child(token.tokens!, withStyle(context.styles, { type: token.type === "strong" ? "bold" : token.type === "em" ? "italic" : "strikethrough" })); break;
					case "codespan": append(token.text, [{ type: "code" }]); break;
					case "code": {
						const language = token.lang?.split(/\s/)[0];
						append(token.text, [{ type: "pre", ...(language && /^[\w.+#-]{1,64}$/.test(language) ? { language } : {}) }]);
						writer.boundary(2); break;
					}
					case "br": append("\n"); break;
					case "hr": append("────────", []); writer.boundary(2); break;
					case "blockquote":
						// Literal prefixes also support nested quotes and quoted code without forbidden entity nesting.
						child(token.tokens!, context.styles, true, `${context.prefix}› `); writer.boundary(2); break;
					case "list": {
						const list = token as Tokens.List;
						writer.boundary(1);
						for (const [index, item] of list.items.entries()) {
							if (++visited > MAX_TOKENS) throw new Error("Markdown token limit");
							writer.boundary(1);
							append(`${"  ".repeat(context.listDepth)}${list.ordered ? `${Number(list.start) + index}.` : "•"} `, []);
							child(item.tokens, context.styles, true, context.prefix, context.listDepth + 1);
						}
						writer.boundary(2); break;
					}
					case "checkbox": append(token.checked ? "[x] " : "[ ] ", []); break;
					case "link": case "image": {
						const url = safeLink("autolink" in token && token.autolink ? token.href : decodeReferences(token.href));
						const styles = url ? withStyle(context.styles, { type: "text_link", url }) : context.styles;
						if ("autolink" in token && token.autolink) append(token.text, styles);
						else if (token.tokens?.length) child(token.tokens, styles);
						else append(token.text || url || token.raw, styles);
						break;
					}
					case "table": {
						const table = token as Tokens.Table;
						for (const [index, row] of [table.header, ...table.rows].entries()) {
							for (const [column, cell] of row.entries()) {
								if (column) append(" | ", []);
								child(cell.tokens, index === 0 ? withStyle(context.styles, { type: "bold" }) : context.styles);
							}
							writer.boundary(1);
						}
						writer.boundary(2); break;
					}
					default: append(token.raw);
				}
			}
		};
		render(tokens, { styles: [], prefix: "", depth: 0, listDepth: 0 }, true);
		const result = writer.finish();
		return result.text ? result : { text: source, entities: [] };
	} catch {
		// A projection failure must not lose the answer or retain its content in logs.
		return { text: source, entities: [] };
	}
}

/** Split the rendered document, then rebase intersecting entities for each Telegram message. */
export function chunkTelegramText(rendered: TelegramText, limit = 4096): TelegramText[] {
	if (!Number.isSafeInteger(limit) || limit < 2 || limit > 4096) throw new RangeError("Invalid Telegram text limit");
	const chunks: TelegramText[] = [];
	for (let start = 0; start < rendered.text.length;) {
		let end = Math.min(start + limit, rendered.text.length);
		if (end < rendered.text.length && /[\uD800-\uDBFF]/.test(rendered.text[end - 1]!)) end--;
		const entities: TelegramEntity[] = [];
		for (const entity of rendered.entities) {
			if (entity.offset >= end) break;
			const from = Math.max(start, entity.offset);
			const to = Math.min(end, entity.offset + entity.length);
			if (to > from && entities.length < MAX_ENTITIES) entities.push({ ...entity, offset: from - start, length: to - from });
		}
		chunks.push({ text: rendered.text.slice(start, end), entities });
		start = end;
	}
	return chunks;
}

export function formatTelegramText(text: string, format: TelegramTextFormat = "markdown"): TelegramText[] {
	return chunkTelegramText(format === "plain" ? { text, entities: [] } : renderTelegramMarkdown(text));
}
