import DOMPurify from "dompurify"
import { marked } from "marked"

marked.setOptions({ gfm: true, breaks: true })

/**
 * Renders markdown to sanitized HTML for use with {@html}. Unsafe markup is stripped, never rendered.
 */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text ?? "", { async: false })
	return DOMPurify.sanitize(html)
}
