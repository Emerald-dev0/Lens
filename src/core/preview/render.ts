/**
 * Preview image rendering.
 *
 * `lens preview` produces the image a link deserves: the actual product, framed for
 * the place it will be shown. The capture always comes from the running app; the
 * template only adds framing and type. If the app cannot be reached, the command
 * fails with the reason rather than producing a decorative placeholder.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedConfig } from '../config/load.js';
import type { LensSession } from '../session.js';
import { LensError, LensErrorCode } from '../errors.js';
import { ensureDir, humanBytes, safeName, writeJson } from '../util/fs.js';
import { readImageInfo } from '../capture/image-info.js';
import { log } from '../util/log.js';
import { buildPreviewHtml, PREVIEW_FORMATS, sizeFor, suggestTemplate, type PreviewFormat, type TemplateId } from './templates.js';
import { buildMetadataBlock, auditMetadata, type MetadataBlock, type MetadataAudit } from './metadata.js';

export interface PreviewRequest {
  /** What the image is for. Drives the default template and size. */
  kind?: 'product' | 'feature' | 'dashboard' | 'social' | 'documentation';
  format?: PreviewFormat;
  template?: TemplateId;
  /** Route or absolute URL to capture. Defaults to the session's current page. */
  url?: string;
  /** Capture one element instead of the page. */
  element?: string;
  /** Use an existing screenshot file instead of capturing. */
  file?: string;
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  bullets?: string[];
  footnote?: string;
  badge?: string;
  theme?: 'dark' | 'light' | 'brand';
  accent?: string;
  chrome?: boolean;
  /** 2 renders a second @2x export beside the primary file. */
  scale?: 1 | 2;
  width?: number;
  height?: number;
  output?: string;
  label?: string;
  /** Also emit the HTML meta-tag block and (for frameworks that want it) a manifest. */
  metadata?: boolean;
  /** Keep the raw app capture beside the composed plate. */
  keepCapture?: boolean;
}

export interface PreviewResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  format: PreviewFormat;
  template: TemplateId;
  kind: NonNullable<PreviewRequest['kind']>;
  sourceUrl: string | null;
  capturePath: string | null;
  retina?: { path: string; bytes: number; width: number; height: number };
  files: Array<{ path: string; role: string; bytes: number }>;
  metadata?: MetadataBlock;
  audit?: MetadataAudit;
  warnings: string[];
  summary: string;
}

export class PreviewService {
  constructor(
    private readonly session: LensSession,
    private readonly config: ResolvedConfig,
  ) {}

  async render(request: PreviewRequest = {}): Promise<PreviewResult> {
    const warnings: string[] = [];
    const kind = request.kind ?? 'product';
    const format: PreviewFormat = request.format ?? (kind === 'social' ? 'og' : kind === 'feature' ? 'feature' : 'og');
    const size = sizeFor(format, { width: request.width, height: request.height });
    const files: PreviewResult['files'] = [];

    // 1. Get the real capture.
    const capture = await this.capture(request, warnings);
    const info = readImageInfo(fs.readFileSync(capture.path));
    const shotAspect = info.width / Math.max(1, info.height);
    const template: TemplateId = request.template ?? suggestTemplate({ kind, bullets: request.bullets?.length, shotAspect });

    // 2. Compose the plate in the same browser so text renders like the product does.
    const html = buildPreviewHtml({
      template,
      size,
      title: request.title ?? (await this.defaultTitle(capture.url)),
      subtitle: request.subtitle,
      eyebrow: request.eyebrow ?? (kind === 'documentation' ? 'Documentation' : undefined),
      bullets: request.bullets,
      footnote: request.footnote,
      badge: request.badge ?? (capture.url ? hostOf(capture.url) : undefined),
      screenshot: `data:${capture.mime};base64,${capture.buffer.toString('base64')}`,
      theme: request.theme ?? this.config.preview.theme,
      accent: request.accent ?? this.config.preview.brand.accent,
      deviceScaleFactor: this.config.preview.deviceScaleFactor,
      chrome: request.chrome ?? (template !== 'bare' || this.config.preview.brand.style === 'device'),
      background: this.config.preview.brand.background,
      url: capture.url ?? undefined,
    });

    const target = request.output
      ? path.resolve(this.config.root, request.output)
      : path.join(this.config.artifactPath, this.config.preview.dir, `${safeName(request.label ?? `${kind}-${format}`, 'preview')}.png`);
    await ensureDir(path.dirname(target));

    const rendered = await this.renderHtml(html, size, this.config.preview.deviceScaleFactor);
    await fs.promises.writeFile(target, rendered);
    files.push({ path: rel(this.config, target), role: 'preview', bytes: rendered.length });

    let retina: PreviewResult['retina'];
    if ((request.scale ?? this.config.preview.retina) === 2) {
      const hi = await this.renderHtml(html, size, 2);
      const hiPath = target.replace(/\.png$/i, '@2x.png');
      await fs.promises.writeFile(hiPath, hi);
      retina = { path: hiPath, bytes: hi.length, width: size.width * 2, height: size.height * 2 };
      files.push({ path: rel(this.config, hiPath), role: 'preview@2x', bytes: hi.length });
    }

    if (request.keepCapture) {
      const keepPath = path.join(path.dirname(target), `${path.basename(target, '.png')}-capture.png`);
      await fs.promises.copyFile(capture.path, keepPath);
      files.push({ path: rel(this.config, keepPath), role: 'raw-capture', bytes: fs.statSync(keepPath).size });
    }

    const result: PreviewResult = {
      path: target,
      bytes: rendered.length,
      width: size.width,
      height: size.height,
      format,
      template,
      kind,
      sourceUrl: capture.url,
      capturePath: capture.path,
      retina,
      files,
      warnings,
      summary: `Preview ${size.width}×${size.height} ${path.basename(target)} (${humanBytes(rendered.length)}) from ${capture.url ?? 'capture'} — template "${template}".`,
    };

    if (request.metadata ?? this.config.preview.writeMetadata) {
      const meta = buildMetadataBlock({
        title: request.title ?? (await this.defaultTitle(capture.url)),
        description: request.subtitle ?? `A look at ${capture.url ?? 'the app'} as it actually renders.`,
        imagePath: target,
        url: capture.url,
        siteName: this.config.preview.brand.name,
        twitter: this.config.preview.twitter,
        size: { width: size.width, height: size.height },
      });
      const metaPath = target.replace(/\.png$/i, '.html');
      await fs.promises.writeFile(metaPath, `${meta.snippet}\n`, 'utf8');
      files.push({ path: rel(this.config, metaPath), role: 'meta-tags', bytes: fs.statSync(metaPath).size });
      await writeJson(target.replace(/\.png$/i, '.json'), { ...meta, image: { path: target, width: size.width, height: size.height, bytes: rendered.length } });
      result.metadata = meta;
      if (this.config.preview.verifyLive && capture.url) {
        result.audit = await this.audit(capture.url);
        if (result.audit.missing.length) warnings.push(`The live page is missing ${result.audit.missing.length} metadata tag(s): ${result.audit.missing.map((t) => t.property ?? t.name).join(', ')}.`);
      }
    }

    if (template === 'bare' && !request.title) warnings.push('Template "bare" reproduces the capture without a title; pass --title or choose --template hero/split.');
    if (shotAspect > 2.4 && template === 'split') warnings.push(`The capture is very wide (${Math.round(shotAspect * 100) / 100}:1); "plate" or "frame" usually reads better for it.`);

    return result;
  }

  /** Verify the metadata a real URL serves, including whether its image resolves. */
  async audit(url?: string): Promise<MetadataAudit> {
    const page = this.session.activePage.page;
    const target = url ?? page.url();
    return auditMetadata(this.session, target);
  }

  private async capture(request: PreviewRequest, warnings: string[]): Promise<{ path: string; buffer: Buffer; mime: string; url: string | null }> {
    if (request.file) {
      const file = path.resolve(this.config.root, request.file);
      if (!fs.existsSync(file)) {
        throw new LensError({
          code: LensErrorCode.FILE_NOT_FOUND,
          message: `The screenshot to turn into a preview does not exist: ${request.file}`,
          scope: 'input',
          hints: ['Omit --file to capture the live page instead: `lens preview --url /dashboard`.'],
        });
      }
      const buffer = fs.readFileSync(file);
      const info = readImageInfo(buffer);
      return { path: file, buffer, mime: info.format === 'jpeg' ? 'image/jpeg' : 'image/png', url: null };
    }

    if (request.url) {
      const opened = await this.session.open(request.url).catch((err: Error) => {
        throw new LensError({
          code: LensErrorCode.NAVIGATE_FAILED,
          message: `Lens could not open ${request.url} to build a preview.`,
          scope: 'application',
          detail: err instanceof LensError ? err.detail : err.message,
          hints: err instanceof LensError ? err.hints : ['Start the dev server, or pass --url with the port it is actually listening on.'],
        });
      });
      warnings.push(...(opened.policyNote ? [opened.policyNote] : []));
    } else if (!this.session.hasPage) {
      throw new LensError({
        code: LensErrorCode.NO_ACTIVE_PAGE,
        message: 'There is no page open to capture for the preview.',
        scope: 'input',
        hints: ['`lens open <url>` first, or pass `--url /route` — preview images are always built from the rendered app.'],
      });
    }

    const shot = await this.session.screenshot({
      label: `preview-source-${safeName(request.label ?? 'capture', 'capture')}`,
      scope: request.element ? 'element' : this.config.preview.captureFullPage ? 'full-page' : 'viewport',
      element: request.element,
      deviceScaleFactor: Math.max(1, this.config.preview.captureScale),
      format: 'png',
      hideOverlay: true,
      animations: 'disabled',
    });
    const absolute = path.resolve(this.config.root, shot.path);
    return {
      path: absolute,
      buffer: fs.readFileSync(absolute),
      mime: 'image/png',
      url: this.session.activePage.page.url(),
    };
  }

  private async renderHtml(html: string, size: { width: number; height: number }, deviceScaleFactor: number): Promise<Buffer> {
    const context = await this.session.pages.ensureContext();
    const page = await context.newPage();
    try {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' }).catch(() => {});
      await page.setContent(html, { waitUntil: 'load' });
      // Wait for the embedded capture and the font stack, then one paint.
      await page
        .waitForFunction(
          () =>
            Array.from(document.images).every((image) => image.complete) &&
            (document.fonts ? document.fonts.status === 'loaded' : true),
          undefined,
          { timeout: 8000 },
        )
        .catch(() => {});
      await page.evaluate(() => document.body.getBoundingClientRect()).catch(() => {});
      const buffer = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.width, height: size.height }, scale: deviceScaleFactor > 1 ? 'device' : 'css' });
      return buffer;
    } finally {
      await page.close().catch(() => {});
      log.debug('preview rendered', { width: size.width, height: size.height, deviceScaleFactor });
    }
  }

  private async defaultTitle(url: string | null): Promise<string> {
    if (this.session.hasPage) {
      const live = await this.session.activePage.page.title().catch(() => '');
      if (live) return clean(live);
    }
    if (url) return clean(hostOf(url));
    return this.config.preview.brand.tagline ?? 'The product, as it renders';
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[·|]\s*$/, '').trim().slice(0, 90);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

function rel(config: ResolvedConfig, file: string): string {
  const relative = path.relative(config.root, file);
  return relative.startsWith('..') ? file : `./${relative.split(path.sep).join('/')}`;
}

export const PREVIEW_SIZE_PRESETS = PREVIEW_FORMATS;
export type { MetadataAudit, MetadataBlock };
export { sizeFor, PREVIEW_FORMATS, TEMPLATE_IDS } from './templates.js';
export type { PreviewFormat, TemplateId } from './templates.js';
