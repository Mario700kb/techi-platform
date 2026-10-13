import { Fragment, ReactNode } from "react";

// The Markdown that client documentation pages need — headings, lists and
// checklists, tables, code, quotes, links — rendered straight to React
// elements. Text is never parsed as HTML, so a page cannot inject markup or
// script; links open only http(s) and mailto targets.

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (match[2]) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), key)}</em>);
    } else if (match[4]) {
      const [, label, url] = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) ?? [];
      nodes.push(
        SAFE_URL.test(url ?? "") ? (
          <a key={key} href={url} target="_blank" rel="noopener noreferrer">
            {inline(label ?? "", key)}
          </a>
        ) : (
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else {
      nodes.push(
        <a key={key} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

export default function MarkdownView({ source, className = "" }: { source: string; className?: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const next = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) code.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={next()}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const k = next();
      const content = inline(heading[2], k);
      blocks.push(
        heading[1].length === 1 ? (
          <h2 key={k}>{content}</h2>
        ) : heading[1].length === 2 ? (
          <h3 key={k}>{content}</h3>
        ) : (
          <h4 key={k}>{content}</h4>
        ),
      );
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={next()} />);
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quote.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      const k = next();
      blocks.push(<blockquote key={k}>{inline(quote.join(" "), k)}</blockquote>);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const k = next();
      blocks.push(
        <div key={k} className="th-md-table">
          <table>
            <thead>
              <tr>
                {head.map((cell, c) => (
                  <th key={c}>{inline(cell, `${k}h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {head.map((_, c) => (
                    <td key={c}>{inline(row[c] ?? "", `${k}r${r}c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_ITEM);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(m[2]);
        i += 1;
      }
      const k = next();
      const children = items.map((text, n) => {
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        return task ? (
          <li key={n} className="th-md-task">
            <input type="checkbox" checked={task[1] !== " "} readOnly disabled aria-label={task[2]} />
            <span>{inline(task[2], `${k}-${n}`)}</span>
          </li>
        ) : (
          <li key={n}>{inline(text, `${k}-${n}`)}</li>
        );
      });
      blocks.push(ordered ? <ol key={k}>{children}</ol> : <ul key={k}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !LIST_ITEM.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].trimStart().startsWith(">")
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    const k = next();
    blocks.push(
      <p key={k}>
        {paragraph.map((text, n) => (
          <Fragment key={n}>
            {n > 0 && <br />}
            {inline(text, `${k}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className={`th-md ${className}`}>{blocks}</div>;
}
