#!/usr/bin/env node
// tiles.mjs: episode tile generator with one locked layout.
//
//   node tiles.mjs --title "The Title" --ep 7 --photo path/to/face.jpg [--out work/tiles]
//   node tiles.mjs --self-test
//
// Outputs ep007_yt.png (1280x720) and ep007_short.png (1080x1920) from the ONE
// locked template in tile_template.mjs. Per-episode inputs are title, episode
// number, and photo — nothing else. If you want the layout changed, change
// tile_template.mjs and commit; that IS the brand lock.
//
// Stack: satori (layout+text → SVG, fonts embedded as vector paths, so output
// is identical on every machine) → @resvg/resvg-js (SVG → PNG). Zero cloud,
// zero system-font dependence.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { BRAND, SIZES, MAX_TITLE_CHARS, YT_VARIANTS, shortCover } from './tile_template.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function die(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

// ---- fonts (vendored, OFL — fonts/OFL-LICENSE.txt) --------------------------
function loadFonts() {
  const entries = [
    { file: 'Inter-Regular.ttf', weight: 400 },
    { file: 'Inter-Bold.ttf', weight: 700 },
    { file: 'Inter-Black.ttf', weight: 900 },
  ];
  return entries.map(({ file, weight }) => {
    const p = join(HERE, 'fonts', file);
    if (!existsSync(p)) throw new Error(`missing font ${p} — fonts/ must ship with the repo`);
    return { name: 'Inter', data: readFileSync(p), weight, style: 'normal' };
  });
}

// ---- photo → data URI --------------------------------------------------------
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
function photoToDataUri(photoPath) {
  const ext = extname(photoPath).toLowerCase();
  if (!MIME[ext]) throw new Error(`photo must be .jpg/.jpeg/.png, got "${ext || 'no extension'}" (${photoPath})`);
  if (!existsSync(photoPath)) throw new Error(`photo not found: ${photoPath}`);
  const buf = readFileSync(photoPath);
  if (buf.length < 1024) throw new Error(`photo suspiciously small (${buf.length} bytes): ${photoPath}`);
  return `data:${MIME[ext]};base64,${buf.toString('base64')}`;
}

// ---- render ------------------------------------------------------------------
async function renderPng(element, { width, height }, fonts) {
  const svg = await satori(element, { width, height, fonts });
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  const dims = pngDims(png);
  if (dims.width !== width || dims.height !== height)
    throw new Error(`output is ${dims.width}x${dims.height}, expected ${width}x${height}`);
  if (png.length < 10_000)
    throw new Error(`output PNG is only ${png.length} bytes — render produced (near-)empty content`);
  return png;
}

function pngDims(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('output is not a PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function epLabelOf(ep) {
  const n = Number(ep);
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new Error(`--ep must be an integer 0–999, got "${ep}"`);
  return { label: `EP ${String(n).padStart(3, '0')}`, slug: `ep${String(n).padStart(3, '0')}` };
}

function validateTitle(title) {
  if (!title || !title.trim()) throw new Error('--title is required and cannot be empty');
  if (title.length > MAX_TITLE_CHARS)
    throw new Error(`title is ${title.length} chars; the locked layout fits ${MAX_TITLE_CHARS}. Shorten the title — do not shrink the type.`);
  return title.trim();
}

// Tile text should be a 3–5 word hook, not the episode title — the title
// already renders next to the thumbnail on YouTube.
// --hook is optional; without it the tile falls back to the full title.
function validateHook(hook) {
  const h = hook.trim();
  const words = h.split(/\s+/).length;
  if (!h) throw new Error('--hook cannot be empty (omit it to use the title)');
  if (words > 5) throw new Error(`hook is ${words} words; the ceiling is 5. Sharpen the hook.`);
  if (h.length > 36) throw new Error(`hook is ${h.length} chars; keep it under 36 so it stays LOUD at the locked type size.`);
  return h;
}

async function generate({ title, ep, photo, out, variants = false, hook }) {
  const fonts = loadFonts();
  const t = validateTitle(title);
  const tileText = hook !== undefined ? validateHook(hook) : t;
  const { label, slug } = epLabelOf(ep);
  const photoDataUri = photoToDataUri(photo);
  mkdirSync(out, { recursive: true });
  const input = { title: tileText, epLabel: label, photoDataUri };

  // Default: variant A only (the current pick). --variants: all three YT
  // layouts for a Test & Compare set — same inputs, three different bets.
  const jobs = variants
    ? Object.entries(YT_VARIANTS).map(([key, fn]) =>
        ({ name: `${slug}_yt_${key}.png`, size: SIZES.yt, element: fn(input) }))
    : [{ name: `${slug}_yt.png`, size: SIZES.yt, element: YT_VARIANTS.a(input) }];
  jobs.push({ name: `${slug}_short.png`, size: SIZES.short, element: shortCover(input) });
  for (const job of jobs) {
    const png = await renderPng(job.element, job.size, fonts);
    const outPath = join(out, job.name);
    writeFileSync(outPath, png);
    console.log(`  ✓ ${outPath}  ${job.size.width}x${job.size.height}  ${(png.length / 1024).toFixed(0)}KB`);
  }
}

// ---- self-test (offline, no inputs) -------------------------------------------
// Placeholder "face": an SVG head-and-shoulders rasterized through the same
// resvg we ship — no binary fixture needed, media never commits.
function placeholderPhotoPng() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800">
    <rect width="800" height="800" fill="#4a5560"/>
    <circle cx="400" cy="300" r="150" fill="#d9c9a3"/>
    <ellipse cx="400" cy="640" rx="240" ry="160" fill="#8abfc5"/>
  </svg>`;
  return new Resvg(svg, { fitTo: { mode: 'width', value: 800 } }).render().asPng();
}

async function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };

  const tmp = await mkdtemp(join(tmpdir(), 'tiles-selftest-'));
  try {
    // 1: fonts load
    let fonts;
    try { fonts = loadFonts(); check('fonts load (Regular/Bold/Black)', fonts.length === 3); }
    catch (e) { check('fonts load (Regular/Bold/Black)', false, e.message); throw e; }

    // 2: placeholder photo generates and is a real PNG
    const ph = placeholderPhotoPng();
    const phPath = join(tmp, 'placeholder.png');
    writeFileSync(phPath, ph);
    check('placeholder photo renders', pngDims(ph).width === 800, `${ph.length} bytes`);

    // 3+4: full pipeline, both sizes, exact dimensions (asserted inside renderPng)
    try {
      await generate({ title: 'Self-Test: A Sample Episode Tile Title', ep: '0', photo: phPath, out: tmp });
      const yt = readFileSync(join(tmp, 'ep000_yt.png'));
      const sh = readFileSync(join(tmp, 'ep000_short.png'));
      check('YT tile 1280x720', pngDims(yt).width === 1280 && pngDims(yt).height === 720, `${(yt.length / 1024).toFixed(0)}KB`);
      check('Short cover 1080x1920', pngDims(sh).width === 1080 && pngDims(sh).height === 1920, `${(sh.length / 1024).toFixed(0)}KB`);
    } catch (e) { check('full pipeline render', false, e.message); }

    // 4b: --variants emits all three YT layouts at correct dimensions
    try {
      await generate({ title: 'Self-Test: A Sample Episode Tile Title', ep: '0', photo: phPath, out: tmp, variants: true });
      const ok = ['a', 'b', 'c'].every(k => {
        const d = pngDims(readFileSync(join(tmp, `ep000_yt_${k}.png`)));
        return d.width === 1280 && d.height === 720;
      });
      check('variants a/b/c all render 1280x720', ok);
    } catch (e) { check('variants a/b/c all render 1280x720', false, e.message); }

    // 5: over-length title rejected
    let rejected = false;
    try { validateTitle('x'.repeat(MAX_TITLE_CHARS + 1)); } catch { rejected = true; }
    check(`title > ${MAX_TITLE_CHARS} chars rejected`, rejected);

    // 6: missing photo rejected
    rejected = false;
    try { photoToDataUri(join(tmp, 'nope.jpg')); } catch { rejected = true; }
    check('missing photo rejected', rejected);

    // 7: bad episode number rejected
    rejected = false;
    try { epLabelOf('seven'); } catch { rejected = true; }
    check('non-numeric --ep rejected', rejected);

    // 8: over-length hook rejected (>5 words)
    rejected = false;
    try { validateHook('six whole words is one too many'); } catch { rejected = true; }
    check('hook > 5 words rejected', rejected);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

// ---- main ----------------------------------------------------------------------
const { values } = parseArgs({
  options: {
    title: { type: 'string' },
    ep: { type: 'string' },
    photo: { type: 'string' },
    out: { type: 'string', default: join(HERE, 'work', 'tiles') },
    hook: { type: 'string' },
    variants: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
  },
});

if (values['self-test']) {
  await selfTest();
} else {
  if (!values.title || !values.ep || !values.photo)
    die('usage: node tiles.mjs --title "..." --ep N --photo face.jpg [--out dir]   (or --self-test)');
  try {
    await generate({ title: values.title, ep: values.ep, photo: resolve(values.photo), out: values.out, variants: values.variants, hook: values.hook });
  } catch (e) {
    die(e.message);
  }
}
