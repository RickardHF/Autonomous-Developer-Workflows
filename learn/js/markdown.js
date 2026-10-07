// Minimal Markdown renderer tailored to the workshop exercise files.
// Deliberately small and dependency-free: the exercises use a narrow, predictable
// subset of Markdown, and we need custom handling for `- [ ]` task items anyway.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const RE_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_FENCE = /^(\s*)(```|~~~)\s*([\w-]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const RE_ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

// Private-use code points: safe placeholders that cannot appear in the source docs.
const OPEN = '\uE000';
const CLOSE = '\uE001';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]);
const leadingWs = (s) => s.match(/^\s*/)[0].length;

export function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function slugify(s) {
  return (
    s
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 64) || 'section'
  );
}

/**
 * @param {string} src raw markdown
 * @param {{
 *   docId?:string,
 *   optionalTasks?:boolean,
 *   resolveLink?:(href:string, isImage:boolean)=>{href:string,external?:boolean,route?:string}
 * }} options
 * @returns {{html:string, tasks:Array<{id:string,text:string,optional:boolean}>, headings:Array<{level:number,id:string,text:string}>}}
 */
export function renderMarkdown(src, options = {}) {
  const ctx = {
    docId: options.docId || 'doc',
    resolveLink: options.resolveLink || ((href) => ({ href })),
    tasks: [],
    headings: [],
    seq: 0,
    slugs: new Set(),
    detectOptionalTasks: options.optionalTasks !== false,
    optionalLevel: null,
  };
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const html = parseBlocks(lines, ctx);
  return { html, tasks: ctx.tasks, headings: ctx.headings };
}

function parseBlocks(lines, ctx) {
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i++; // closing fence
      const cls = lang ? ` class="language-${esc(lang)}"` : '';
      out.push(`<pre class="md-pre"><code${cls}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = heading[1].length;
      const headingText = heading[2].replace(/[*`_]/g, '').trim();
      if (ctx.detectOptionalTasks && /^optional\b/i.test(headingText)) ctx.optionalLevel = level;
      else if (ctx.optionalLevel != null && level <= ctx.optionalLevel) ctx.optionalLevel = null;
      const inner = inline(heading[2], ctx);
      const base = slugify(heading[2]);
      let id = base;
      let n = 2;
      while (ctx.slugs.has(id)) id = `${base}-${n++}`;
      ctx.slugs.add(id);
      ctx.headings.push({ level, id, text: heading[2].replace(/[*`]/g, '') });
      out.push(`<h${level} id="${id}" class="md-h md-h${level}">${inner}</h${level}>`);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out.push('<hr class="md-hr" />');
      i++;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      let kind = '';
      const alert = body[0] && body[0].match(RE_ALERT);
      if (alert) {
        kind = alert[1].toLowerCase();
        body.shift();
      }
      const cls = kind ? `md-quote md-alert md-alert-${kind}` : 'md-quote';
      const label = kind ? `<p class="md-alert-label">${kind}</p>` : '';
      out.push(`<blockquote class="${cls}">${label}${parseBlocks(body, ctx)}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = parseTable(lines, i, ctx);
      out.push(table.html);
      i = table.next;
      continue;
    }

    if (RE_ITEM.test(line)) {
      const list = parseList(lines, i, ctx);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !RE_HEADING.test(lines[i]) &&
      !RE_HR.test(lines[i]) &&
      !RE_FENCE.test(lines[i]) &&
      !/^\s{0,3}>/.test(lines[i]) &&
      !RE_ITEM.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length) out.push(`<p class="md-p">${inline(para.join('\n'), ctx)}</p>`);
  }

  return out.join('\n');
}

function isTableStart(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head || !sep || !head.includes('|')) return false;
  return sep.includes('-') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(sep);
}

function parseTable(lines, i, ctx) {
  const splitRow = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const headers = splitRow(lines[i]);
  const aligns = splitRow(lines[i + 1]).map((c) => {
    if (/^:.*:$/.test(c)) return 'center';
    if (/:$/.test(c)) return 'right';
    return 'left';
  });
  i += 2;

  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));

  const th = headers
    .map((h, n) => `<th style="text-align:${aligns[n] || 'left'}">${inline(h, ctx)}</th>`)
    .join('');
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c, n) => `<td style="text-align:${aligns[n] || 'left'}">${inline(c, ctx)}</td>`).join('')}</tr>`
    )
    .join('');

  return {
    html: `<div class="md-table-wrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: i,
  };
}

function parseList(lines, i, ctx) {
  const first = lines[i].match(RE_ITEM);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let loose = false;

  while (i < lines.length) {
    // A blank line between two siblings makes the list loose, but does not end it.
    if (!lines[i].trim()) {
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const ahead = j < lines.length ? lines[j].match(RE_ITEM) : null;
      if (!ahead || ahead[1].length !== baseIndent || /\d/.test(ahead[2]) !== ordered) break;
      loose = true;
      i = j;
    }

    const m = lines[i].match(RE_ITEM);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;

    const contentIndent = m[1].length + m[2].length + 1;
    const itemLines = [m[3]];
    i++;
    let sawBlank = false;

    while (i < lines.length) {
      const ln = lines[i];
      if (!ln.trim()) {
        const next = lines[i + 1];
        if (next && next.trim() && leadingWs(next) >= contentIndent) {
          itemLines.push('');
          sawBlank = true;
          i++;
          continue;
        }
        break;
      }
      if (leadingWs(ln) >= contentIndent) {
        itemLines.push(ln.slice(contentIndent));
        i++;
        continue;
      }
      // Lazy continuation of this item's paragraph (the exercises wrap at ~100 cols).
      if (!sawBlank && !RE_ITEM.test(ln) && !RE_HEADING.test(ln) && !RE_FENCE.test(ln) && !/^\s{0,3}>/.test(ln)) {
        itemLines.push(ln.trim());
        i++;
        continue;
      }
      break;
    }

    if (sawBlank) loose = true;
    items.push(itemLines);
  }

  const rendered = items.map((itemLines) => {
    const taskMatch = itemLines[0].match(/^\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
      const body = [taskMatch[2], ...itemLines.slice(1)];
      const text = taskMatch[2].trim();
      const id = `${ctx.docId}:${ctx.seq++}:${hashText(text)}`;
      const optional = ctx.optionalLevel != null;
      ctx.tasks.push({ id, text: text.replace(/[*`_[\]]/g, ''), optional });
      const inner = tighten(parseBlocks(body, ctx), loose);
      return (
        `<li class="md-task${optional ? ' md-task-optional' : ''}" data-task-id="${id}">` +
        `<button type="button" class="task-box" role="checkbox" aria-checked="false">` +
        `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>` +
        `<span class="sr-only">Mark step complete</span></button>` +
        `<div class="task-body">${optional ? '<span class="task-optional-label">Optional</span>' : ''}${inner}</div></li>`
      );
    }
    return `<li class="md-li">${tighten(parseBlocks(itemLines, ctx), loose)}</li>`;
  });

  const hasTasks = rendered.some((r) => r.startsWith('<li class="md-task"'));
  const tag = ordered ? 'ol' : 'ul';
  const cls = hasTasks ? 'md-list md-tasklist' : 'md-list';
  return { html: `<${tag} class="${cls}">${rendered.join('')}</${tag}>`, next: i };
}

// Unwrap a lone paragraph so tight list items don't gain block spacing.
function tighten(html, loose) {
  if (loose) return html;
  const m = html.match(/^<p class="md-p">([\s\S]*)<\/p>$/);
  return m && !m[1].includes('<p class="md-p">') ? m[1] : html;
}

function inline(text, ctx) {
  const stash = [];
  const keep = (html) => `${OPEN}${stash.push(html) - 1}${CLOSE}`;

  // Code spans first, so their contents survive every other rule untouched.
  let out = text.replace(/(`+)([\s\S]*?)\1/g, (_, ticks, code) => keep(`<code class="md-code">${esc(code.trim())}</code>`));

  out = esc(out);

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => {
    const r = ctx.resolveLink(src, true);
    return keep(`<img class="md-img" src="${r.href}" alt="${alt}" loading="lazy" />`);
  });

  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
    const r = ctx.resolveLink(href, false);
    const attrs = r.external ? ' target="_blank" rel="noopener noreferrer"' : '';
    const route = r.route ? ` data-route="${r.route}"` : '';
    return keep(`<a class="md-link" href="${r.href}"${attrs}${route}>${label}</a>`);
  });

  out = out
    // The exercises hard-wrap at ~100 cols. Collapse those breaks first, so that
    // emphasis spanning a wrapped line (`*"show hello in ASCII\n art"*`) still matches.
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>');

  const re = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
  return out.replace(re, (_, n) => stash[Number(n)]);
}
