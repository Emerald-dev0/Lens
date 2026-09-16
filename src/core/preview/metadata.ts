/**
 * Link-preview metadata.
 *
 * A preview image nobody references is a decorative file. This module owns both
 * halves: generating the exact tags for the asset Lens just produced, and auditing
 * the tags a live URL actually serves — including fetching og:image to prove it
 * resolves and has the dimensions the card expects.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { LensSession } from '../session.js';
import { readImageInfo } from '../capture/image-info.js';
import { humanBytes } from '../util/fs.js';


export interface MetadataBlock {
  og: Record<string, string>;
  twitter: Record<string, string>;
  /** Ready-to-paste HTML, one tag per line. */
  snippet: string;
  /** Framework-aware placement advice. */
  placement: { framework: string; notes: string[] };
}

export interface MetadataAudit {
  url: string;
  found: Record<string, string>;
  missing: Array<{ property?: string; name?: string; why: string }>;
  problems: Array<{ tag: string; issue: string }>;
  image: {
    url: string | null;
    resolved: boolean;
    status: number | null;
    bytes: number | null;
    width: number | null;
    height: number | null;
    format: string | null;
    /** Ratio mismatch against what a link card wants. */
    aspectWarning?: string;
  } | null;
  verdict: 'ok' | 'incomplete' | 'broken';
  summary: string;
  fix?: string;
}

const REQUIRED: Array<{ key: string; prop?: string; name?: string; why: string }> = [
  { key: 'og:title', prop: 'og:title', why: 'the headline in the card' },
  { key: 'og:description', prop: 'og:description', why: 'the line under the headline' },
  { key: 'og:image', prop: 'og:image', why: 'the picture itself' },
  { key: 'og:url', prop: 'og:url', why: 'the canonical link the card points at' },
  { key: 'twitter:card', name: 'twitter:card', why: 'makes Twitter/X render a large image instead of a plain link' },
];

export function buildMetadataBlock(input: {
  title: string;
  description: string;
  imagePath: string;
  url: string | null;
  siteName?: string;
  twitter?: string;
  size: { width: number; height: number };
  locale?: string;
}): MetadataBlock {
  const imageFile = path.basename(input.imagePath);
  const publicBase = '/og';
  const imageUrl = input.url ? new URL(`${publicBase}/${imageFile}`, originOf(input.url)).toString() : `${publicBase}/${imageFile}`;

  const og: Record<string, string> = {
    'og:type': 'website',
    'og:site_name': input.siteName ?? derivedSiteName(input.url),
    'og:title': clip(input.title, 95),
    'og:description': clip(input.description, 200),
    'og:url': input.url ?? '',
    'og:image': imageUrl,
    'og:image:width': String(input.size.width),
    'og:image:height': String(input.size.height),
    'og:image:alt': `Preview image showing ${clip(input.title, 60)} as it actually renders`,
    'og:locale': input.locale ?? 'en_US',
  };
  const twitter: Record<string, string> = {
    'twitter:card': 'summary_large_image',
    'twitter:title': clip(input.title, 70),
    'twitter:description': clip(input.description, 200),
    'twitter:image': imageUrl,
  };
  if (input.twitter) twitter['twitter:site'] = input.twitter.startsWith('@') ? input.twitter : `@${input.twitter}`;

  for (const [key, value] of Object.entries(og)) if (!value) delete og[key];

  const lines: string[] = [];
  for (const [property, content] of Object.entries(og)) lines.push(`<meta property="${property}" content="${attr(content)}" />`);
  for (const [name, content] of Object.entries(twitter)) lines.push(`<meta name="${name}" content="${attr(content)}" />`);

  return {
    og,
    twitter,
    snippet: lines.join('\n'),
    placement: placementAdvice(input.imagePath, imageFile),
  };
}

/**
 * Where the asset should live for this project's framework.
 *
 * This is advice, not an automated edit: silently rewriting a user's HTML head or
 * route files is exactly the kind of thing that makes an agent's diff unreviewable.
 */
function placementAdvice(imagePath: string, fileName: string): MetadataBlock['placement'] {
  const framework = detectFramework(process.cwd());
  const notes: string[] = [];
  switch (framework) {
    case 'next':
      notes.push(
        `Next.js App Router: put ${fileName} in app/opengraph-image.png (or copy it to public/${fileName}) and let static metadata read /${fileName}.`,
        'Alternatively generate it server-side with ImageResponse using the same composition Lens used, so builds stay reproducible.',
      );
      break;
    case 'astro':
      notes.push(`Astro: copy ${fileName} into public/ and set og:image to /${fileName} in the base layout <head>.`);
      break;
    case 'sveltekit':
      notes.push(`SvelteKit: copy ${fileName} into static/ and set og:image to /${fileName} in src/routes/+layout.svelte (or via svelte:head).`);
      break;
    case 'vite':
      notes.push(`Vite/SPA: copy ${fileName} into public/ and add the tags to index.html's <head>; for client-rendered routes, remember crawlers may not run JS, so keep the tags static.`);
      break;
    default:
      notes.push(`Copy ${fileName} next to your HTML and serve it at a stable absolute URL, then point og:image at it.`);
  }
  notes.push(`Lens wrote the composition source beside the image: ${imagePath.replace(/\.png$/, '.html')} holds the exact tags.`);
  return { framework, notes };
}

export async function auditMetadata(session: LensSession, url: string): Promise<MetadataAudit> {
  const page = session.activePage.page;
  const current = page.url();
  if (current !== url) await session.open(url).catch(() => null);

  const collected = await page
    .evaluate(() => {
      const out: Record<string, string> = {};
      for (const meta of Array.from(document.querySelectorAll('meta'))) {
        const key = meta.getAttribute('property') ?? meta.getAttribute('name') ?? meta.getAttribute('http-equiv');
        const content = meta.getAttribute('content');
        if (key && content) out[key.toLowerCase()] = content;
      }
      const link = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]') as HTMLLinkElement | null;
      if (link?.href) out['icon'] = link.href;
      return { tags: out, title: document.title, description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '' };
    })
    .catch(() => ({ tags: {} as Record<string, string>, title: '', description: '' }));

  const tags = collected.tags;
  const missing = REQUIRED.filter((entry) => {
    const value = entry.prop ? tags[entry.prop.toLowerCase()] : tags[entry.name?.toLowerCase() ?? ''];
    return !value;
  }).map((entry) => ({ property: entry.prop, name: entry.name, why: entry.why }));

  const problems: MetadataAudit['problems'] = [];
  const title = tags['og:title'];
  const description = tags['og:description'];
  if (title && title.length > 100) problems.push({ tag: 'og:title', issue: `${title.length} characters — most clients truncate around 95` });
  if (description && description.length > 210) problems.push({ tag: 'og:description', issue: `${description.length} characters — most clients truncate around 200` });
  if (title && title === tags['twitter:title'] === undefined) problems.push({ tag: 'twitter:title', issue: 'twitter:title missing while og:title is set' });
  if (tags['twitter:card'] && tags['twitter:card'] !== 'summary_large_image' && tags['og:image']) {
    problems.push({ tag: 'twitter:card', issue: `"${tags['twitter:card']}" renders a small thumbnail; use summary_large_image for a 1200×630 plate` });
  }

  let image: MetadataAudit['image'] = null;
  const imageHref = tags['og:image'] ?? tags['twitter:image'] ?? null;
  if (imageHref) {
    const absolute = absolutise(imageHref, page.url());
    const response = await page
      .context()
      .request.get(absolute, { timeout: 8000 })
      .catch(() => null);
    if (!response || !response.ok()) {
      image = { url: absolute, resolved: false, status: response?.status() ?? null, bytes: null, width: null, height: null, format: null };
      problems.push({ tag: 'og:image', issue: `${absolute} returned ${response ? response.status() : 'no response'} — the card will render without a picture` });
    } else {
      const body = await response.body().catch(() => null);
      const info = body ? readImageInfo(body) : null;
      image = {
        url: absolute,
        resolved: true,
        status: response.status(),
        bytes: body?.length ?? null,
        width: info?.width ?? null,
        height: info?.height ?? null,
        format: info?.format ?? null,
      };
      if (info && body) {
        const ratio = info.width / Math.max(1, info.height);
        if (info.width < 600 || info.height < 300) problems.push({ tag: 'og:image', issue: `${info.width}×${info.height} is below the 600×315 minimum most clients require` });
        else if (Math.abs(ratio - 1200 / 630) > 0.18) {
          image.aspectWarning = `${info.width}×${info.height} (${Math.round(ratio * 100) / 100}:1) differs from the 1.91:1 link-card ratio; expect cropping or letterboxing`;
        }
        if (body.length > 1_000_000) problems.push({ tag: 'og:image', issue: `${humanBytes(body.length)} — some crawlers skip images over 1 MB` });
      }
    }
  }

  const verdict: MetadataAudit['verdict'] = missing.length > 0 || problems.some((p) => p.tag === 'og:image') ? (image && !image.resolved ? 'broken' : 'incomplete') : 'ok';
  const summary =
    verdict === 'ok'
      ? `Link preview metadata is complete: ${Object.keys(tags).filter((k) => k.startsWith('og:') || k.startsWith('twitter:')).length} tags, image ${image?.width}×${image?.height} ${image?.format}, ${humanBytes(image?.bytes ?? 0)}.`
      : `Link preview metadata is ${verdict}: ${missing.length ? `missing ${missing.map((m) => m.property ?? m.name).join(', ')}` : ''}${problems.length ? `${missing.length ? '; ' : ''}${problems.map((p) => `${p.tag}: ${p.issue}`).join(' | ')}` : ''}`;

  const fix =
    verdict === 'ok'
      ? undefined
      : [
          `Capture a real preview: \`lens preview --url ${new URL(page.url()).pathname} --kind social --title "<what the page does>"\``,
          'Paste the tags Lens printed into the page <head> (or the framework metadata export it suggested).',
          'Re-run `lens preview check` — it fetches og:image and verifies the bytes, not just the markup.',
        ].join('\n');

  return { url: page.url(), found: tags, missing, problems, image, verdict, summary, fix };
}

/**
 * Cheap, local framework read for placement advice. Only looks at config files, so
 * it never has to start or inspect the project's toolchain to give a hint.
 */
function detectFramework(root: string): string {
  const markers: Array<[RegExp, string]> = [
    [/^next\.config\./, 'next'],
    [/^nuxt\.config\./, 'nuxt'],
    [/^astro\.config\./, 'astro'],
    [/^svelte\.config\./, 'sveltekit'],
    [/^remix\.config\./, 'remix'],
    [/^vite\.config\./, 'vite'],
    [/^angular\.json$/, 'angular'],
    [/^package\.json$/, ''],
  ];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 'generic';
  }
  for (const [pattern, id] of markers) {
    if (id && entries.some((entry) => pattern.test(entry))) return id;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const [name, id] of [
      ['next', 'next'],
      ['astro', 'astro'],
      ['@angular/core', 'angular'],
      ['react', 'react'],
      ['vue', 'vue'],
      ['svelte', 'sveltekit'],
    ] as const) {
      if (deps?.[name]) return id;
    }
  } catch {
    /* no manifest */
  }
  return 'generic';
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return 'http://localhost';
  }
}

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function derivedSiteName(url: string | null): string {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|\[::1\])/.test(host)) return '';
    return host.split('.').slice(-2)[0] ?? host;
  } catch {
    return '';
  }
}

function clip(value: string, max: number): string {
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Copy a generated preview into a project's static directory when asked. */
export async function installPreview(session: LensSession, source: string, destination: string): Promise<{ path: string; bytes: number; overwritten: boolean }> {
  const root = session.config.root;
  const target = path.resolve(root, destination);
  if (!insideAny(target, [path.join(root, 'public'), path.join(root, 'static'), path.join(root, 'app'), path.join(root, 'src')])) {
    const { LensError, LensErrorCode } = await import('../errors.js');
    throw new LensError({
      code: LensErrorCode.SECURITY_PERMISSION_REQUIRED,
      message: 'Lens will not write outside public/, static/, app/ or src/ when installing a preview image.',
      scope: 'input',
      detail: `Refused: ${destination}`,
      hints: ['Pass a path inside one of those directories, e.g. --install public/og.png, or copy the file yourself.'],
    });
  }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const overwritten = fs.existsSync(target);
  await fs.promises.copyFile(source, target);
  return { path: target, bytes: fs.statSync(target).size, overwritten };
}

function insideAny(candidate: string, dirs: string[]): boolean {
  return dirs.some((dir) => candidate === dir || candidate.startsWith(`${dir}${path.sep}`));
}
