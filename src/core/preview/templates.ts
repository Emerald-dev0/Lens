/**
 * Preview image templates.
 *
 * The rule that makes these worth generating: the product screenshot is always a
 * real capture of the running app. The template only frames it — typography,
 * scrim, device chrome, a caption. Nothing invents UI that does not exist, because
 * a marketing plate of a feature nobody built is worse than no image at all.
 *
 * Templates are HTML rendered by the same browser Lens uses for everything else,
 * so fonts, subpixel text and images behave exactly as a viewer expects.
 */
export type PreviewFormat = 'og' | 'square' | 'portrait' | 'feature' | 'custom';

export interface PreviewSize {
  width: number;
  height: number;
  label: string;
  /** Safe area padding as a fraction of width. */
  padding: number;
}

export const PREVIEW_FORMATS: Record<Exclude<PreviewFormat, 'custom'>, PreviewSize> = {
  og: { width: 1200, height: 630, label: 'Open Graph / link preview', padding: 0.055 },
  square: { width: 1200, height: 1200, label: 'Square social post', padding: 0.07 },
  portrait: { width: 1080, height: 1350, label: 'Portrait feed card', padding: 0.075 },
  feature: { width: 1600, height: 900, label: 'Feature card / docs hero', padding: 0.06 },
};

export function sizeFor(format: PreviewFormat, override?: { width?: number; height?: number }): PreviewSize {
  const base = format === 'custom' ? { ...PREVIEW_FORMATS.og, label: 'Custom size' } : PREVIEW_FORMATS[format];
  if (format === 'custom' || override?.width || override?.height) {
    return {
      width: override?.width ?? base.width,
      height: override?.height ?? base.height,
      label: `${override?.width ?? base.width}×${override?.height ?? base.height}`,
      padding: base.padding,
    };
  }
  return base;
}

export interface TemplateInput {
  template: TemplateId;
  size: PreviewSize;
  title: string;
  subtitle?: string;
  eyebrow?: string;
  bullets?: string[];
  footnote?: string;
  /** Data-URI of the real product screenshot. */
  screenshot: string;
  theme: 'dark' | 'light' | 'brand';
  /** Canvas colour, from brand config when provided. */
  background?: string;
  accent: string;
  /** Faint product-identity strip (route, version, repo) shown bottom-left. */
  badge?: string;
  deviceScaleFactor: number;
  /** Show a browser window frame around the capture. */
  chrome: boolean;
  /** Overlay the Lens annotation ring colour, used for callout arrows. */
  url?: string;
}

export type TemplateId = 'hero' | 'split' | 'frame' | 'plate' | 'bare';

/**
 * Build the HTML document for one preview image.
 *
 * `escapeHtml` is applied to every string that came from a config file or a page
 * title: preview templates are generated documents, and an app named `<img onerror>`
 * should not become an injection vector.
 */
export function buildPreviewHtml(input: TemplateInput): string {
  const { size, theme, accent } = input;
  const pad = Math.round(size.width * size.padding);
  const dark = theme !== 'light';
  const ink = dark ? '#f8fafc' : '#0f172a';
  const muted = dark ? 'rgba(226,232,240,0.72)' : 'rgba(15,23,42,0.66)';
  const surface = input.background ?? (dark ? '#0b1220' : '#ffffff');
  const panel = dark ? 'rgba(148,163,184,0.14)' : 'rgba(15,23,42,0.05)';
  const border = dark ? 'rgba(148,163,184,0.28)' : 'rgba(15,23,42,0.12)';
  const fontStack =
    "'Inter','Helvetica Neue',Helvetica,Arial,'Segoe UI',Roboto,'Noto Sans',system-ui,sans-serif";
  const mono = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace";

  const shot = `<img class="shot" src="${input.screenshot}" alt=""/>`;
  const framed = input.chrome
    ? `<div class="window"><div class="window__bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="window__url">${esc(input.url ?? '')}</span></div><div class="window__body">${shot}</div></div>`
    : shot;

  const bullets = input.bullets?.length
    ? `<ul class="bullets">${input.bullets.map((b) => `<li><span class="tick"></span>${esc(b)}</li>`).join('')}</ul>`
    : '';

  const eyebrow = input.eyebrow ? `<div class="eyebrow">${esc(input.eyebrow)}</div>` : '';
  const subtitle = input.subtitle ? `<p class="subtitle">${esc(input.subtitle)}</p>` : '';
  const badge = input.badge ? `<div class="badge">${esc(input.badge)}</div>` : '';
  const footnote = input.footnote ? `<div class="footnote">${esc(input.footnote)}</div>` : '';

  const headlineSize = Math.round(size.width * (input.template === 'split' ? 0.043 : size.width > 1300 ? 0.038 : 0.05));
  const titleBlock = `
      ${eyebrow}
      <h1 style="font-size:${headlineSize}px">${esc(input.title)}</h1>
      ${subtitle}
      ${bullets}`;

  const body =
    input.template === 'bare'
      ? `<div class="bare">${shot}${input.title ? `<div class="bare__caption">${esc(input.title)}</div>` : ''}</div>`
      : input.template === 'plate'
        ? `<div class="plate">
        <div class="plate__head">${titleBlock}</div>
        <div class="plate__shot">${framed}</div>
        <div class="plate__foot">${badge}${footnote}</div>
      </div>`
        : input.template === 'split'
          ? `<div class="split">
          <div class="split__text">${titleBlock}<div class="split__foot">${badge}</div></div>
          <div class="split__shot">${framed}</div>
        </div>`
          : input.template === 'frame'
            ? `<div class="frame">
            <div class="frame__shot">${framed}</div>
            <div class="frame__caption">
              <div class="frame__title">${esc(input.title)}</div>
              ${input.subtitle ? `<div class="frame__sub">${esc(input.subtitle)}</div>` : ''}
              ${badge}
            </div>
          </div>`
            : `<div class="hero">
        ${framed}
        <div class="hero__scrim"></div>
        <div class="hero__text">${titleBlock}</div>
        ${footnote}
      </div>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      html, body { width: ${size.width}px; height: ${size.height}px; overflow: hidden; }
      body {
        font-family: ${fontStack};
        color: ${ink};
        background: ${
          input.template === 'hero' || input.template === 'bare'
            ? surface
            : `radial-gradient(120% 90% at 12% 0%, ${dark ? '#13203a 0%' : '#f1f5f9 0%'}, ${surface} 62%)`
        };
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
      }
      .shell { position: relative; width: 100%; height: 100%; padding: ${pad}px; display: flex; }
      h1 { line-height: 1.08; letter-spacing: ${Math.round(-size.width * 0.00012)}px; font-weight: 700; }
      .eyebrow {
        font-size: ${Math.round(headlineSize * 0.31)}px; letter-spacing: 0.14em; text-transform: uppercase;
        font-weight: 650; color: ${accent}; margin-bottom: ${Math.round(pad * 0.32)}px;
      }
      .subtitle { margin-top: ${Math.round(pad * 0.36)}px; font-size: ${Math.round(headlineSize * 0.41)}px; line-height: 1.42; color: ${muted}; max-width: ${Math.round(size.width * (input.template === 'split' ? 0.42 : 0.72))}px; }
      .bullets { list-style: none; margin-top: ${Math.round(pad * 0.5)}px; display: grid; gap: ${Math.round(pad * 0.22)}px; }
      .bullets li { display: flex; align-items: center; gap: ${Math.round(pad * 0.24)}px; font-size: ${Math.round(headlineSize * 0.36)}px; color: ${muted}; }
      .tick { width: ${Math.round(headlineSize * 0.24)}px; height: ${Math.round(headlineSize * 0.24)}px; border-radius: 999px; background: ${accent}2e; border: ${Math.max(1, Math.round(headlineSize * 0.045))}px solid ${accent}; flex: 0 0 auto; }
      img.shot { display: block; width: 100%; height: auto; border-radius: ${Math.round(size.width * 0.006)}px; }
      .badge { font-family: ${mono}; font-size: ${Math.round(headlineSize * 0.26)}px; color: ${muted}; border: 1px solid ${border}; background: ${panel}; padding: ${Math.round(pad * 0.14)}px ${Math.round(pad * 0.26)}px; border-radius: 999px; white-space: nowrap; }
      .footnote { position: absolute; left: ${pad}px; bottom: ${Math.round(pad * 0.5)}px; font-size: ${Math.round(headlineSize * 0.25)}px; color: ${muted}; font-family: ${mono}; }

      .hero { position: relative; flex: 1; display: flex; align-items: flex-end; overflow: hidden; border-radius: ${Math.round(size.width * 0.008)}px; }
      .hero .window, .hero img.shot { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top center; }
      .hero__scrim { position: absolute; inset: 0; background: linear-gradient(to top, rgba(2,6,23,0.94) 0%, rgba(2,6,23,0.72) 32%, rgba(2,6,23,${dark ? 0.16 : 0.28}) 62%, rgba(2,6,23,0.04) 100%); }
      .hero__text { position: relative; padding: ${Math.round(pad * 0.9)}px; }
      .hero__text h1, .hero__text .subtitle { color: #f8fafc; }
      .hero__text .subtitle { color: rgba(226,232,240,0.8); }

      .split { flex: 1; display: grid; grid-template-columns: ${input.size.width > 1300 ? '42% 1fr' : '46% 1fr'}; gap: ${Math.round(pad * 0.9)}px; align-items: center; }
      .split__shot, .plate__shot, .frame__shot { position: relative; }
      .split__shot img.shot, .plate__shot img.shot, .frame__shot img.shot { box-shadow: 0 ${Math.round(pad * 0.5)}px ${Math.round(pad * 1.4)}px rgba(2,6,23,0.32); border: 1px solid ${border}; }
      .split__foot { margin-top: ${Math.round(pad * 0.7)}px; }

      .plate { flex: 1; display: grid; grid-template-rows: auto 1fr auto; gap: ${Math.round(pad * 0.55)}px; align-items: center; }
      .plate__shot { display: flex; justify-content: center; min-height: 0; }
      .plate__shot img.shot { max-height: 100%; width: auto; max-width: 100%; object-fit: contain; }
      .plate__foot { display: flex; justify-content: space-between; align-items: center; }

      .frame { flex: 1; display: grid; grid-template-rows: 1fr auto; gap: ${Math.round(pad * 0.5)}px; align-items: center; }
      .frame__shot { min-height: 0; display: flex; justify-content: center; }
      .frame__shot img.shot { max-height: 100%; width: auto; max-width: 100%; }
      .frame__caption { display: flex; align-items: center; gap: ${Math.round(pad * 0.4)}px; }
      .frame__title { font-size: ${Math.round(headlineSize * 0.62)}px; font-weight: 650; }
      .frame__sub { font-size: ${Math.round(headlineSize * 0.36)}px; color: ${muted}; }

      .bare { position: relative; flex: 1; }
      .bare img.shot { width: 100%; height: 100%; object-fit: cover; object-position: top center; }
      .bare__caption { position: absolute; left: ${Math.round(pad * 0.6)}px; bottom: ${Math.round(pad * 0.6)}px; background: rgba(2,6,23,0.78); color: #fff; padding: ${Math.round(pad * 0.22)}px ${Math.round(pad * 0.4)}px; border-radius: 8px; font-size: ${Math.round(headlineSize * 0.34)}px; }

      .window { border-radius: ${Math.round(size.width * 0.008)}px; overflow: hidden; border: 1px solid ${border}; background: ${surface}; box-shadow: 0 ${Math.round(pad * 0.5)}px ${Math.round(pad * 1.5)}px rgba(2,6,23,0.36); }
      .window__bar { display: flex; align-items: center; gap: ${Math.round(pad * 0.16)}px; height: ${Math.round(size.height * 0.055)}px; padding: 0 ${Math.round(pad * 0.4)}px; background: ${dark ? 'rgba(30,41,59,0.92)' : 'rgba(241,245,249,0.96)'}; border-bottom: 1px solid ${border}; }
      .window__bar .dot { width: ${Math.round(size.height * 0.012)}px; height: ${Math.round(size.height * 0.012)}px; border-radius: 999px; background: ${dark ? 'rgba(148,163,184,0.5)' : 'rgba(15,23,42,0.24)'}; }
      .window__url { margin-left: ${Math.round(pad * 0.3)}px; font-family: ${mono}; font-size: ${Math.round(size.height * 0.019)}px; color: ${muted}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .window__body img.shot { border-radius: 0; border: 0; }
      ${input.template === 'hero' || input.template === 'bare' ? '.window { position: absolute; inset: 0; } .window__body { height: calc(100% - ' + Math.round(size.height * 0.055) + 'px); } .window__body img.shot { height: 100%; object-fit: cover; }' : ''}
      ${input.theme === 'brand' ? `body::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(160deg, ${accent}1f 0%, transparent 42%, ${accent}14 100%); }` : ''}
    </style>
  </head>
  <body><div class="shell">${body}</div></body>
</html>`;
}

export function esc(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const TEMPLATE_IDS: TemplateId[] = ['hero', 'split', 'frame', 'plate', 'bare'];

export function suggestTemplate(hint: { kind?: string; bullets?: number; shotAspect?: number }): TemplateId {
  if (hint.kind === 'social' || hint.kind === 'docs') return hint.bullets ? 'split' : 'hero';
  if (hint.kind === 'feature') return 'plate';
  if (hint.kind === 'dashboard') return 'frame';
  if (hint.kind === 'product') return 'hero';
  if (hint.shotAspect && hint.shotAspect > 1.9) return 'frame';
  return 'split';
}
