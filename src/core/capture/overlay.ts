/**
 * Lens overlay layer.
 *
 * One fixed-position DOM root (`#__lens_overlay`) carries everything Lens draws on
 * top of the page: element highlights for annotated screenshots, demo banners,
 * action callouts and the synthesised cursor used in recordings.
 *
 * Two properties matter:
 *  - `pointer-events:none` — overlays never change what the app does.
 *  - `data-lens-ignore`     — reviewers skip overlay pixels, so Lens marking up a
 *    page can never make Lens flag its own markup as a layout problem.
 */
import type { Page } from 'playwright-core';

export interface BoxLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HighlightOptions {
  color?: string;
  label?: string;
  pulse?: boolean;
  fill?: boolean;
}

export interface BannerOptions {
  title?: string;
  subtitle?: string;
  eyebrow?: string;
  position?: 'top' | 'bottom';
  accent?: string;
  background?: string;
  foreground?: string;
  fontSizePx?: number;
  /** Auto-hide after N ms; omit to keep until cleared. */
  dwellMs?: number;
  /** Right-aligned progress label, e.g. `2 / 5`. */
  step?: string;
}

export interface CalloutOptions {
  at?: { x: number; y: number };
  accent?: string;
  background?: string;
  foreground?: string;
  fontSizePx?: number;
  dwellMs?: number;
  pointer?: boolean;
}

const STYLE = `
.__lens_root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
.__lens_box{position:absolute;box-sizing:border-box;border:2px solid var(--lens-accent,#38bdf8);border-radius:6px;
  box-shadow:0 0 0 9999em rgba(2,6,23,.001);}
.__lens_box.__lens_fill{background:color-mix(in srgb,var(--lens-accent,#38bdf8) 18%,transparent);}
.__lens_box.__lens_pulse{animation:__lens_pulse 900ms ease-out 2;}
.__lens_tag{position:absolute;transform:translateY(-100%);background:var(--lens-accent,#38bdf8);color:#04121f;
  font-size:13px;font-weight:650;line-height:1;padding:5px 8px;border-radius:5px 5px 0 0;white-space:nowrap;}
.__lens_banner{position:absolute;left:0;right:0;display:flex;align-items:center;gap:16px;
  padding:18px 28px;background:var(--lens-bg,rgba(11,18,32,.92));color:var(--lens-fg,#fff);
  border-top:3px solid var(--lens-accent,#38bdf8);backdrop-filter:blur(8px);}
.__lens_banner.top{top:0;border-top:0;border-bottom:3px solid var(--lens-accent,#38bdf8);}
.__lens_banner.bottom{bottom:0;}
.__lens_eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.72;font-weight:700;}
.__lens_title{font-size:22px;font-weight:700;line-height:1.2;}
.__lens_sub{font-size:15px;opacity:.82;line-height:1.35;margin-top:3px;}
.__lens_step{margin-left:auto;font-variant-numeric:tabular-nums;font-size:13px;opacity:.7;font-weight:700;}
.__lens_callout{position:absolute;max-width:min(46vw,460px);padding:10px 14px;border-radius:10px;
  background:var(--lens-bg,rgba(11,18,32,.94));color:var(--lens-fg,#fff);font-size:16px;font-weight:600;
  border:1px solid var(--lens-accent,#38bdf8);box-shadow:0 10px 30px rgba(2,6,23,.45);
  transform:translate(-50%,-140%);opacity:0;transition:opacity 180ms ease,transform 180ms ease;}
.__lens_callout.__lens_show{opacity:1;transform:translate(-50%,-100%);}
.__lens_callout.__lens_pointer::after{content:"";position:absolute;left:50%;bottom:-6px;width:10px;height:10px;
  margin-left:-5px;background:inherit;border-right:1px solid var(--lens-accent,#38bdf8);border-bottom:1px solid var(--lens-accent,#38bdf8);transform:rotate(45deg);}
.__lens_cursor{position:absolute;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;
  border:2px solid var(--lens-accent,#38bdf8);background:color-mix(in srgb,var(--lens-accent,#38bdf8) 26%,transparent);
  transition:transform 90ms ease-out,opacity 160ms ease;}
.__lens_cursor.__lens_down{transform:scale(.62);}
.__lens_ripple{position:absolute;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;
  border:2px solid var(--lens-accent,#38bdf8);opacity:.85;animation:__lens_ripple 620ms ease-out forwards;}
@keyframes __lens_ripple{from{transform:scale(.4);opacity:.9}to{transform:scale(1.5);opacity:0}}
@keyframes __lens_pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--lens-accent,#38bdf8) 55%,transparent)}100%{box-shadow:0 0 0 18px transparent}}
`;

export class OverlayLayer {
  private constructor(
    private readonly page: Page,
    private readonly rootId = '__lens_overlay',
  ) {}

  static async attach(page: Page): Promise<OverlayLayer> {
    const layer = new OverlayLayer(page);
    await layer.ensure();
    return layer;
  }

  private async ensure(): Promise<void> {
    await this.page
      .evaluate(
        ({ css, id }) => {
          if (!document.getElementById(id)) {
            const root = document.createElement('div');
            root.id = id;
            root.className = '__lens_root';
            root.setAttribute('data-lens-ignore', '');
            root.setAttribute('aria-hidden', 'true');
            (document.body ?? document.documentElement).appendChild(root);
          }
          if (!document.getElementById(`${id}-css`)) {
            const style = document.createElement('style');
            style.id = `${id}-css`;
            style.textContent = css;
            document.head.appendChild(style);
          }
        },
        { css: STYLE, id: this.rootId },
      )
      .catch(() => {});
  }

  /** Draw highlight boxes around elements. Returns a restore callback. */
  async highlight(boxes: BoxLike[], options: HighlightOptions = {}): Promise<() => Promise<void>> {
    await this.ensure();
    const ids: string[] = [];
    for (const box of boxes) {
      const id = `h${Math.random().toString(36).slice(2, 9)}`;
      ids.push(id);
      await this.page
        .evaluate(
          ({ id, box, options }) => {
            const root = document.getElementById('__lens_overlay');
            if (!root) return;
            const el = document.createElement('div');
            el.id = id;
            el.className = `__lens_box${options.fill ? ' __lens_fill' : ''}${options.pulse ? ' __lens_pulse' : ''}`;
            el.setAttribute('data-lens-ignore', '');
            el.style.cssText = `left:${box.x - 3}px;top:${box.y - 3}px;width:${box.width + 6}px;height:${box.height + 6}px;`;
            if (options.color) el.style.setProperty('--lens-accent', options.color);
            if (options.label) {
              const tag = document.createElement('div');
              tag.className = '__lens_tag';
              tag.style.cssText = `left:-2px;top:-2px;background:${options.color ?? '#38bdf8'}`;
              tag.textContent = options.label;
              el.appendChild(tag);
            }
            root.appendChild(el);
          },
          { id, box, options },
        )
        .catch(() => {});
    }
    return async () => {
      await this.remove(ids);
    };
  }

  /** Persistent banner used to narrate a demo. */
  async banner(options: BannerOptions = {}): Promise<void> {
    await this.ensure();
    await this.page
      .evaluate(
        ({ options }) => {
          const root = document.getElementById('__lens_overlay');
          if (!root) return;
          document.getElementById('__lens_banner')?.remove();
          const el = document.createElement('div');
          el.id = '__lens_banner';
          el.className = `__lens_banner ${options.position ?? 'bottom'}`;
          el.setAttribute('data-lens-ignore', '');
          const vars: string[] = [];
          if (options.accent) vars.push(`--lens-accent:${options.accent}`);
          if (options.background) vars.push(`--lens-bg:${options.background}`);
          if (options.foreground) vars.push(`--lens-fg:${options.foreground}`);
          if (options.fontSizePx) vars.push(`font-size:${options.fontSizePx}px`);
          el.style.cssText = vars.join(';');
          const parts: string[] = [];
          if (options.eyebrow) parts.push(`<div class="__lens_eyebrow">${escapeHtml(options.eyebrow)}</div>`);
          const inner: string[] = [];
          if (options.title) inner.push(`<div class="__lens_title">${escapeHtml(options.title)}</div>`);
          if (options.subtitle) inner.push(`<div class="__lens_sub">${escapeHtml(options.subtitle)}</div>`);
          if (parts.length || inner.length) {
            el.innerHTML = `${parts.join('')}<div>${inner.join('')}</div>${options.step ? `<div class="__lens_step">${escapeHtml(options.step)}</div>` : ''}`;
          }
          root.appendChild(el);
        },
        { options },
      )
      .catch(() => {});
  }

  /** Show a chapter/step label without replacing the banner text. */
  async bannerStep(label: string): Promise<void> {
    await this.page
      .evaluate((label) => {
        const root = document.getElementById('__lens_overlay');
        const banner = document.getElementById('__lens_banner');
        if (!root || !banner) return;
        let step = banner.querySelector('.__lens_step') as HTMLElement | null;
        if (!step) {
          step = document.createElement('div');
          step.className = '__lens_step';
          banner.appendChild(step);
        }
        step.textContent = label;
      }, label)
      .catch(() => {});
  }

  /** Floating action callout: "Create Project" near where it just happened. */
  async callout(text: string, options: CalloutOptions = {}): Promise<void> {
    await this.ensure();
    await this.page
      .evaluate(
        ({ text, options }) => {
          const root = document.getElementById('__lens_overlay');
          if (!root) return;
          document.getElementById('__lens_callout')?.remove();
          const el = document.createElement('div');
          el.id = '__lens_callout';
          el.className = `__lens_callout${options.pointer === false ? '' : ' __lens_pointer'}`;
          el.setAttribute('data-lens-ignore', '');
          const vars: string[] = [];
          if (options.accent) vars.push(`--lens-accent:${options.accent}`);
          if (options.background) vars.push(`--lens-bg:${options.background}`);
          if (options.foreground) vars.push(`--lens-fg:${options.foreground}`);
          if (options.fontSizePx) vars.push(`font-size:${options.fontSizePx}px`);
          el.style.cssText = vars.join(';');
          el.textContent = text;
          const at = options.at ?? { x: window.innerWidth / 2, y: Math.round(window.innerHeight * 0.72) };
          el.style.left = `${Math.max(140, Math.min(window.innerWidth - 140, at.x))}px`;
          el.style.top = `${Math.max(70, at.y)}px`;
          root.appendChild(el);
          requestAnimationFrame(() => el.classList.add('__lens_show'));
        },
        { text, options },
      )
      .catch(() => {});
  }

  /** Synthesised cursor + click ripple for recordings. */
  async cursor(position: { x: number; y: number } | null, pressed = false): Promise<void> {
    await this.ensure();
    await this.page
      .evaluate(
        ({ position, pressed }) => {
          const root = document.getElementById('__lens_overlay');
          if (!root) return;
          let el = document.getElementById('__lens_cursor') as HTMLElement | null;
          if (!position) {
            el?.remove();
            return;
          }
          if (!el) {
            el = document.createElement('div');
            el.id = '__lens_cursor';
            el.className = '__lens_cursor';
            el.setAttribute('data-lens-ignore', '');
            root.appendChild(el);
          }
          el.style.left = `${position.x}px`;
          el.style.top = `${position.y}px`;
          el.classList.toggle('__lens_down', pressed);
          if (pressed) {
            const ripple = document.createElement('div');
            ripple.className = '__lens_ripple';
            ripple.setAttribute('data-lens-ignore', '');
            ripple.style.left = `${position.x}px`;
            ripple.style.top = `${position.y}px`;
            root.appendChild(ripple);
            ripple.addEventListener('animationend', () => ripple.remove());
            setTimeout(() => ripple.remove(), 900);
          }
        },
        { position, pressed },
      )
      .catch(() => {});
  }

  private async remove(ids: string[]): Promise<void> {
    await this.page
      .evaluate((ids) => {
        for (const id of ids) document.getElementById(id)?.remove();
      }, ids)
      .catch(() => {});
  }

  async clear(): Promise<void> {
    await this.page
      .evaluate(() => {
        const root = document.getElementById('__lens_overlay');
        if (root) root.replaceChildren();
      })
      .catch(() => {});
  }

  /** Temporarily hide overlays (for clean baseline screenshots mid-demo). */
  async withHidden<T>(run: () => Promise<T>): Promise<T> {
    await this.setDisplay('none');
    try {
      return await run();
    } finally {
      await this.setDisplay('');
    }
  }

  private async setDisplay(value: string): Promise<void> {
    await this.page
      .evaluate((value) => {
        const root = document.getElementById('__lens_overlay');
        if (root) (root as HTMLElement).style.display = value;
      }, value)
      .catch(() => {});
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}
