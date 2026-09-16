/**
 * The in-page layout probe.
 *
 * One `page.evaluate` collects raw geometry and style measurements; all judgement
 * happens in Node against configured thresholds. Keeping the browser side
 * measurement-only means thresholds are tunable, testable and reported in the
 * findings instead of being baked into injected script.
 *
 * Budgets (`limit`) bound what a pathological page can return.
 */

export interface ProbeInput {
  limit: number;
  overflowTolerancePx: number;
  minContrast: number;
  minContrastLargeText: number;
  minTapTargetPx: number;
  emptyAreaRatio: number;
  overlapSeverityAreaPx: number;
  minLineHeightRatio: number;
  ignoreSelectors: string[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverflowItem {
  selector: string;
  tag: string;
  box: Rect;
  overflowPx: number;
  position: string;
  text: string;
}

export interface ClipItem {
  selector: string;
  tag: string;
  box: Rect;
  clippedBy: number;
  overflow: 'x' | 'y' | 'both';
  text: string;
  fontSize: number;
  whiteSpace: string;
  textOverflow: string;
}

export interface ContrastItem {
  selector: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
  fontSize: number;
  bold: boolean;
  text: string;
  box: Rect;
  skipped: boolean;
}

export interface ImageItem {
  src: string;
  alt: string | null;
  box: Rect;
  naturalWidth: number;
  naturalHeight: number;
  complete: boolean;
  currentSrc: string;
  loading: string;
  role: string | null;
}

export interface TapItem {
  selector: string;
  role: string;
  name: string;
  box: Rect;
  smallest: number;
}

export interface OverlapItem {
  above: string;
  below: string;
  area: number;
  belowInteractive: boolean;
  abovePosition: string;
  zIndex: string;
}

export interface EmptyItem {
  region: Rect;
  ratio: number;
  largestGapY: number;
  contentBottom: number;
  viewportHeight: number;
}

export interface StyleItem {
  selector: string;
  text: string;
  box: Rect;
}

export interface LabelItem {
  selector: string;
  kind: string;
  name: string;
  hasLabel: boolean;
  box: Rect;
}

export interface ScrollItem {
  tag: string;
  overflow: string;
  height: string;
  position: string;
}

export interface PageProbeResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  document: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
  readyState: string;
  fontsStatus: string;
  stylesheets: { links: number; inline: number; rules: number; blocked: string[] };
  horizontalOverflow: boolean;
  verticalScroll: boolean;
  overflow: { items: OverflowItem[]; total: number };
  clipped: { items: ClipItem[]; total: number };
  contrast: { items: ContrastItem[]; checked: number; skipped: number; total: number };
  images: { items: ImageItem[]; total: number; broken: number; missingAlt: number; loading: number };
  tapTargets: { items: TapItem[]; total: number; checked: number };
  overlaps: { items: OverlapItem[]; total: number };
  empty: EmptyItem;
  focus: { removed: number; samples: StyleItem[]; hasOutlineNone: boolean };
  labels: { items: LabelItem[]; unlabeled: number };
  alts: { items: Array<{ selector: string; src: string; box: Rect }>; missingDecorative: number };
  scroll: { locked: ScrollItem | null };
  loadingStates: { spinners: number; skeletons: number; samples: StyleItem[] };
  density: Array<{ selector: string; text: string; lineHeight: number; fontSize: number; box: Rect }>;
  palette: { background: string; color: string; font: string };
  interactiveCount: number;
  hasAppRoot: boolean;
  appRootEmpty: boolean;
  visibleTextLength: number;
}

/**
 * Runs in the page. Must not close over anything from this module.
 */
export function pageProbe(input: ProbeInput): PageProbeResult {
  const limit = input.limit;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const de = document.documentElement;
  const body = document.body;

  const cssPath = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = [];
    let node: Element | null = element;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => !c.startsWith('__lens')).slice(0, 2);
      if (classes.length) part += `.${classes.join('.')}`;
      const parent: Element | null = node.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((c) => c.tagName === node!.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  const boxOf = (element: Element): Rect => {
    const r = element.getBoundingClientRect();
    return { x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) };
  };

  const textOf = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);

  const ignored = (element: Element): boolean => {
    if (element.closest('[data-lens-ignore]')) return true;
    if (element.id === '__lens_overlay') return true;
    for (const selector of input.ignoreSelectors) {
      try {
        if (selector && element.matches(selector)) return true;
      } catch {
        /* malformed selector in config: ignore it */
      }
    }
    return false;
  };

  /**
   * "Visually hidden" in the way accessible UIs mean it: skip links and live
   * regions that exist for screen readers but are clipped to nothing until focus.
   * They are real DOM and must not be judged as on-screen design.
   */
  const visuallyHidden = (element: Element, style: CSSStyleDeclaration): boolean => {
    const clipPath = style.clipPath ?? style.getPropertyValue('clip-path');
    if (clipPath && clipPath !== 'none' && /inset\(\s*(50%|100%)/.test(clipPath)) return true;
    const clip = style.clip ?? style.getPropertyValue('clip');
    if (clip && clip !== 'auto' && /rect\(\s*0px,?\s*0px,?\s*0px,?\s*0px\s*\)/.test(clip.replace(/\s+/g, ' '))) return true;
    const r = element.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) {
      // A 1px box that overflows invisibly is the standard .visually-hidden recipe.
      if (style.overflow === 'hidden' || style.overflowX === 'hidden' || r.width <= 1) return true;
    }
    return false;
  };

  const isVisible = (element: Element, style: CSSStyleDeclaration): boolean => {
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (style.opacity === '' && Number(style.getPropertyValue('opacity')) === 0) return false;
    const r = element.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) return false;
    return true;
  };

  const parseColor = (value: string): [number, number, number, number] | null => {
    if (!value || value === 'transparent' || value === 'none') return null;
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const parts = (m[1] ?? '').split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    const a = parts.length > 3 ? (parts[3] as number) : 1;
    if ([r, g, b].some((v) => v === undefined || Number.isNaN(v))) return null;
    return [r as number, g as number, b as number, a];
  };

  const luminance = (rgb: [number, number, number]): number => {
    const channel = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  };

  const contrastRatio = (fg: [number, number, number], bg: [number, number, number]): number => {
    const a = luminance(fg);
    const b = luminance(bg);
    const light = Math.max(a, b);
    const dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
  };

  const composite = (fg: [number, number, number, number], bg: [number, number, number, number]): [number, number, number, number] => {
    const alpha = fg[3];
    return [Math.round(fg[0] * alpha + bg[0] * (1 - alpha)), Math.round(fg[1] * alpha + bg[1] * (1 - alpha)), Math.round(fg[2] * alpha + bg[2] * (1 - alpha)), 1];
  };

  const effectiveBackground = (element: Element): { color: [number, number, number] | null; uncertain: boolean } => {
    let node: Element | null = element;
    let uncertain = false;
    const stack: Array<[number, number, number, number]> = [];
    let guard = 0;
    while (node && guard < 24) {
      guard += 1;
      const style = getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') uncertain = true;
      const bg = parseColor(style.backgroundColor);
      if (bg && bg[3] > 0) {
        stack.push(bg);
        if (bg[3] >= 0.999) break;
      }
      node = node.parentElement;
    }
    const base = parseColor(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    if (!stack.length) stack.push(base);
    let current: [number, number, number, number] = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i -= 1) current = composite(stack[i] as [number, number, number, number], current);
    return { color: [current[0], current[1], current[2]], uncertain };
  };

  const all = (selector: string): Element[] => {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  };

  const visibleElements = all('body *').filter((element) => {
    const style = getComputedStyle(element);
    return isVisible(element, style) && !ignored(element);
  });

  // --- horizontal overflow -------------------------------------------------
  const overflowItems: OverflowItem[] = [];
  let overflowTotal = 0;
  for (const element of visibleElements) {
    const r = element.getBoundingClientRect();
    if (r.width < 2) continue;
    const beyond = Math.max(r.right - vw - input.overflowTolerancePx, -r.left - input.overflowTolerancePx);
    if (beyond <= 0) continue;
    const style = getComputedStyle(element);
    // A full-bleed fixed banner is intentional; content wider than the viewport is not.
    if (style.position === 'fixed' && Math.abs(r.width - vw) < 2) continue;
    overflowTotal += 1;
    if (overflowItems.length < limit) {
      overflowItems.push({
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        box: boxOf(element),
        overflowPx: round2(beyond),
        position: style.position,
        text: textOf(element),
      });
    }
  }

  // --- clipped text ---------------------------------------------------------
  const clipItems: ClipItem[] = [];
  let clipTotal = 0;
  for (const element of visibleElements) {
    const style = getComputedStyle(element);
    const clipsX = element.scrollWidth - element.clientWidth > input.overflowTolerancePx;
    const clipsY = element.scrollHeight - element.clientHeight > input.overflowTolerancePx;
    if (!clipsX && !clipsY) continue;
    const overflowHidden = /hidden|clip/.test(style.overflowX + style.overflowY + style.overflow);
    if (!overflowHidden) continue;
    const hasText = [...element.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
    if (!hasText && element.children.length === 0) continue;
    if (!hasText) continue;
    clipTotal += 1;
    if (clipItems.length < limit) {
      clipItems.push({
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        box: boxOf(element),
        clippedBy: round2(Math.max(element.scrollWidth - element.clientWidth, element.scrollHeight - element.clientHeight)),
        overflow: clipsX && clipsY ? 'both' : clipsX ? 'x' : 'y',
        text: textOf(element),
        fontSize: Number.parseFloat(style.fontSize) || 0,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
      });
    }
  }

  // --- contrast -------------------------------------------------------------
  const contrastItems: ContrastItem[] = [];
  let contrastChecked = 0;
  let contrastSkipped = 0;
  let contrastTotal = 0;
  const textHosts = visibleElements.filter((element) =>
    [...element.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 1),
  );
  for (const element of textHosts.slice(0, 400)) {
    const style = getComputedStyle(element);
    const fg = parseColor(style.color);
    if (!fg) {
      contrastSkipped += 1;
      continue;
    }
    const bg = effectiveBackground(element);
    const size = Number.parseFloat(style.fontSize) || 16;
    const weight = Number(style.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? input.minContrastLargeText : input.minContrast;
    contrastChecked += 1;
    if (bg.uncertain || !bg.color) {
      contrastSkipped += 1;
      continue;
    }
    const ratio = contrastRatio([fg[0], fg[1], fg[2]], bg.color);
    if (ratio + 0.001 >= required) continue;
    contrastTotal += 1;
    if (contrastItems.length < limit) {
      contrastItems.push({
        selector: cssPath(element),
        ratio: round2(ratio),
        required,
        color: style.color,
        background: `rgb(${bg.color.join(',')})`,
        fontSize: round2(size),
        bold: weight >= 600,
        text: textOf(element),
        box: boxOf(element),
        skipped: false,
      });
    }
  }

  // --- images ---------------------------------------------------------------
  const imageItems: ImageItem[] = [];
  let broken = 0;
  let missingAlt = 0;
  let loadingImages = 0;
  const imgs = all('img');
  for (const element of imgs) {
    const img = element as HTMLImageElement;
    const isBroken = img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src) !== '';
    const noAlt = !img.hasAttribute('alt');
    if (isBroken) broken += 1;
    if (noAlt) missingAlt += 1;
    if (!img.complete && img.loading === 'lazy') loadingImages += 1;
    if ((isBroken || noAlt) && imageItems.length < limit) {
      imageItems.push({
        src: (img.currentSrc || img.src || '').slice(0, 220),
        alt: img.getAttribute('alt'),
        box: boxOf(img),
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        complete: img.complete,
        currentSrc: (img.currentSrc || '').slice(0, 120),
        loading: img.loading || 'eager',
        role: img.getAttribute('role'),
      });
    }
  }

  // --- tap targets ----------------------------------------------------------
  const interactiveSelector =
    'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="combobox"],summary,[tabindex]:not([tabindex="-1"])';
  const interactive = all(interactiveSelector).filter(
    (element) => isVisible(element, getComputedStyle(element)) && !visuallyHidden(element, getComputedStyle(element)) && !ignored(element),
  );
  const tapItems: TapItem[] = [];
  let tapTotal = 0;
  for (const element of interactive) {
    const box = element.getBoundingClientRect();
    const smallest = Math.min(box.width, box.height);
    if (smallest >= input.minTapTargetPx) continue;
    // Inline links inside a paragraph are text, not controls.
    const tag = element.tagName.toLowerCase();
    const isTextLink = tag === 'a' && getComputedStyle(element).display === 'inline' && box.height < 20;
    if (isTextLink) continue;
    tapTotal += 1;
    if (tapItems.length < limit) {
      tapItems.push({
        selector: cssPath(element),
        role: element.getAttribute('role') ?? (tag === 'a' ? 'link' : tag),
        name: (element.getAttribute('aria-label') ?? element.textContent ?? element.getAttribute('placeholder') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        box: boxOf(element),
        smallest: round2(smallest),
      });
    }
  }

  // --- overlap: sticky/fixed layers covering interactive content ------------
  const overlapItems: OverlapItem[] = [];
  let overlapTotal = 0;
  const layers = visibleElements
    .map((element) => ({ element, style: getComputedStyle(element), box: element.getBoundingClientRect() }))
    .filter(({ style }) => (style.position === 'fixed' || style.position === 'sticky') && style.pointerEvents !== 'none')
    .filter(({ box }) => box.width > 40 && box.height > 20);
  for (const layer of layers) {
    for (const element of interactive.slice(0, 250)) {
      // A sticky toolbar covering its own buttons is a toolbar, not an occlusion.
      if (layer.element === element || layer.element.contains(element)) continue;
      if (visuallyHidden(element, getComputedStyle(element))) continue;
      const b = element.getBoundingClientRect();
      const l = layer.box;
      const ox = Math.min(l.right, b.right) - Math.max(l.left, b.left);
      const oy = Math.min(l.bottom, b.bottom) - Math.max(l.top, b.top);
      if (ox <= 1 || oy <= 1) continue;
      const area = ox * oy;
      const centerInside = b.x + b.width / 2 >= l.left && b.x + b.width / 2 <= l.right && b.y + b.height / 2 >= l.top && b.y + b.height / 2 <= l.bottom;
      if (!centerInside && area < input.overlapSeverityAreaPx) continue;
      overlapTotal += 1;
      if (overlapItems.length < limit) {
        overlapItems.push({
          above: cssPath(layer.element),
          below: cssPath(element),
          area: round2(area),
          belowInteractive: true,
          abovePosition: layer.style.position,
          zIndex: layer.style.zIndex || 'auto',
        });
      }
    }
  }

  // --- empty space ----------------------------------------------------------
  let contentBottom = 0;
  let contentTop = vh;
  let contentLeft = vw;
  let contentRight = 0;
  for (const element of visibleElements) {
    const r = element.getBoundingClientRect();
    if (r.bottom < -50 || r.top > vh + 400) continue;
    if (r.width < 2 || r.height < 2) continue;
    contentBottom = Math.max(contentBottom, Math.min(r.bottom, Math.max(vh, document.documentElement.scrollHeight)));
    contentTop = Math.min(contentTop, r.top);
    contentLeft = Math.min(contentLeft, r.left);
    contentRight = Math.max(contentRight, r.right);
  }
  const usedHeight = Math.max(0, contentBottom - Math.max(0, contentTop));
  const ratio = vh > 0 ? Math.min(1, usedHeight / vh) : 1;
  const empty: EmptyItem = {
    region: { x: round2(Math.max(0, contentLeft)), y: round2(Math.max(0, contentTop)), width: round2(Math.max(0, contentRight - contentLeft)), height: round2(usedHeight) },
    ratio: round2(ratio),
    largestGapY: round2(Math.max(0, vh - contentBottom)),
    contentBottom: round2(contentBottom),
    viewportHeight: vh,
  };

  // --- focus indicators -----------------------------------------------------
  let outlineNoneRules = 0;
  const focusSamples: StyleItem[] = [];
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null;
    }
    if (!rules) continue;
    for (const rule of [...rules]) {
      const styleRule = rule as CSSStyleRule;
      const selectorText = typeof styleRule.selectorText === 'string' ? styleRule.selectorText : '';
      if (!selectorText.includes(':focus') && !selectorText.includes(':active')) continue;
      const decl = styleRule.style?.cssText ?? '';
      if (/outline\s*:\s*(none|0)/i.test(decl) && !/box-shadow|outline\s*:\s*[1-9]/i.test(decl)) {
        outlineNoneRules += 1;
        if (focusSamples.length < 6) {
          const host = document.querySelector(selectorText.replace(/:(focus|active)[^ ]*/g, ''));
          focusSamples.push({ selector: selectorText.slice(0, 120), text: decl.slice(0, 120), box: host ? boxOf(host) : { x: 0, y: 0, width: 0, height: 0 } });
        }
      }
    }
  }

  // --- labels / alts --------------------------------------------------------
  const labelItems: LabelItem[] = [];
  let unlabeled = 0;
  const fields = all('input:not([type="hidden"]),textarea,select,[contenteditable="true"]');
  for (const element of fields) {
    const id = element.getAttribute('id');
    const hasLabel =
      (id ? !!document.querySelector(`label[for="${CSS.escape(id)}"]`) : false) ||
      !!element.closest('label') ||
      !!element.getAttribute('aria-label') ||
      !!element.getAttribute('aria-labelledby') ||
      !!element.getAttribute('placeholder') ||
      !!element.getAttribute('title');
    if (hasLabel) continue;
    unlabeled += 1;
    if (labelItems.length < limit) {
      labelItems.push({
        selector: cssPath(element),
        kind: `${element.tagName.toLowerCase()}${element.getAttribute('type') ? `[type=${element.getAttribute('type')}]` : ''}`,
        name: (element.getAttribute('name') ?? '').slice(0, 40),
        hasLabel: false,
        box: boxOf(element),
      });
    }
  }

  const altItems: Array<{ selector: string; src: string; box: Rect }> = [];
  let missingDecorative = 0;
  for (const element of all('img')) {
    const img = element as HTMLImageElement;
    if (img.hasAttribute('alt')) continue;
    const r = img.getBoundingClientRect();
    const likelyDecorative = r.width <= 24 && r.height <= 24;
    if (likelyDecorative) {
      missingDecorative += 1;
      continue;
    }
    if (altItems.length < limit) altItems.push({ selector: cssPath(img), src: (img.currentSrc || img.src || '').slice(0, 160), box: boxOf(img) });
  }

  // --- scroll locking -------------------------------------------------------
  const htmlStyle = getComputedStyle(de);
  const bodyStyle = getComputedStyle(body ?? de);
  const scrollLocked = /hidden|clip/.test(htmlStyle.overflowY) && /hidden|clip/.test(bodyStyle.overflowY);
  const scroll: { locked: ScrollItem | null } = {
    locked: scrollLocked
      ? {
          tag: 'html+body',
          overflow: `${htmlStyle.overflowY}/${bodyStyle.overflowY}`,
          height: `${htmlStyle.height}|${bodyStyle.height}`,
          position: bodyStyle.position,
        }
      : null,
  };

  // --- loading / skeleton states still on screen ----------------------------
  const spinnerSelector = '[class*="spinner" i],[class*="loading" i],[role="progressbar"],[aria-busy="true"]';
  const skeletonSelector = '[class*="skeleton" i],[class*="placeholder" i],[data-loading="true"],[aria-busy="true"]';
  const spinners = all(spinnerSelector).filter((element) => isVisible(element, getComputedStyle(element))).length;
  const skeletons = all(skeletonSelector).filter((element) => isVisible(element, getComputedStyle(element))).length;
  const loadingSamples: StyleItem[] = all(spinnerSelector)
    .slice(0, 6)
    .map((element) => ({ selector: cssPath(element), text: element.getAttribute('aria-label') ?? textOf(element), box: boxOf(element) }));

  // --- text density ---------------------------------------------------------
  const density: PageProbeResult['density'] = [];
  for (const element of textHosts.slice(0, 200)) {
    const style = getComputedStyle(element);
    const fontSize = Number.parseFloat(style.fontSize) || 0;
    const lineHeight = Number.parseFloat(style.lineHeight) || 0;
    if (!fontSize || !lineHeight) continue;
    if (lineHeight / fontSize >= input.minLineHeightRatio) continue;
    if (density.length >= Math.min(limit, 12)) break;
    density.push({ selector: cssPath(element), text: textOf(element), lineHeight: round2(lineHeight), fontSize: round2(fontSize), box: boxOf(element) });
  }

  // --- stylesheets ----------------------------------------------------------
  let rules = 0;
  const blockedStylesheets: string[] = [];
  const links: number = all('link[rel="stylesheet"]').length;
  const inline: number = all('style').length;
  for (const sheet of [...document.styleSheets]) {
    if (sheet.ownerNode instanceof HTMLLinkElement && !(sheet as CSSStyleSheet).cssRules) {
      blockedStylesheets.push(sheet.href ?? (sheet.ownerNode as HTMLLinkElement).href ?? 'unknown');
      continue;
    }
    try {
      rules += (sheet as CSSStyleSheet).cssRules.length;
    } catch {
      blockedStylesheets.push(sheet.href ?? 'cross-origin');
    }
  }

  const appRoot = document.getElementById('root') || document.getElementById('app') || document.querySelector('[data-app-root]');
  const bodyText = (body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const paletteStyle = getComputedStyle(body ?? de);

  return {
    url: location.href,
    title: document.title,
    viewport: { width: vw, height: vh },
    document: {
      scrollWidth: de.scrollWidth,
      scrollHeight: de.scrollHeight,
      clientWidth: de.clientWidth,
      clientHeight: de.clientHeight,
    },
    readyState: document.readyState,
    fontsStatus: (document as Document & { fonts?: { status?: string } }).fonts?.status ?? 'unknown',
    stylesheets: { links, inline, rules, blocked: blockedStylesheets.slice(0, 5) },
    horizontalOverflow: de.scrollWidth > vw + input.overflowTolerancePx,
    verticalScroll: de.scrollHeight > vh + 2,
    overflow: { items: overflowItems, total: overflowTotal },
    clipped: { items: clipItems, total: clipTotal },
    contrast: { items: contrastItems, checked: contrastChecked, skipped: contrastSkipped, total: contrastTotal },
    images: { items: imageItems, total: imgs.length, broken, missingAlt, loading: loadingImages },
    tapTargets: { items: tapItems, total: tapTotal, checked: interactive.length },
    overlaps: { items: overlapItems, total: overlapTotal },
    empty,
    focus: { removed: outlineNoneRules, samples: focusSamples, hasOutlineNone: outlineNoneRules > 0 },
    labels: { items: labelItems, unlabeled },
    alts: { items: altItems, missingDecorative },
    scroll,
    loadingStates: { spinners, skeletons, samples: loadingSamples },
    density,
    palette: { background: paletteStyle.backgroundColor, color: paletteStyle.color, font: paletteStyle.fontFamily.slice(0, 60) },
    interactiveCount: interactive.length,
    hasAppRoot: !!appRoot,
    appRootEmpty: !!appRoot && (appRoot.children.length === 0 || (appRoot.textContent ?? '').trim().length === 0),
    visibleTextLength: bodyText.length,
  };

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
