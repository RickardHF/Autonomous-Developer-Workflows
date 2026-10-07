// The workshop completion badge: a 1200x1200 PNG the learner can keep.
//
// Drawn straight onto a canvas rather than authored as SVG. An SVG rasterised
// through `new Image()` cannot reach external resources, so the logo and the
// Google-Fonts faces would both have to be inlined as base64. Canvas draws with
// the document's already-loaded webfonts, and the logo is same-origin, so the
// canvas stays untainted and `toBlob()` works.
//
// The preview element *is* the export element — what you see is what downloads.

import { el } from './dom.js';

const SIZE = 1200;

// A fixed light palette. A downloaded image should not depend on the theme the
// visitor happened to be using when they pressed the button.
const INK = '#1a1814';
const INK_SOFT = '#443e33';
const MUTED = '#6b6355';
const CREAM = '#fbf9f4';
const YELLOW = '#ffd100';

const ACCENTS = { amber: '#d99000', violet: '#7c5cff', teal: '#16a394' };

const DISPLAY = '"Archivo Black", Inter, system-ui, sans-serif';
const SANS = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';

/** #rrggbb -> rgba(), for tints the palette has no token for. */
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// ------------------------------------------------------------------ resources

let logoPromise;
/** Resolves to the logo, or to null — a missing logo must not break the badge. */
function loadLogo() {
  logoPromise ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'assets/eficode-logo.png';
  });
  return logoPromise;
}

/** Canvas draws with whatever is loaded *now*, so ask for the faces first. */
async function readyFonts(text) {
  try {
    await Promise.all([
      document.fonts.load(`64px ${DISPLAY}`, text),
      document.fonts.load(`600 44px ${SANS}`, text),
      document.fonts.load(`700 52px ${SANS}`, text),
    ]);
    await document.fonts.ready;
  } catch {
    // A font that refuses to load just falls back down the stack.
  }
}

// -------------------------------------------------------------------- drawing

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function centred(ctx, text, y, { font, color, spacing = '0px' }) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.letterSpacing = spacing;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, SIZE / 2, y);
  ctx.letterSpacing = '0px';
}

function drawGround(ctx) {
  ctx.fillStyle = CREAM;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // The same two radial tints the app itself sits on (styles.css --bg-tint).
  const tints = [
    { x: 0.12 * SIZE, y: -0.05 * SIZE, r: 0.42 * SIZE, color: 'rgba(255, 209, 0, ALPHA)', alpha: 0.28 },
    { x: 0.92 * SIZE, y: 0.04 * SIZE, r: 0.38 * SIZE, color: 'rgba(124, 92, 255, ALPHA)', alpha: 0.16 },
  ];
  for (const tint of tints) {
    const gradient = ctx.createRadialGradient(tint.x, tint.y, 0, tint.x, tint.y, tint.r);
    gradient.addColorStop(0, tint.color.replace('ALPHA', String(tint.alpha)));
    gradient.addColorStop(1, tint.color.replace('ALPHA', '0'));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, SIZE, SIZE);
  }
}

function drawFrame(ctx, accent) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(44, 44, SIZE - 88, SIZE - 88, 46);
  ctx.strokeStyle = withAlpha(accent, 0.34);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

const SEAL_R = 86;

function drawSeal(ctx, accent, cy) {
  const r = SEAL_R;
  ctx.save();
  ctx.beginPath();
  ctx.arc(SIZE / 2, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(YELLOW, 0.34);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 8;
  ctx.stroke();

  // ICONS.check from app.js, scaled out of its 24x24 viewBox.
  const scale = 3.2;
  ctx.translate(SIZE / 2 - 12 * scale, cy - 12 * scale);
  ctx.scale(scale, scale);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D('M4 12.5l5 5L20 6.5'));
  ctx.restore();
}

/**
 * The whole badge is laid out as one centred vertical flow rather than on fixed
 * coordinates: the workshop title wraps to one or two lines and the name is
 * optional, so the content height is not known up front and the margins have to
 * fall out of it.
 */
export function drawBadge(canvas, { workshopTitle, name, modules, dateText, accent }) {
  const ctx = canvas.getContext('2d');
  const trimmedName = (name || '').trim();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);
  drawGround(ctx);
  drawFrame(ctx, accent);

  const logo = canvas._logo;
  const gap = (height) => ({ height });
  const flow = [];

  if (logo) {
    const height = 140;
    const width = (logo.naturalWidth / logo.naturalHeight) * height;
    flow.push({
      height,
      draw: (y) => ctx.drawImage(logo, (SIZE - width) / 2, y - height / 2, width, height),
    });
    flow.push(gap(30));
  }

  flow.push({
    height: 30,
    draw: (y) =>
      centred(ctx, 'AGENTIC WORKSHOP · EFICODE', y, {
        font: `600 23px ${SANS}`,
        color: MUTED,
        spacing: '5px',
      }),
  });
  flow.push(gap(34), { height: SEAL_R * 2, draw: (y) => drawSeal(ctx, accent, y) }, gap(46));

  ctx.font = `64px ${DISPLAY}`;
  for (const line of wrapText(ctx, workshopTitle, 900)) {
    flow.push({
      height: 82,
      draw: (y) => centred(ctx, line, y, { font: `64px ${DISPLAY}`, color: INK }),
    });
  }

  flow.push(gap(22), {
    height: 5,
    draw: (y) => {
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(SIZE / 2 - 80, y - 2.5, 160, 5, 3);
      ctx.fill();
    },
  }, gap(22));

  if (trimmedName) {
    flow.push(
      {
        height: 34,
        draw: (y) =>
          centred(ctx, 'AWARDED TO', y, { font: `600 19px ${SANS}`, color: MUTED, spacing: '4px' }),
      },
      { height: 68, draw: (y) => centred(ctx, trimmedName, y, { font: `700 52px ${SANS}`, color: INK }) }
    );
  }

  flow.push(gap(40), {
    height: 32,
    draw: (y) =>
      centred(ctx, `${modules} modules completed · ${dateText}`, y, {
        font: `500 26px ${SANS}`,
        color: MUTED,
      }),
  });

  const total = flow.reduce((sum, item) => sum + item.height, 0);
  // Optically centred — a hair above the true middle reads as balanced.
  let cursor = 594 - total / 2;
  for (const item of flow) {
    item.draw?.(cursor + item.height / 2);
    cursor += item.height;
  }
}

// --------------------------------------------------------------------- dialog

function certificationName(track) {
  return `Agentic Workshop — ${track.title}`;
}

function linkedinDetails(track, dateText) {
  const row = (term, value) =>
    el('div', { class: 'badge-fact' }, el('dt', {}, term), el('dd', {}, value));
  return el(
    'details',
    { class: 'badge-linkedin' },
    el('summary', {}, 'Add it to LinkedIn'),
    el(
      'p',
      {},
      'Post the image, or add it under ',
      el('em', {}, 'Licenses & certifications'),
      ' with these details:'
    ),
    el(
      'dl',
      {},
      row('Name', certificationName(track)),
      row('Issuing organization', 'Eficode'),
      row('Issue date', dateText)
    )
  );
}

/**
 * Opens the badge dialog for a completed workshop. The name typed here lives only
 * in this dialog's DOM and dies with it — nothing is written to localStorage.
 */
export async function openBadgeDialog({ track, moduleCount }) {
  // Defensive: a dialog is never meant to outlive its close, but if one ever
  // did, it would carry a stale name with it. Start from a clean slate.
  document.querySelector('.badge-dialog')?.remove();

  const accent = ACCENTS[track.accent] || ACCENTS.amber;
  const dateText = new Date().toLocaleDateString('en', { month: 'long', year: 'numeric' });

  const canvas = el('canvas', {
    class: 'badge-preview',
    width: SIZE,
    height: SIZE,
    role: 'img',
    'aria-label': `${certificationName(track)} badge, ${moduleCount} modules completed, ${dateText}`,
  });

  const nameInput = el('input', {
    type: 'text',
    maxlength: '48',
    autocomplete: 'off',
    placeholder: 'Your name',
    class: 'badge-name-input',
  });

  const paint = () =>
    drawBadge(canvas, {
      workshopTitle: track.title,
      name: nameInput.value,
      modules: moduleCount,
      dateText,
      accent,
    });

  const dialog = el(
    'dialog',
    { class: `badge-dialog accent-${track.accent}` },
    el('p', { class: 'handoff-kicker' }, 'Workshop complete'),
    el('h2', { class: 'badge-dialog-title' }, 'Your badge'),
    el('p', { class: 'badge-dialog-sub' }, 'Download it and share it however you like.'),
    canvas,
    el(
      'label',
      { class: 'badge-name-field' },
      el('span', {}, 'Your name (optional)'),
      nameInput
    ),
    el('p', { class: 'badge-note' }, 'Used for this image only — nothing is saved.'),
    el(
      'div',
      { class: 'badge-dialog-actions' },
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () =>
            canvas.toBlob((blob) => {
              if (!blob) return;
              const a = el('a', {
                href: URL.createObjectURL(blob),
                download: `agentic-workshop-${track.id}-badge.png`,
              });
              a.click();
              URL.revokeObjectURL(a.href);
            }, 'image/png'),
        },
        'Download PNG'
      ),
      el('button', { class: 'btn btn-secondary', type: 'button', onclick: () => dismiss() }, 'Close')
    ),
    linkedinDetails(track, dateText)
  );

  // Esc is handled by the browser itself, so cleanup hangs off the events it
  // fires rather than off the button alone. Both are idempotent.
  function dismiss() {
    if (dialog.open) dialog.close();
    dialog.remove();
  }

  nameInput.addEventListener('input', paint);
  dialog.addEventListener('close', dismiss);
  dialog.addEventListener('cancel', dismiss);

  document.body.append(dialog);
  dialog.showModal();
  nameInput.focus();

  canvas._logo = await loadLogo();
  await readyFonts(track.title);
  paint();
}
