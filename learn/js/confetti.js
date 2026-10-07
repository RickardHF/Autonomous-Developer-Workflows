// A small, dependency-free celebration burst. Skipped entirely when the
// visitor prefers reduced motion.

const COLORS = ['#FFD100', '#E5A000', '#16A394', '#7C5CFF', '#FF6B6B'];

export function celebrate() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'confetti';
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  document.body.append(canvas);

  const w = window.innerWidth;
  const pieces = Array.from({ length: 110 }, () => ({
    x: w / 2 + (Math.random() - 0.5) * w * 0.5,
    y: window.innerHeight * 0.45 + (Math.random() - 0.5) * 80,
    vx: (Math.random() - 0.5) * 11,
    vy: -6 - Math.random() * 9,
    size: 5 + Math.random() * 7,
    spin: (Math.random() - 0.5) * 0.3,
    angle: Math.random() * Math.PI,
    color: COLORS[(Math.random() * COLORS.length) | 0],
  }));

  const start = performance.now();
  const DURATION = 2200;

  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, w, window.innerHeight);

    for (const p of pieces) {
      p.vy += 0.26; // gravity
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.angle += p.spin;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.globalAlpha = Math.max(0, 1 - elapsed / DURATION);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }

    if (elapsed < DURATION) requestAnimationFrame(frame);
    else canvas.remove();
  }

  requestAnimationFrame(frame);
}
