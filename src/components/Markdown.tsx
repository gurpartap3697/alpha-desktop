import { memo, useMemo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { marked } from "marked";
import { openUrl } from "@tauri-apps/plugin-opener";
import "katex/dist/katex.min.css";
import { CopyButton } from "./CopyButton";

// Model output is untrusted, so raw HTML is never rendered (no rehype-raw). Without this plugin
// react-markdown silently drops it, which hides text like "use the <div> tag"; show it literally
// instead, except <br>, which models use inside table cells.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}
function remarkHtmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === "html") {
      node.type = /^<br\s*\/?>$/i.test(node.value?.trim() ?? "") ? "break" : "text";
    }
    node.children?.forEach(walk);
  };
  return walk;
}

/** Models often write LaTeX as \[...\] and \(...\); remark-math only knows $$ and $. Code is left alone. */
export function normalizeMath(src: string): string {
  return src
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m: string) => `$${m.trim()}$`),
    )
    .join("");
}

/** Top-level markdown blocks, so finished blocks can skip re-rendering while the tail streams. */
function splitBlocks(src: string): string[] {
  const blocks: string[] = [];
  for (const token of marked.lexer(src, { gfm: true })) {
    if (token.type === "space" && blocks.length) blocks[blocks.length - 1] += token.raw;
    else blocks.push(token.raw);
  }
  return blocks;
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}
const hastText = (n: HastNode | undefined): string =>
  !n ? "" : n.type === "text" ? (n.value ?? "") : (n.children ?? []).map(hastText).join("");

const isWebUrl = (href: string | undefined) => !!href && /^https?:\/\//i.test(href);

/** Never navigates the app window; web links open in the system browser. */
function WebLink({ href, children }: { href?: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && isWebUrl(href)) void openUrl(href);
      }}
    >
      {children}
    </a>
  );
}

const components: Components = {
  pre({ node, children }) {
    const code = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "code");
    const classes = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
    const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
    return (
      <div className="code-block">
        <div className="flex h-8 items-center justify-between pl-4 pr-1.5 text-xs text-ink-3">
          <span>{lang}</span>
          <CopyButton text={hastText(code).replace(/\n$/, "")} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  a: ({ href, children }) => <WebLink href={href}>{children}</WebLink>,
  // Remote images are blocked by the CSP (and could leak data); show them as links.
  img: ({ src, alt }) => {
    const href = typeof src === "string" ? src : undefined;
    return <WebLink href={href}>{alt || href || "image"}</WebLink>;
  },
  table({ children }) {
    return (
      <div className="table-scroll">
        <table>{children}</table>
      </div>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkMath, remarkHtmlAsText];
const rehypePlugins = [rehypeKatex, rehypeHighlight];

const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const src = useMemo(() => normalizeMath(text), [text]);
  const blocks = useMemo(() => (streaming ? splitBlocks(src) : [src]), [src, streaming]);
  return (
    <div className={streaming ? "answer streaming" : "answer"}>
      {blocks.map((b, i) => (
        <Block key={i} text={b} />
      ))}
    </div>
  );
}
