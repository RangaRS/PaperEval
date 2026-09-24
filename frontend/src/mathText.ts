/**
 * Rewrite the LaTeX delimiters models use into the ones the Markdown renderer
 * understands: \(...\) becomes $...$, and \[...\] as well as a line holding only
 * $$...$$ become a display block. A `\\[` (a LaTeX line break) is left alone.
 */
export function normalizeMath(text: string): string {
  return text
    .replace(/(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
    .replace(/(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g, (_, math: string) => `$${math.trim()}$`)
    .replace(/^[ \t]*\$\$([^$\n]+?)\$\$[ \t]*$/gm, (_, math: string) => `$$\n${math.trim()}\n$$`)
}
