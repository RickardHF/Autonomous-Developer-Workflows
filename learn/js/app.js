import { renderMarkdown } from './markdown.js';
import { store } from './store.js';
import { celebrate } from './confetti.js';
import { el } from './dom.js';
import { openBadgeDialog } from './badge.js';

const app = document.getElementById('app');
const WORDS_PER_MIN = 210;

let manifest = null;
/** @type {Map<string, object>} document id -> loaded doc */
const docs = new Map();
/** Flat, ordered list of every exercise across tracks. */
let flat = [];

// ---------------------------------------------------------------- content

function contentUrl(path) {
  return (manifest.contentRoot || '../') + path.split('/').map(encodeURIComponent).join('/');
}

/** Turn a relative link inside a loaded document into either an in-app route or an outward link. */
function makeResolver(entry) {
  const slash = entry.file.lastIndexOf('/');
  const dir = slash === -1 ? '' : entry.file.slice(0, slash);
  return (href, isImage) => {
    if (/^(https?:|mailto:|#)/.test(href)) return { href, external: /^https?:/.test(href) };

    // Normalise the link against the exercise's own directory.
    const relativePath = href.startsWith('/') ? href.slice(1) : [dir, href].filter(Boolean).join('/');
    const parts = relativePath.split('/');
    const stack = [];
    for (const part of parts) {
      if (part === '.' || part === '') continue;
      if (part === '..') stack.pop();
      else stack.push(part);
    }
    const repoPath = stack.join('/');

    if (isImage) return { href: contentUrl(repoPath) };

    const target = flat.find((e) => e.file === repoPath);
    if (target) return { href: `#/e/${target.id}`, route: target.id };
    return { href: contentUrl(repoPath), external: true };
  };
}

function deriveTitle(raw) {
  const h1 = raw.match(/^#\s+(.+)$/m);
  const text = h1 ? h1[1].trim() : 'Untitled';
  // "Exercise 1 — Build a Skill 🧩" / "Task 1 : Creating an Agentic Workflow"
  const stripped = text.replace(/^(exercise|task)\s+\d+\s*[—:-]\s*/i, '').trim();
  const emoji = stripped.match(/\s([\p{Extended_Pictographic}]+)$/u);
  return {
    title: emoji ? stripped.slice(0, emoji.index).trim() : stripped,
    emoji: emoji ? emoji[1] : '',
  };
}

function deriveSummary(raw) {
  const quote = raw.match(/^>\s*\*\*Goal:\*\*\s*([\s\S]*?)(?:\n\s*\n|\n(?!\s*>))/mi);
  if (quote) return quote[1].replace(/\n\s*>?\s*/g, ' ').trim();
  const para = raw
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('|') && !l.startsWith('!'));
  return para ? para.trim().replace(/[*`]/g, '').slice(0, 180) : '';
}

function extractSection(raw, section) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const headingText = (line) => {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    return match ? match[1].replace(/[*`]/g, '').trim().toLowerCase() : null;
  };
  const from = section.from.toLowerCase();
  const until = section.until?.toLowerCase();
  const start = lines.findIndex((line) => headingText(line) === from);
  if (start === -1) throw new Error(`Section "${section.from}" not found`);
  const baseLevel = lines[start].match(/^#+/)[0].length;

  let end = lines.length;
  if (until) {
    const relativeEnd = lines.slice(start + 1).findIndex((line) => headingText(line) === until);
    if (relativeEnd !== -1) end = start + 1 + relativeEnd;
  }
  return lines
    .slice(start + 1, end)
    .map((line) => {
      const heading = line.match(/^(#{1,6})(\s+.*)$/);
      if (!heading || heading[1].length <= baseLevel) return line;
      return `${'#'.repeat(heading[1].length - baseLevel + 1)}${heading[2]}`;
    })
    .join('\n')
    .trim();
}

async function loadDocument(entry) {
  const res = await fetch(contentUrl(entry.file));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const source = await res.text();
  const raw = entry.section ? extractSection(source, entry.section) : source;
  const renderedSource = entry.image ? raw.replace(/^!\[[^\]]*\]\([^)\n]+\)\s*$/m, '') : raw;
  const derived = deriveTitle(raw);
  const rendered = renderMarkdown(renderedSource, {
    docId: entry.id,
    resolveLink: makeResolver(entry),
    optionalTasks: entry.id !== manifest.setup?.id,
  });
  const words = raw.split(/\s+/).length;

  const doc = {
    ...entry,
    raw,
    title: entry.title || derived.title,
    emoji: entry.emoji || derived.emoji,
    summary: entry.tagline || deriveSummary(raw),
    html: rendered.html,
    tasks: rendered.tasks,
    headings: rendered.headings.filter((h) => h.level === 2 || (entry.section && h.level === 3)),
    minutes: Math.max(5, Math.round(words / WORDS_PER_MIN + rendered.tasks.length * 1.5)),
  };
  docs.set(entry.id, doc);
  return doc;
}

// ---------------------------------------------------------------- progress

function progressOf(id) {
  const doc = docs.get(id);
  if (!doc) {
    return {
      done: 0,
      total: 0,
      unitsDone: 0,
      unitsTotal: 0,
      optionalDone: 0,
      optionalTotal: 0,
      pct: 0,
      complete: false,
      skipped: false,
    };
  }

  const required = doc.tasks.filter((task) => !task.optional);
  const optional = doc.tasks.filter((task) => task.optional);
  const done = store.completed(id, required.map((task) => task.id));
  const optionalDone = store.completed(id, optional.map((task) => task.id));
  const isSetup = manifest?.setup?.id === id;
  const manuallyComplete = !isSetup && required.length === 0 && store.isModuleComplete(id);
  const complete = required.length > 0 ? done === required.length : manuallyComplete;

  return {
    done,
    total: required.length,
    unitsDone: required.length > 0 ? done : Number(complete),
    unitsTotal: required.length > 0 ? required.length : isSetup ? 0 : 1,
    optionalDone,
    optionalTotal: optional.length,
    pct: required.length > 0 ? done / required.length : complete ? 1 : 0,
    complete,
    skipped: !isSetup && !complete && store.isSkipped(id),
  };
}

function trackProgress(track) {
  let done = 0;
  let total = 0;
  let skipped = 0;
  for (const ex of track.exercises) {
    const p = progressOf(ex.id);
    done += p.unitsDone;
    total += p.unitsTotal;
    if (p.skipped) skipped++;
  }
  return {
    done,
    total,
    skipped,
    pct: total ? done / total : 0,
    complete: track.exercises.length > 0 && track.exercises.every((ex) => progressOf(ex.id).complete),
  };
}

/** Offered once every module in a workshop is complete. */
function badgeButton(track) {
  return el(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => openBadgeDialog({ track, moduleCount: track.exercises.length }),
    },
    'Get your badge'
  );
}

function setupIsComplete() {
  return !manifest.setup || progressOf(manifest.setup.id).complete;
}

/**
 * The first not-yet-finished exercise in a track — the one we nudge toward.
 * Exercises stay self-paced once the repository setup prerequisite is complete.
 */
function nextUpId(track) {
  const pending = track.exercises.find((ex) => {
    const progress = progressOf(ex.id);
    return !progress.complete && !progress.skipped;
  });
  return pending ? pending.id : null;
}

function taskSummary(doc) {
  const required = doc.tasks.filter((task) => !task.optional).length;
  const optional = doc.tasks.length - required;
  if (required === 0 && optional === 0) return 'No checklist steps';
  if (required === 0) return `${optional} optional ${optional === 1 ? 'step' : 'steps'}`;
  if (optional === 0) return `${required} required ${required === 1 ? 'step' : 'steps'}`;
  return `${required} required · ${optional} optional`;
}

function moduleProgressLabel(progress) {
  if (progress.total === 0) {
    if (progress.complete) return 'Module complete';
    return progress.optionalTotal > 0 ? 'No required steps' : 'Ready to complete';
  }
  return `${progress.done} of ${progress.total} required ${progress.total === 1 ? 'step' : 'steps'}`;
}

// ---------------------------------------------------------------- elements

function ring(pct, size = 76, stroke = 6) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const kind of ['ring-track', 'ring-fill']) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('class', kind);
    circle.setAttribute('cx', size / 2);
    circle.setAttribute('cy', size / 2);
    circle.setAttribute('r', r);
    circle.setAttribute('stroke-width', stroke);
    if (kind === 'ring-fill') {
      circle.setAttribute('stroke-dasharray', c);
      circle.setAttribute('stroke-dashoffset', c * (1 - pct));
    }
    svg.append(circle);
  }
  return svg;
}

const icon = (paths, cls = 'icon') =>
  el('span', { class: cls, html: `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>` });

const ICONS = {
  check: '<path d="M4 12.5l5 5L20 6.5" />',
  back: '<path d="M15 5l-7 7 7 7" />',
  sun: '<circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" />',
  progress: '<path d="M4 7h7M4 12h11M4 17h16" />',
};

// ---------------------------------------------------------------- chrome

function themeToggle() {
  const cycle = { auto: 'light', light: 'dark', dark: 'auto' };
  const btn = el('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Switch theme',
    onclick: () => {
      store.theme = cycle[store.theme] || 'auto';
      applyTheme();
      paint(btn);
    },
  });
  const paint = (b) => {
    b.innerHTML = '';
    const t = store.theme;
    b.append(icon(t === 'dark' ? ICONS.moon : ICONS.sun));
    b.append(el('span', { class: 'icon-btn-label' }, t === 'auto' ? 'Auto' : t === 'dark' ? 'Dark' : 'Light'));
    b.setAttribute('aria-label', `Theme: ${t}. Click to change.`);
  };
  paint(btn);
  return btn;
}

function applyTheme() {
  const t = store.theme;
  document.documentElement.dataset.theme = t === 'auto' ? '' : t;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#131110' : '#fbf9f4');
}

function progressMenu() {
  const menu = el('div', { class: 'menu' });
  const btn = el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      'aria-label': 'Progress options',
    },
    icon(ICONS.progress),
    el('span', { class: 'icon-btn-label' }, 'Progress')
  );
  const list = el('div', { class: 'menu-list', hidden: true });

  const close = () => {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    list.hidden = !list.hidden;
    btn.setAttribute('aria-expanded', String(!list.hidden));
  });
  document.addEventListener('click', close);

  list.append(
    el(
      'button',
      {
        type: 'button',
        onclick: () => {
          const blob = new Blob([store.export()], { type: 'application/json' });
          const a = el('a', { href: URL.createObjectURL(blob), download: 'workshop-progress.json' });
          a.click();
          URL.revokeObjectURL(a.href);
          close();
        },
      },
      'Export progress'
    ),
    el(
      'button',
      {
        type: 'button',
        onclick: () => {
          const input = el('input', { type: 'file', accept: 'application/json' });
          input.addEventListener('change', async () => {
            try {
              store.import(await input.files[0].text());
              render();
            } catch (err) {
              alert(`Could not import that file: ${err.message}`);
            }
          });
          input.click();
          close();
        },
      },
      'Import progress'
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'danger',
        onclick: () => {
          if (confirm('Reset all progress on this device? This cannot be undone.')) {
            store.reset();
            applyTheme();
            history.replaceState(null, '', '#/');
            render();
          }
          close();
        },
      },
      'Reset progress'
    )
  );

  menu.append(btn, list);
  return menu;
}

function header() {
  const overall = flat.reduce(
    (acc, ex) => {
      const p = progressOf(ex.id);
      acc.done += p.unitsDone;
      acc.total += p.unitsTotal;
      return acc;
    },
    { done: 0, total: 0 }
  );
  const pct = overall.total ? Math.round((overall.done / overall.total) * 100) : 0;

  return el(
    'header',
    { class: 'topbar' },
    el(
      'a',
      { class: 'brand', href: '#/', 'aria-label': `${manifest.title} by Eficode — home` },
      el('img', {
        class: 'brand-logo',
        src: 'assets/eficode-logo.png',
        alt: '',
        width: '42',
        height: '32',
      }),
      el('span', { class: 'brand-text' }, manifest.title)
    ),
    el(
      'div',
      { class: 'topbar-progress', title: `${overall.done} of ${overall.total} required progress items complete` },
      el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${pct}%` })),
      el('span', { class: 'bar-label' }, `${pct}%`)
    ),
    el('div', { class: 'topbar-actions' }, themeToggle(), progressMenu())
  );
}
// ---------------------------------------------------------------- hub view

function learningNode({
  href,
  eyebrow,
  title,
  tagline,
  accent,
  progress,
  mark,
  action,
  unitLabel = 'required items',
  locked = false,
  root = false,
}) {
  const pct = Math.round(progress.pct * 100);
  const state = locked ? 'locked' : progress.complete ? 'complete' : progress.done > 0 ? 'active' : 'ready';
  const attrs = {
    class: `node learning-node node-${state} accent-${accent}${root ? ' learning-node-root' : ''}`,
    'aria-label': locked
      ? `${title}: locked until repository setup is complete`
      : `${title}: ${progress.done} of ${progress.total} ${unitLabel} complete`,
  };
  if (locked) {
    attrs.role = 'link';
    attrs['aria-disabled'] = 'true';
  } else {
    attrs.href = href;
  }

  const disc = el('span', { class: 'node-disc' });
  disc.append(
    ring(progress.pct, 96, 7),
    el('span', { class: 'learning-node-mark', 'aria-hidden': 'true' }, mark)
  );
  if (progress.complete) disc.append(icon(ICONS.check, 'node-badge'));
  else if (locked) disc.append(icon(ICONS.lock, 'node-lock'));

  return el(
    locked ? 'div' : 'a',
    attrs,
    disc,
    el(
      'span',
      { class: 'node-meta' },
      el(
        'span',
        { class: 'node-step' },
        eyebrow,
        el('span', { class: `node-pill${locked ? ' node-pill-locked' : ''}` }, action)
      ),
      el('span', { class: 'node-title' }, title),
      el('span', { class: 'learning-node-tagline' }, tagline),
      el('span', { class: 'node-sub' }, `${progress.done}/${progress.total} ${unitLabel} · ${pct}%`)
    )
  );
}

function treeConnector(unlocked) {
  return el('div', {
    class: `tree-connector ${unlocked ? 'is-unlocked' : 'is-locked'}`,
    'aria-hidden': 'true',
    html:
      '<svg class="tree-svg" preserveAspectRatio="none">' +
      '<path class="tree-path tree-trunk" />' +
      '<path class="tree-path tree-path-left" />' +
      '<path class="tree-path tree-path-right" />' +
      '<circle class="tree-junction" r="5" />' +
      '</svg>',
  });
}

function trackSection(track) {
  const tp = trackProgress(track);
  const section = el('section', { class: `track accent-${track.accent}` });

  section.append(
    el(
      'div',
      { class: 'track-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, 'Workshop'),
        el('h1', { class: 'track-title' }, track.title),
        el('p', { class: 'track-tagline' }, track.tagline)
      ),
      el(
        'div',
        { class: 'track-stat' },
        el('span', { class: 'track-pct' }, `${Math.round(tp.pct * 100)}%`),
        el('span', { class: 'track-count' }, `${tp.done}/${tp.total} required items`)
      )
    )
  );

  const upNext = nextUpId(track);
  const path = el('div', { class: 'path' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'path-line');
  svg.setAttribute('aria-hidden', 'true');
  path.append(svg);

  track.exercises.forEach((ex, index) => {
    const doc = docs.get(ex.id);
    const p = progressOf(ex.id);
    const isNext = ex.id === upNext;
    const state = p.complete ? 'complete' : p.skipped ? 'skipped' : p.done > 0 ? 'active' : 'ready';
    const offset = [0, 1, 0, -1, 0, 1, -1][index % 7];

    const node = el('a', {
      class: `node node-${state}`,
      href: `#/e/${ex.id}`,
      style: `--offset:${offset}`,
      'data-node': ex.id,
    });
    if (isNext) node.classList.add('node-next');

    const disc = el('span', { class: 'node-disc' });
    disc.append(ring(p.pct, 96, 7));
    if (ex.image) {
      disc.append(
        el('img', {
          class: 'node-img',
          src: `assets/img/${ex.image}-thumb.jpg`,
          alt: '',
          loading: 'lazy',
        })
      );
    } else {
      disc.append(el('span', { class: 'node-emoji' }, doc && doc.emoji ? doc.emoji : String(index + 1)));
    }
    if (p.complete) disc.append(icon(ICONS.check, 'node-badge'));

    node.append(
      disc,
      el(
        'span',
        { class: 'node-meta' },
        el(
          'span',
          { class: 'node-step' },
          `${track.title} · ${index + 1}`,
          p.skipped
            ? el('span', { class: 'node-pill node-pill-skipped' }, 'Resume')
            : isNext && el('span', { class: 'node-pill' }, p.done > 0 ? 'Continue' : 'Start here')
        ),
        el('span', { class: 'node-title' }, doc ? doc.title : 'Loading…'),
        doc && el('span', { class: 'node-sub' }, `${taskSummary(doc)} · ~${doc.minutes} min`)
      )
    );

    path.append(node);
  });

  section.append(path);
  requestAnimationFrame(() => drawPath(path, svg));
  return section;
}

function hubView() {
  const view = el('main', { class: 'view hub' });
  const flow = el('section', { class: 'learning-flow', 'aria-labelledby': 'learning-path-title' });
  const unlocked = setupIsComplete();
  const map = el('div', { class: `learning-map ${unlocked ? 'is-unlocked' : 'is-locked'}` });
  const branches = el('div', { class: 'learning-branches', 'aria-label': 'Workshops' });

  if (manifest.setup && docs.has(manifest.setup.id)) {
    const setupProgress = progressOf(manifest.setup.id);
    const setupNode = learningNode({
      href: '#/setup',
      eyebrow: manifest.setup.name,
      title: manifest.setup.title,
      tagline: manifest.setup.tagline,
      accent: manifest.setup.accent,
      progress: setupProgress,
      mark: 'PRE',
      action: setupProgress.complete ? 'Complete' : setupProgress.done > 0 ? 'Continue' : 'Start here',
      unitLabel: 'setup steps',
      root: true,
    });
    map.append(treeConnector(unlocked), el('div', { class: 'learning-root' }, setupNode));
  }

  manifest.tracks.forEach((track, index) => {
    const progress = trackProgress(track);
    branches.append(
      learningNode({
        href: `#/workshop/${track.id}`,
        eyebrow: 'Workshop',
        title: track.title,
        tagline: track.tagline,
        accent: track.accent,
        progress,
        mark: String(index + 1).padStart(2, '0'),
        action: !unlocked ? 'Setup required' : progress.complete ? 'Review' : progress.done > 0 ? 'Continue' : 'Explore',
        locked: !unlocked,
      })
    );
  });
  map.append(branches);

  view.prepend(
    el(
      'section',
      { class: 'hero' },
      el('h1', { class: 'hero-title' }, manifest.title),
      el('p', { class: 'hero-byline' }, 'by Eficode'),
      el('p', { class: 'hero-sub' }, manifest.subtitle)
    )
  );
  flow.append(
    el(
      'div',
      { class: 'learning-flow-head' },
      el('p', { class: 'eyebrow' }, unlocked ? 'Setup complete' : 'Start here'),
      el('h2', { class: 'module-section-title', id: 'learning-path-title' }, 'Your learning path'),
      el(
        'p',
        { class: 'learning-flow-sub' },
        unlocked ? 'Choose either workshop and move at your own pace.' : 'Complete repository setup to unlock both workshops.'
      )
    ),
    map
  );
  view.append(flow);
  return view;
}

function workshopView(id) {
  const track = manifest.tracks.find((candidate) => candidate.id === id);
  if (!track) return el('main', { class: 'view' }, el('p', { class: 'empty' }, 'Workshop not found.'));

  const view = el('main', { class: `view hub workshop-view accent-${track.accent}` });
  view.append(
    el('a', { class: 'back workshop-back', href: '#/' }, icon(ICONS.back), 'All modules'),
    trackSection(track)
  );

  if (trackProgress(track).complete) {
    view.append(
      el(
        'div',
        { class: 'handoff workshop-complete' },
        el('p', { class: 'handoff-kicker' }, 'Workshop complete'),
        el('h2', {}, `${track.title} is done.`),
        el(
          'p',
          { class: 'handoff-sub' },
          `All ${track.exercises.length} modules complete. Take a badge with you.`
        ),
        el(
          'div',
          { class: 'handoff-actions' },
          badgeButton(track),
          el('a', { class: 'btn btn-secondary', href: '#/' }, 'All modules')
        )
      )
    );
  }
  return view;
}

/** Draw the connecting curve behind a track's nodes, from their real positions. */
function drawPath(path, svg) {
  const nodes = [...path.querySelectorAll('.node-disc')];
  if (nodes.length < 2) return;
  const box = path.getBoundingClientRect();
  const points = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
  });

  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const midY = (a.y + b.y) / 2;
    d += ` C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`;
  }

  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  svg.innerHTML = `<path d="${d}" />`;
}

function drawTreeConnector(connector) {
  const map = connector.closest('.learning-map');
  const setup = map?.querySelector('.learning-node-root .node-disc');
  const targets = [...(map?.querySelectorAll('.learning-branches .node-disc') || [])];
  if (!setup || targets.length !== 2) return;

  const box = map.getBoundingClientRect();
  const setupBox = setup.getBoundingClientRect();
  const targetPoints = targets.map((target) => {
    const rect = target.getBoundingClientRect();
    return {
      x: rect.left - box.left + rect.width / 2,
      y: rect.top - box.top,
    };
  });
  const startX = setupBox.left - box.left + setupBox.width / 2;
  const startY = setupBox.bottom - box.top;
  const firstTargetY = Math.min(...targetPoints.map((point) => point.y));
  const splitY = startY + Math.min(54, Math.max(28, (firstTargetY - startY) * 0.42));
  const stacked = Math.abs(targetPoints[0].y - targetPoints[1].y) > 24;
  const height = box.height;
  const svg = connector.querySelector('.tree-svg');

  svg.setAttribute('viewBox', `0 0 ${box.width} ${height}`);
  connector
    .querySelector('.tree-trunk')
    .setAttribute('d', `M ${startX} ${startY} C ${startX} ${startY + 16}, ${startX} ${splitY - 12}, ${startX} ${splitY}`);

  const branchPath = (point, index) => {
    if (stacked && index === 1) {
      const railX = box.width + 8;
      const bendY = point.y - 34;
      return (
        `M ${startX} ${splitY} ` +
        `C ${startX + 36} ${splitY}, ${railX} ${splitY + 8}, ${railX} ${splitY + 30} ` +
        `L ${railX} ${bendY} ` +
        `C ${railX} ${point.y - 14}, ${point.x + 42} ${point.y}, ${point.x} ${point.y}`
      );
    }
    const distance = point.y - splitY;
    return `M ${startX} ${splitY} C ${startX} ${splitY + distance * 0.52}, ${point.x} ${point.y - distance * 0.48}, ${point.x} ${point.y}`;
  };

  connector
    .querySelector('.tree-path-left')
    .setAttribute('d', branchPath(targetPoints[0], 0));
  connector
    .querySelector('.tree-path-right')
    .setAttribute('d', branchPath(targetPoints[1], 1));
  const junction = connector.querySelector('.tree-junction');
  junction.setAttribute('cx', startX);
  junction.setAttribute('cy', splitY);
}

function appendToc(rail, doc, body) {
  if (!doc.headings.length) return;
  const toc = el('nav', { class: 'toc', 'aria-label': 'On this page' });
  toc.append(el('p', { class: 'toc-head' }, 'On this page'));
  for (const h of doc.headings) {
    toc.append(
      el(
        'a',
        {
          class: 'toc-link',
          href: `#${h.id}`,
          'data-toc': h.id,
          onclick: (event) => {
            event.preventDefault();
            document.getElementById(h.id)?.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto' });
          },
        },
        h.text
      )
    );
  }
  rail.append(toc);
}

// ----------------------------------------------------------- exercise view

function syncSidebarLink(link, progress, index) {
  if (!link) return;
  link.classList.toggle('is-done', progress.complete);
  link.classList.toggle('is-skipped', progress.skipped);
  link.querySelector('.sidebar-num').textContent = progress.complete ? '✓' : String(index + 1);
  link.querySelector('.sidebar-status').hidden = !progress.skipped;
}

function exerciseView(id) {
  const doc = docs.get(id);
  if (!doc) return el('div', { class: 'view' }, el('p', { class: 'empty' }, 'Exercise not found.'));

  const track = manifest.tracks.find((t) => t.exercises.some((e) => e.id === id));
  if (!track) return el('div', { class: 'view' }, el('p', { class: 'empty' }, 'Exercise not found.'));
  const index = track.exercises.findIndex((e) => e.id === id);
  const next = track.exercises[index + 1];
  const p = progressOf(id);

  const view = el('div', { class: `view exercise accent-${track.accent}` });

  // --- sidebar: the other exercises in this track
  const sidebar = el('aside', { class: 'sidebar' });
  sidebar.append(el('p', { class: 'sidebar-head' }, track.title));
  const navList = el('ol', { class: 'sidebar-list' });
  track.exercises.forEach((ex, i) => {
    const d = docs.get(ex.id);
    const ep = progressOf(ex.id);
    navList.append(
      el(
        'li',
        {},
        el(
          'a',
          {
            class:
              `sidebar-link${ex.id === id ? ' is-current' : ''}` +
              `${ep.complete ? ' is-done' : ''}${ep.skipped ? ' is-skipped' : ''}`,
            href: `#/e/${ex.id}`,
          },
          el('span', { class: 'sidebar-num' }, ep.complete ? '✓' : String(i + 1)),
          el(
            'span',
            { class: 'sidebar-label' },
            el('span', { class: 'sidebar-title' }, d ? d.title : ex.id),
            el('span', { class: 'sidebar-status', hidden: !ep.skipped }, 'Resume')
          )
        )
      )
    );
  });
  sidebar.append(navList);

  // --- main column
  const main = el('main', { class: 'content' });

  main.append(
    el(
      'a',
      { class: 'back', href: `#/workshop/${track.id}` },
      icon(ICONS.back),
      `Back to ${track.title}`
    )
  );

  if (doc.image) {
    main.append(
      el(
        'div',
        { class: 'hero-img' },
        el('img', { src: `assets/img/${doc.image}-hero.jpg`, alt: '', loading: 'lazy' })
      )
    );
  }

  main.append(
    el(
      'div',
      { class: 'content-head' },
      el('p', { class: 'eyebrow' }, `${track.title} · Module ${index + 1} of ${track.exercises.length}`),
      el('h1', { class: 'content-title' }, doc.emoji && el('span', { class: 'title-emoji' }, doc.emoji), doc.title),
      doc.summary && el('p', { class: 'content-sub' }, doc.summary),
      el(
        'p',
        { class: 'content-facts' },
        taskSummary(doc),
        el('span', { class: 'dot' }, '·'),
        `~${doc.minutes} min`
      )
    )
  );

  const body = el('div', { class: 'md', html: doc.html });
  main.append(body);

  // --- skip / manual completion actions
  const moduleActions = el('div', { class: 'module-actions' });
  main.append(moduleActions);

  // --- completion / hand-off card
  const handoff = el('div', { class: 'handoff', hidden: !p.complete });
  main.append(handoff);

  // Finishing a module can also finish the whole workshop. The last module is
  // not necessarily the one completed last, so ask the track.
  const paintHandoff = () => {
    const workshopDone = trackProgress(track).complete;
    const onward = next
      ? el('a', { href: `#/e/${next.id}` }, `Next: ${docs.get(next.id)?.title || 'Continue'}`)
      : el('a', { href: `#/workshop/${track.id}` }, `Back to ${track.title}`);
    onward.className = workshopDone ? 'btn btn-secondary' : 'btn';

    handoff.replaceChildren(
      el('p', { class: 'handoff-kicker' }, workshopDone ? 'Workshop complete' : 'Module complete'),
      el('h2', {}, workshopDone ? `${track.title} is done.` : 'Nice work.'),
      workshopDone &&
        el('p', { class: 'handoff-sub' }, 'Every module in this workshop is complete.'),
      el('div', { class: 'handoff-actions' }, workshopDone && badgeButton(track), onward)
    );
  };
  paintHandoff();

  // --- right rail: sticky progress + on-this-page
  const rail = el('aside', { class: 'rail' });
  const railRing = el('div', { class: 'rail-ring' });
  railRing.append(ring(p.pct, 92, 8), el('span', { class: 'rail-pct' }, `${Math.round(p.pct * 100)}%`));
  const railOptional = el('p', { class: 'rail-optional', hidden: p.optionalTotal === 0 });
  if (p.optionalTotal > 0) {
    railOptional.textContent = `${p.optionalDone} of ${p.optionalTotal} optional`;
  }
  rail.append(
    el(
      'div',
      { class: 'rail-card' },
      railRing,
      el('p', { class: 'rail-count' }, moduleProgressLabel(p)),
      railOptional
    )
  );
  appendToc(rail, doc, body);

  view.append(sidebar, main, rail);

  const selfLink = sidebar.querySelector(`.sidebar-link[href="#/e/${id}"]`);

  const syncExerciseProgress = (after) => {
    const wasComplete = !handoff.hidden;
    updateRing(railRing, after.pct);
    railRing.querySelector('.rail-pct').textContent = `${Math.round(after.pct * 100)}%`;
    rail.querySelector('.rail-count').textContent = moduleProgressLabel(after);
    if (after.optionalTotal > 0) {
      railOptional.textContent = `${after.optionalDone} of ${after.optionalTotal} optional`;
    }
    syncSidebarLink(selfLink, after, index);
    paintModuleActions(after);
    refreshHeaderBar();

    paintHandoff();
    handoff.hidden = !after.complete;
    if (after.complete && !wasComplete) {
      celebrate();
      toast(trackProgress(track).complete ? `${track.title} complete!` : 'Module complete!', 'big');
      handoff.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'center' });
    }
  };

  const paintModuleActions = (state) => {
    moduleActions.replaceChildren();
    moduleActions.hidden = state.complete;
    if (state.complete) return;

    const copy = el(
      'div',
      { class: 'module-actions-copy' },
      el('p', { class: 'module-actions-title' }, state.skipped ? 'Saved for later' : 'Set your own pace'),
      el(
        'p',
        {},
        state.skipped
          ? 'Resume this module when you are ready. Your completed steps are still here.'
          : state.total === 0
            ? 'This module has no required checklist steps.'
            : 'You can skip this module now and return without losing your completed steps.'
      )
    );
    const buttons = el('div', { class: 'module-action-buttons' });

    if (state.total === 0) {
      buttons.append(
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              store.setModuleStatus(id, 'complete');
              syncExerciseProgress(progressOf(id));
            },
          },
          'Complete module'
        )
      );
    }

    if (state.skipped) {
      buttons.append(
        el(
          'button',
          {
            class: 'btn btn-secondary',
            type: 'button',
            onclick: () => {
              store.setModuleStatus(id, '');
              syncExerciseProgress(progressOf(id));
              toast('Module resumed');
            },
          },
          'Resume module'
        )
      );
    } else {
      buttons.append(
        el(
          'button',
          {
            class: 'btn btn-secondary',
            type: 'button',
            onclick: () => {
              store.setModuleStatus(id, 'skipped');
              toast('Module saved for later');
              location.hash = next ? `#/e/${next.id}` : `#/workshop/${track.id}`;
            },
          },
          'Skip for now'
        )
      );
    }

    moduleActions.append(copy, buttons);
  };

  paintModuleActions(p);

  wireTaskProgress({
    body,
    id,
    tasks: doc.tasks,
    onProgress: syncExerciseProgress,
  });

  observeToc(body, rail);
  return view;
}

function setupView({ showGateNotice = false } = {}) {
  const setup = manifest.setup;
  const doc = setup && docs.get(setup.id);
  if (!doc) return el('main', { class: 'view' }, el('p', { class: 'empty' }, 'Setup guide not found.'));

  const p = progressOf(setup.id);
  const view = el('div', { class: `view exercise setup-view accent-${setup.accent}` });
  const main = el('main', { class: 'content' });

  main.append(
    el('a', { class: 'back', href: '#/' }, icon(ICONS.back), 'All modules'),
    showGateNotice
      ? el(
          'div',
          { class: 'setup-required-notice', role: 'status' },
          icon(ICONS.lock),
          el(
            'div',
            {},
            el('p', { class: 'setup-required-title' }, 'Repository setup required'),
            el('p', {}, 'Complete every setup step to unlock both workshops.')
          )
        )
      : document.createDocumentFragment(),
    el(
      'div',
      { class: 'content-head setup-head' },
      el('p', { class: 'eyebrow' }, setup.name),
      el('h1', { class: 'content-title' }, setup.title),
      el('p', { class: 'content-sub' }, setup.tagline),
      el(
        'p',
        { class: 'content-facts' },
        `${doc.tasks.length} setup steps`,
        el('span', { class: 'dot' }, '·'),
        'Tracked separately'
      )
    )
  );

  const body = el('div', { class: 'md', html: doc.html });
  main.append(body);

  const handoff = el('div', { class: 'handoff', hidden: !p.complete });
  handoff.append(
    el('p', { class: 'handoff-kicker' }, 'Setup complete'),
    el('h2', {}, 'You are ready for the workshop.'),
    el('a', { class: 'btn', href: '#/' }, 'Choose a workshop')
  );
  main.append(handoff);

  const rail = el('aside', { class: 'rail' });
  const railRing = el('div', { class: 'rail-ring' });
  railRing.append(ring(p.pct, 92, 8), el('span', { class: 'rail-pct' }, `${Math.round(p.pct * 100)}%`));
  rail.append(
    el(
      'div',
      { class: 'rail-card' },
      railRing,
      el('p', { class: 'rail-count' }, `${p.done} of ${p.total} setup steps`)
    )
  );
  appendToc(rail, doc, body);

  view.append(main, rail);

  const syncSetupProgress = (after) => {
    const wasComplete = !handoff.hidden;
    updateRing(railRing, after.pct);
    rail.querySelector('.rail-count').textContent = `${after.done} of ${after.total} setup steps`;
    railRing.querySelector('.rail-pct').textContent = `${Math.round(after.pct * 100)}%`;
    refreshHeaderBar();

    handoff.hidden = !after.complete;
    if (after.complete && !wasComplete) {
      celebrate();
      toast('Setup complete!', 'big');
      handoff.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'center' });
    }
  };

  wireTaskProgress({
    body,
    id: setup.id,
    tasks: doc.tasks,
    onProgress: syncSetupProgress,
  });
  observeToc(body, rail);
  return view;
}

function wireTaskProgress({ body, id, tasks, onProgress }) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const li of body.querySelectorAll('.md-task')) {
    const taskId = li.dataset.taskId;
    const task = tasksById.get(taskId);
    const btn = li.querySelector('.task-box');
    const sync = () => {
      const on = store.isDone(id, taskId);
      li.classList.toggle('is-done', on);
      btn.setAttribute('aria-checked', String(on));
    };
    sync();
    btn.addEventListener('click', () => {
      const now = store.toggle(id, taskId, { resume: !task?.optional });
      sync();
      if (now) {
        btn.classList.remove('pop');
        void btn.offsetWidth;
        btn.classList.add('pop');
        toast(task?.optional ? '+1 optional step' : '+1 step');
      }
      const after = progressOf(id);
      onProgress(after);
    });
  }
}

function updateRing(container, pct) {
  const fill = container.querySelector('.ring-fill');
  if (!fill) return;
  const c = Number(fill.getAttribute('stroke-dasharray'));
  fill.setAttribute('stroke-dashoffset', c * (1 - pct));
}

function refreshHeaderBar() {
  const overall = flat.reduce(
    (acc, ex) => {
      const p = progressOf(ex.id);
      acc.done += p.unitsDone;
      acc.total += p.unitsTotal;
      return acc;
    },
    { done: 0, total: 0 }
  );
  const pct = overall.total ? Math.round((overall.done / overall.total) * 100) : 0;
  const fill = document.querySelector('.topbar .bar-fill');
  const label = document.querySelector('.topbar .bar-label');
  const progress = document.querySelector('.topbar-progress');
  if (fill) fill.style.width = `${pct}%`;
  if (label) label.textContent = `${pct}%`;
  if (progress) progress.title = `${overall.done} of ${overall.total} required progress items complete`;
}

function observeToc(body, rail) {
  const links = [...rail.querySelectorAll('.toc-link')];
  if (!links.length) return;
  const seen = new Map();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const active = links.find((l) => seen.get(l.dataset.toc));
      links.forEach((l) => l.classList.toggle('is-active', l === active));
    },
    { rootMargin: '-80px 0px -70% 0px' }
  );
  body.querySelectorAll('h2[id]').forEach((h) => io.observe(h));
}

// ---------------------------------------------------------------- toasts

const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let toastTimer;
function toast(message, size = '') {
  let host = document.querySelector('.toast');
  if (!host) {
    host = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  host.textContent = message;
  host.className = `toast is-visible ${size}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.className = 'toast';
  }, size === 'big' ? 2600 : 1400);
}

// ---------------------------------------------------------------- routing

function route() {
  const hash = location.hash.replace(/^#/, '');
  const exercise = hash.match(/^\/e\/(.+)$/);
  if (exercise) return { name: 'exercise', id: decodeURIComponent(exercise[1]) };
  const workshop = hash.match(/^\/workshop\/(.+)$/);
  if (workshop) return { name: 'workshop', id: decodeURIComponent(workshop[1]) };
  if (hash === '/setup') return { name: 'setup' };
  return { name: 'hub' };
}

function render() {
  let r = route();
  let showGateNotice = false;
  if ((r.name === 'workshop' || r.name === 'exercise') && !setupIsComplete()) {
    history.replaceState(null, '', '#/setup');
    r = { name: 'setup' };
    showGateNotice = true;
  }

  const build = () => {
    app.innerHTML = '';
    app.append(header());
    if (r.name === 'exercise') app.append(exerciseView(r.id));
    else if (r.name === 'workshop') app.append(workshopView(r.id));
    else if (r.name === 'setup') app.append(setupView({ showGateNotice }));
    else app.append(hubView());
    app.querySelectorAll('.tree-connector').forEach(drawTreeConnector);
  };
  if (document.startViewTransition && motionOK()) document.startViewTransition(build);
  else build();
}

// ---------------------------------------------------------------- boot

async function boot() {
  applyTheme();
  try {
    manifest = await (await fetch('manifest.json')).json();
  } catch {
    app.innerHTML =
      '<div class="view"><p class="empty">Could not load <code>manifest.json</code>. ' +
      'This app must be served over HTTP — see <code>learn/README.md</code>.</p></div>';
    return;
  }

  flat = manifest.tracks.flatMap((t) => t.exercises);

  const entries = [...(manifest.setup ? [manifest.setup] : []), ...flat];
  const results = await Promise.allSettled(entries.map(loadDocument));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? entries[i] : null))
    .filter(Boolean);

  // Drop anything that failed to load so the rest of the app still works.
  if (failed.length) {
    for (const t of manifest.tracks) t.exercises = t.exercises.filter((e) => docs.has(e.id));
    flat = flat.filter((e) => docs.has(e.id));
    if (manifest.setup && !docs.has(manifest.setup.id)) manifest.setup = null;
    console.warn(
      'Could not load:',
      failed.map((entry) => entry.file)
    );
  }

  render();
  window.addEventListener('hashchange', () => {
    render();
    if (!location.hash.startsWith('#/')) return;
    window.scrollTo({ top: 0, behavior: 'auto' });
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.path').forEach((p) => drawPath(p, p.querySelector('.path-line')));
    document.querySelectorAll('.tree-connector').forEach(drawTreeConnector);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
}

boot();
