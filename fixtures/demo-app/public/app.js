/**
 * Harbor — the demo application shipped with Lens.
 *
 * Deliberately dependency-free so `lens` can boot it anywhere. It models a small
 * SaaS: signup → dashboard → create project → add records → analytics. That gives
 * an agent a real multi-step journey to practise on, plus genuine loading, empty
 * and error states for visual review to find.
 *
 * `?defects=1` turns on a "known-bad" mode used by Lens's own test suite: it
 * injects an overflowing row, clipped text, a low-contrast label and a broken
 * image so the reviewer has something deterministic to catch.
 */

const store = {
  key: 'harbor.v1',
  read() {
    try {
      return JSON.parse(localStorage.getItem(this.key) ?? '{}');
    } catch {
      return {};
    }
  },
  write(next) {
    localStorage.setItem(this.key, JSON.stringify(next));
    render();
  },
  reset() {
    localStorage.removeItem(this.key);
    render();
  },
};

const state = Object.assign(
  {
    account: null,
    projects: [],
    plan: 'Pro',
    theme: 'dark',
    activity: [],
  },
  store.read(),
);

const DEFECTS = new URLSearchParams(location.search).get('defects') === '1';
const el = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

function save() {
  store.write(state);
}

function logActivity(kind, message) {
  state.activity = [{ kind, message, at: new Date().toISOString() }, ...(state.activity ?? [])].slice(0, 40);
}

/* ------------------------------------------------------------------ toasts */

let toastSeq = 0;
function toast(message, tone = 'info') {
  const node = document.createElement('div');
  node.className = `toast toast--${tone}`;
  node.dataset.lensToast = String(++toastSeq);
  node.textContent = message;
  el('toasts').appendChild(node);
  setTimeout(() => {
    node.classList.add('toast--out');
    setTimeout(() => node.remove(), 240);
  }, 2600);
}

/* ------------------------------------------------------------------- modal */

function openModal(title, bodyHtml, onMount) {
  const modal = el('modal');
  modal.hidden = false;
  modal.querySelector('.modal__body').innerHTML = `
    <header class="modal__header">
      <h2 id="modal-title">${esc(title)}</h2>
      <button class="icon-btn" type="button" data-action="close-modal" aria-label="Close dialog">✕</button>
    </header>
    <div class="modal__content">${bodyHtml}</div>`;
  document.body.classList.add('modal-open');
  const firstField = modal.querySelector('input, select, textarea, button:not([data-action])');
  setTimeout(() => (firstField ?? modal.querySelector('[data-action="close-modal"]'))?.focus(), 30);
  onMount?.(modal);
}

function closeModal() {
  const modal = el('modal');
  modal.hidden = true;
  modal.querySelector('.modal__body').innerHTML = '';
  document.body.classList.remove('modal-open');
}

/* ------------------------------------------------------------------- views */

function landingView() {
  return `
  <section class="hero">
    <div class="hero__copy">
      <p class="eyebrow">Customer operations</p>
      <h1>Every account, every ticket,<br />one calm workspace.</h1>
      <p class="lede">
        Harbor keeps customer records, project work and usage analytics together so your team
        stops rebuilding the same context every week.
      </p>
      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="#/signup" data-testid="hero-cta">Create your free account</a>
        <a class="btn btn--ghost btn--lg" href="#/dashboard" data-testid="hero-demo">Open the demo dashboard</a>
      </div>
      <ul class="hero__proof" aria-label="Facts">
        <li><strong>14-day</strong> trial</li>
        <li><strong>No card</strong> required</li>
        <li><strong>SOC&nbsp;2</strong> ready</li>
      </ul>
    </div>
    <div class="hero__panel" aria-hidden="true">
      <div class="panel">
        <div class="panel__bar"><span></span><span></span><span></span></div>
        <div class="panel__body">
          <p class="panel__label">Live usage</p>
          <div class="sparkline" data-chart="hero">
            ${[38, 52, 47, 66, 74, 61, 88, 79, 95, 84, 102, 118]
              .map((v) => `<span style="--h:${Math.min(100, v * 0.8)}%"></span>`)
              .join('')}
          </div>
          <dl class="panel__stats">
            <div><dt>Accounts</dt><dd>1,284</dd></div>
            <div><dt>Open tickets</dt><dd>37</dd></div>
            <div><dt>Median reply</dt><dd>1h 12m</dd></div>
          </dl>
        </div>
      </div>
    </div>
  </section>

  <section class="features" aria-labelledby="features-title">
    <h2 id="features-title">Built for the work between the tickets</h2>
    <div class="features__grid">
      ${[
        ['Customer records', 'One timeline per account: contracts, notes, usage and support history in a single view.'],
        ['Project work', 'Turn a request into tracked work without opening a second tool.'],
        ['Usage analytics', 'Product usage attached to the account that generated it, not a disconnected dashboard.'],
        ['Shared templates', 'Save the shape of a good response; let the team reuse it.'],
      ]
        .map(
          ([title, copy]) => `<article class="card">
          <h3>${esc(title)}</h3>
          <p>${esc(copy)}</p>
          <a class="card__link" href="#/docs">Learn more<span aria-hidden="true"> →</span></a>
        </article>`,
        )
        .join('')}
    </div>
  </section>

  <section class="quote">
    <blockquote>
      <p>“We deleted three dashboards and a spreadsheet after switching. Nobody missed them.”</p>
      <footer>— Priya Raman, Head of Customer Ops</footer>
    </blockquote>
  </section>

  <section class="cta-band">
    <div>
      <h2>Start with the data you already have.</h2>
      <p>Import a CSV, invite your team, and see the first dashboard the same afternoon.</p>
    </div>
    <a class="btn btn--primary btn--lg" href="#/signup">Create account</a>
  </section>`;
}

function signupView() {
  if (state.account) {
    return `
    <section class="panel-block">
      <h1>You are signed in</h1>
      <p>Demo account <strong>${esc(state.account.name)}</strong> (${esc(state.account.email)}) on the ${esc(state.account.plan)} plan.</p>
      <div class="row"><a class="btn btn--primary" href="#/dashboard">Open dashboard</a>
      <button class="btn btn--ghost" data-action="sign-out" type="button">Sign out of demo</button></div>
    </section>`;
  }
  return `
  <section class="auth">
    <div class="auth__aside">
      <h1>Create your Harbor account</h1>
      <p>Tell us who is using the workspace. Everything stays in this browser tab — no data leaves the page.</p>
      <ul class="checklist">
        <li>Unlimited read-only viewers</li>
        <li>Project work tracking</li>
        <li>Usage analytics with 30-day history</li>
      </ul>
    </div>
    <form class="form" data-form="signup" novalidate>
      <h2 class="visually-hidden">Account details</h2>
      <label class="field">
        <span class="field__label">Your name</span>
        <input name="name" autocomplete="name" placeholder="Alex Rivera" required data-testid="field-name" />
        <output class="field__error" data-error="name"></output>
      </label>
      <label class="field">
        <span class="field__label">Work email</span>
        <input name="email" type="email" autocomplete="email" placeholder="alex@acme.com" required data-testid="field-email" />
        <output class="field__error" data-error="email"></output>
      </label>
      <label class="field">
        <span class="field__label">Company</span>
        <input name="company" autocomplete="organization" placeholder="Acme Corporation" required data-testid="field-company" />
        <output class="field__error" data-error="company"></output>
      </label>
      <label class="field">
        <span class="field__label">Team size</span>
        <select name="teamSize">
          <option>1–5</option>
          <option selected>6–25</option>
          <option>26–100</option>
          <option>100+</option>
        </select>
      </label>
      <fieldset class="field field--radio">
        <legend>Plan</legend>
        <label class="radio"><input type="radio" name="plan" value="Starter" /> <span>Starter · $0</span></label>
        <label class="radio"><input type="radio" name="plan" value="Pro" checked /> <span>Pro · $49/mo</span></label>
        <label class="radio"><input type="radio" name="plan" value="Scale" /> <span>Scale · $199/mo</span></label>
      </fieldset>
      <label class="field">
        <span class="field__label">Password</span>
        <input name="password" type="password" autocomplete="new-password" placeholder="At least 10 characters" required minlength="10" data-testid="field-password" />
        <output class="field__error" data-error="password"></output>
      </label>
      <label class="checkbox">
        <input type="checkbox" name="terms" required />
        <span>I understand this is a local demo and nothing is transmitted.</span>
      </label>
      <div class="form__actions">
        <button class="btn btn--primary btn--lg" type="submit" data-testid="submit-signup">Create account</button>
        <span class="form__note" data-form-note></span>
      </div>
    </form>
  </section>`;
}

function dashboardView() {
  if (!state.account) {
    return `
    <section class="panel-block">
      <h1>Dashboard</h1>
      ${DEFECTS ? `<p class="muted">Defect mode is on: this row is <span class="defect-overflow">a very long unbreakable string that overflows its container: ${'supercalifragilisticexpialidocious'.repeat(3)}</span></p>` : ''}
      <p>The demo dashboard needs an account so the journey matches a real product.</p>
      <div class="row">
        <a class="btn btn--primary" href="#/signup" data-testid="gate-signup">Create account</a>
        <button class="btn btn--ghost" type="button" data-action="quick-account" data-testid="quick-account">Create a demo account for me</button>
      </div>
    </section>`;
  }

  const open = state.projects.filter((p) => p.status !== 'archived');
  const totalRecords = state.projects.reduce((sum, p) => sum + (p.records?.length ?? 0), 0);

  return `
  <section class="dash">
    <header class="dash__head">
      <div>
        <p class="eyebrow">${esc(state.account.company)} · ${esc(state.account.plan)} plan</p>
        <h1>Good to see you, ${esc(state.account.name.split(' ')[0])}.</h1>
      </div>
      <div class="row">
        <button class="btn btn--ghost" type="button" data-action="reset-demo">Reset demo data</button>
        <button class="btn btn--primary" type="button" data-action="new-project" data-testid="new-project">New project</button>
      </div>
    </header>

    <div class="stats">
      ${[
        ['Active projects', open.length, `${state.projects.length} total`],
        ['Customer records', totalRecords, 'across all projects'],
        ['First reply', '1h 12m', 'median this week'],
        ['Plan usage', '62%', 'of Pro seats'],
      ]
        .map(
          ([label, value, note]) => `<article class="stat">
            <p class="stat__label">${esc(label)}</p>
            <p class="stat__value" data-testid="stat-value">${esc(value)}</p>
            <p class="stat__note">${esc(note)}</p>
          </article>`,
        )
        .join('')}
    </div>

    <section class="split">
      <div class="split__main">
        <h2>Projects</h2>
        ${
          state.projects.length === 0
            ? `<div class="empty" data-testid="empty-projects">
                 <h3>No projects yet</h3>
                 <p>Projects group customer records, notes and usage. Create the first one to see how Harbor lays them out.</p>
                 <button class="btn btn--primary" type="button" data-action="new-project" data-testid="empty-new-project">Create your first project</button>
               </div>`
            : `<table class="table" data-testid="projects-table">
                 <thead>
                   <tr><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Records</th><th scope="col">Updated</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr>
                 </thead>
                 <tbody>
                   ${state.projects
                     .map(
                       (project) => `<tr data-project-row="${esc(project.id)}">
                         <th scope="row"><a href="#/projects/${esc(project.id)}">${esc(project.name)}</a></th>
                         <td><span class="pill pill--${esc(project.status)}">${esc(project.status)}</span></td>
                         <td>${project.records?.length ?? 0}</td>
                         <td>${esc(relativeTime(project.updatedAt ?? project.createdAt))}</td>
                         <td class="row-actions">
                           <button class="btn btn--tiny" type="button" data-action="open-project" data-id="${esc(project.id)}">Open</button>
                           <button class="btn btn--tiny btn--ghost" type="button" data-action="archive-project" data-id="${esc(project.id)}">Archive</button>
                         </td>
                       </tr>`,
                     )
                     .join('')}
                 </tbody>
               </table>`
        }
        ${DEFECTS ? `<div class="defect-clip" title="This paragraph is deliberately clipped by a fixed height">Text in this card is cut off on purpose so the Lens reviewer has a deterministic clipping defect to report in the demo application when run with defects enabled.</div>` : ''}
      </div>
      <aside class="split__side">
        <h2>Recent activity</h2>
        <ol class="activity">
          ${
            (state.activity ?? []).length === 0
              ? '<li class="activity__empty">Nothing recorded yet. Create a project to start the trail.</li>'
              : state.activity
                  .slice(0, 6)
                  .map((entry) => `<li><span class="activity__dot" data-kind="${esc(entry.kind)}"></span><p>${esc(entry.message)}<time datetime="${esc(entry.at)}">${esc(relativeTime(entry.at))}</time></p></li>`)
                  .join('')
          }
        </ol>
        ${DEFECTS ? '<img class="defect-img" src="/does-not-exist.png" alt="" width="120" height="80" />' : ''}
      </aside>
    </section>
  </section>`;
}

function projectView(id) {
  const project = state.projects.find((p) => p.id === id);
  if (!project) {
    return `<section class="panel-block"><h1>Project not found</h1><p>No project with id <code>${esc(id)}</code> exists in this browser.</p><a class="btn btn--primary" href="#/dashboard">Back to dashboard</a></section>`;
  }
  const tab = location.hash.includes('?tab=data') ? 'data' : location.hash.includes('?tab=analytics') ? 'analytics' : 'overview';
  return `
  <section class="project">
    <header class="project__head">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/dashboard">Dashboard</a> <span aria-hidden="true">/</span> <strong>${esc(project.name)}</strong></nav>
      <div class="row row--between">
        <div>
          <h1>${esc(project.name)}</h1>
          <p class="muted">${esc(project.description || 'No description yet.')}</p>
        </div>
        <span class="pill pill--${esc(project.status)}">${esc(project.status)}</span>
      </div>
    </header>

    <div class="tabs" role="tablist" aria-label="Project sections">
      ${['overview', 'data', 'analytics']
        .map(
          (name) =>
            `<button class="tab${name === tab ? ' tab--active' : ''}" role="tab" aria-selected="${name === tab}" type="button" data-action="project-tab" data-tab="${name}" data-id="${esc(project.id)}">${name[0].toUpperCase()}${name.slice(1)}</button>`,
        )
        .join('')}
    </div>

    <div class="tabpanel" data-testid="project-tabpanel">
      ${tab === 'overview' ? projectOverview(project) : tab === 'data' ? projectData(project) : projectAnalytics(project)}
    </div>
  </section>`;
}

function projectOverview(project) {
  return `
  <div class="overview">
    <section class="panel">
      <h2>What this project is for</h2>
      <p>${esc(project.description || 'Add a description so teammates know what they are looking at.')}</p>
      <label class="field">
        <span class="field__label">Description</span>
        <textarea name="description" rows="3" data-testid="project-description" placeholder="e.g. Onboarding for the 40 Acme accounts migrating in March">${esc(project.description ?? '')}</textarea>
      </label>
      <div class="row"><button class="btn btn--primary" type="button" data-action="save-description" data-id="${esc(project.id)}">Save description</button></div>
    </section>
    <section class="panel">
      <h2>Customer records</h2>
      <p class="muted">${project.records?.length ?? 0} record(s) in this project.</p>
      <button class="btn btn--ghost" type="button" data-action="project-tab" data-tab="data" data-id="${esc(project.id)}">Add a record</button>
    </section>
  </div>`;
}

function projectData(project) {
  const records = project.records ?? [];
  return `
  <form class="record-form" data-form="record">
    <label class="field field--grow">
      <span class="field__label">Customer</span>
      <input name="customer" placeholder="Acme Corporation" required data-testid="field-customer" />
    </label>
    <label class="field">
      <span class="field__label">Plan</span>
      <select name="plan"><option>Pro</option><option>Starter</option><option>Scale</option><option>Enterprise</option></select>
    </label>
    <label class="field">
      <span class="field__label">Status</span>
      <select name="status"><option>Active</option><option>Onboarding</option><option>At risk</option><option>Churned</option></select>
    </label>
    <label class="field field--grow">
      <span class="field__label">Note</span>
      <input name="note" placeholder="Migrating from the legacy exporter" />
    </label>
    <button class="btn btn--primary" type="submit" data-testid="add-record">Add record</button>
  </form>
  ${
    records.length === 0
      ? `<div class="empty" data-testid="empty-records"><h3>No records yet</h3><p>Add the first customer record above — the analytics tab reads from this list.</p></div>`
      : `<table class="table">
          <thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col">Note</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
          <tbody>
            ${records
              .map(
                (record, index) => `<tr>
                  <th scope="row">${esc(record.customer)}</th>
                  <td>${esc(record.plan)}</td>
                  <td><span class="pill pill--${esc(record.status.toLowerCase().replace(/\s+/g, '-'))}">${esc(record.status)}</span></td>
                  <td class="note-cell">${esc(record.note ?? '')}</td>
                  <td><button class="btn btn--tiny btn--ghost" type="button" data-action="remove-record" data-id="${esc(project.id)}" data-index="${index}">Remove</button></td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>`
  }`;
}

let metricsAbort = null;

async function projectAnalytics(project) {
  // Rendering is synchronous; the chart fills in when the request lands so the
  // loading state is real and observable.
  queueMicrotask(async () => {
    const host = document.querySelector('[data-testid="chart"]');
    if (!host) return;
    host.innerHTML = '<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading usage…</div>';
    metricsAbort?.abort();
    metricsAbort = new AbortController();
    try {
      const response = await fetch('/api/metrics?range=30d', { signal: metricsAbort.signal });
      if (!response.ok) throw new Error(`metrics endpoint returned ${response.status}`);
      const payload = await response.json();
      const target = document.querySelector('[data-testid="chart"]');
      if (!target) return;
      const max = Math.max(...payload.series.map((s) => s.value), 1);
      target.innerHTML = `<div class="bars">${payload.series
        .map((point) => `<div class="bar" style="--h:${Math.round((point.value / max) * 100)}%" title="${esc(point.label)}: ${point.value}"><span>${esc(point.label)}</span></div>`)
        .join('')}</div><p class="muted">${payload.series.length} days of activity, peak ${Math.max(...payload.series.map((s) => s.value))} events.</p>`;
      target.dataset.state = 'ready';
    } catch (error) {
      const target = document.querySelector('[data-testid="chart"]');
      if (!target) return;
      target.dataset.state = 'error';
      target.innerHTML = `<div class="error-state"><h3>Analytics unavailable</h3><p>${esc(error.message)}</p><button class="btn btn--ghost" type="button" data-action="retry-analytics">Try again</button></div>`;
    }
  });

  return `
  <section class="analytics">
    <h2>Usage in this project</h2>
    <div data-testid="chart" data-state="pending"><div class="loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading usage…</div></div>
    <dl class="totals">
      <div><dt>Records</dt><dd>${project.records?.length ?? 0}</dd></div>
      <div><dt>Active customers</dt><dd>${(project.records ?? []).filter((r) => r.status === 'Active').length}</dd></div>
      <div><dt>At risk</dt><dd>${(project.records ?? []).filter((r) => r.status === 'At risk').length}</dd></div>
    </dl>
  </section>`;
}

function settingsView() {
  return `
  <section class="settings">
    <h1>Workspace settings</h1>
    <div class="setting">
      <div><h2>Appearance</h2><p class="muted">Theme applies to this demo immediately.</p></div>
      <div class="segmented" role="group" aria-label="Theme">
        <button class="btn btn--tiny${state.theme === 'dark' ? ' btn--active' : ''}" type="button" data-action="theme" data-theme="dark">Dark</button>
        <button class="btn btn--tiny${state.theme === 'light' ? ' btn--active' : ''}" type="button" data-action="theme" data-theme="light">Light</button>
      </div>
    </div>
    <div class="setting">
      <div><h2>Plan</h2><p class="muted">Current plan: <strong>${esc(state.account?.plan ?? 'none')}</strong></p></div>
      <button class="btn btn--ghost" type="button" data-action="change-plan">Change plan</button>
    </div>
    <div class="setting setting--danger">
      <div><h2>Danger zone</h2><p class="muted">Deleting clears every project and record stored in this browser.</p></div>
      <button class="btn btn--danger" type="button" data-action="danger-reset">Delete demo data</button>
    </div>
  </section>`;
}

function pricingView() {
  const tiers = [
    ['Starter', '$0', 'For one person trying the idea out', ['3 projects', '500 records', 'Email support']],
    ['Pro', '$49', 'The everyday plan for a small team', ['Unlimited projects', '25,000 records', 'Usage analytics', 'Shared templates']],
    ['Scale', '$199', 'For ops teams with SLAs', ['Everything in Pro', 'SSO + audit log', 'Priority routing', '99.95% uptime']],
  ];
  return `
  <section class="pricing">
    <h1>Pricing</h1>
    <p class="lede">Every plan includes the same data model. You are buying volume and controls, not features you already need.</p>
    <div class="pricing__grid">
      ${tiers
        .map(
          ([name, price, blurb, features]) => `<article class="tier${name === 'Pro' ? ' tier--featured' : ''}">
            <h2>${esc(name)}</h2>
            <p class="tier__price">${esc(price)}<span>/mo</span></p>
            <p class="muted">${esc(blurb)}</p>
            <ul>${features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
            <a class="btn ${name === 'Pro' ? 'btn--primary' : 'btn--ghost'}" href="#/signup?plan=${encodeURIComponent(name)}" data-testid="choose-${name.toLowerCase()}">Choose ${esc(name)}</a>
          </article>`,
        )
        .join('')}
    </div>
  </section>`;
}

function simplePage(title, paragraphs) {
  return `<section class="prose">
    <h1>${esc(title)}</h1>
    ${paragraphs.map((p) => `<p>${p}</p>`).join('')}
  </section>`;
}

/* ------------------------------------------------------------------ router */

const routes = {
  '/': landingView,
  '/signup': signupView,
  '/dashboard': dashboardView,
  '/projects': dashboardView,
  '/settings': settingsView,
  '/pricing': pricingView,
  '/docs': () => simplePage('Docs', ['This demo application ships with <a href="https://github.com/Emerald-dev0/Lens">Lens</a> so agents can practise real browser workflows.', 'Every view is reachable by hash route, and all data stays in <code>localStorage</code>.']),
  '/changelog': () => simplePage('Changelog', ['<strong>2.4</strong> — project analytics now read from customer records.', '<strong>2.3</strong> — shared response templates.', '<strong>2.2</strong> — faster account switcher.']),
  '/support': () => simplePage('Support', ['Real humans, quick replies, no chatbot theatre. This page exists so the navigation has a long label the responsive reviewer can complain about.']),
};

function currentRoute() {
  const hash = location.hash.replace(/^#/, '') || '/';
  return hash.split('?')[0];
}

function render() {
  const route = currentRoute();
  const page = el('main');
  document.body.dataset.route = route;

  if (route.startsWith('/projects/')) {
    page.innerHTML = projectView(route.split('/')[2]);
  } else {
    const view = routes[route] ?? (() => simplePage('Page not found', [`No route matches <code>${esc(route)}</code>.`, '<a href="#/">Back to the landing page</a>']));
    page.innerHTML = view();
  }

  document.title =
    route === '/' ? 'Harbor — customer operations, simplified' : `${route.slice(1).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} · Harbor`;
  document.querySelectorAll('.nav__link').forEach((link) => {
    link.classList.toggle('nav__link--active', link.getAttribute('href') === `#${route}`);
  });
  el('toasts')?.setAttribute('data-route', route);
  document.querySelector('[data-testid="build-stamp"]').textContent = `demo app · ${DEFECTS ? 'defect mode' : 'clean mode'}`;
}

/* ---------------------------------------------------------------- actions */

function bindForms(root) {
  const form = root.querySelector('[data-form]');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const kind = form.dataset.form;
    const data = Object.fromEntries(new FormData(form).entries());
    if (kind === 'signup') {
      const errors = {};
      if (!data.name?.trim()) errors.name = 'Tell us who to greet.';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email ?? '')) errors.email = 'Enter a valid work email.';
      if (!data.company?.trim()) errors.company = 'Company is required.';
      if ((data.password ?? '').length < 10) errors.password = 'Use at least 10 characters.';
      form.querySelectorAll('[data-error]').forEach((node) => {
        node.textContent = errors[node.dataset.error] ?? '';
      });
      form.querySelectorAll('.field--invalid').forEach((node) => node.classList.remove('field--invalid'));
      if (Object.keys(errors).length) {
        for (const [key] of Object.entries(errors)) form.querySelector(`[name="${key}"]`)?.closest('.field')?.classList.add('field--invalid');
        const note = form.querySelector('[data-form-note]');
        if (note) note.textContent = `${Object.keys(errors).length} field(s) need attention.`;
        form.querySelector('.field--invalid input')?.focus();
        return;
      }
      state.account = { name: data.name.trim(), email: data.email.trim(), company: data.company.trim(), plan: data.plan ?? 'Pro', createdAt: new Date().toISOString() };
      logActivity('account', `Account created for ${state.account.company} on the ${state.account.plan} plan`);
      save();
      toast(`Welcome, ${state.account.name.split(' ')[0]} — your workspace is ready.`, 'success');
      location.hash = '#/dashboard';
      return;
    }
    if (kind === 'project') {
      const name = (data.name ?? '').trim();
      if (!name) {
        form.querySelector('[data-error="name"]').textContent = 'A project needs a name.';
        form.querySelector('[name="name"]').focus();
        return;
      }
      const project = {
        id: `prj_${Math.random().toString(36).slice(2, 8)}`,
        name,
        description: (data.description ?? '').trim(),
        status: (data.status ?? 'active').toLowerCase(),
        records: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.projects = [project, ...state.projects];
      logActivity('project', `Project "${project.name}" created`);
      save();
      closeModal();
      toast(`Project ${project.name} created.`, 'success');
      location.hash = `#/projects/${project.id}`;
    }
    if (kind === 'record') {
      const projectId = form.dataset.project;
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) return;
      const record = { customer: (data.customer ?? '').trim(), plan: data.plan, status: data.status, note: (data.note ?? '').trim(), at: new Date().toISOString() };
      if (!record.customer) {
        form.querySelector('[name="customer"]').focus();
        toast('A record needs a customer name.', 'error');
        return;
      }
      project.records = [...(project.records ?? []), record];
      project.updatedAt = new Date().toISOString();
      logActivity('record', `${record.customer} added to ${project.name}`);
      save();
      toast(`Added ${record.customer} to ${project.name}.`, 'success');
    }
  });
}

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (trigger) {
    event.preventDefault();
    const action = trigger.dataset.action;

    if (action === 'new-project' || action === 'empty-new-project') {
      openModal(
        'New project',
        `<form data-form="project">
          <label class="field"><span class="field__label">Project name</span>
            <input name="name" placeholder="Q1 Acme migration" required data-testid="field-project-name" autofocus />
            <output class="field__error" data-error="name"></output></label>
          <label class="field"><span class="field__label">Description</span>
            <textarea name="description" rows="3" placeholder="What is this project for?"></textarea></label>
          <label class="field"><span class="field__label">Status</span>
            <select name="status"><option value="Active">Active</option><option value="Onboarding">Onboarding</option><option value="At risk">At risk</option></select></label>
          <div class="modal__actions">
            <button class="btn btn--ghost" type="button" data-action="close-modal">Cancel</button>
            <button class="btn btn--primary" type="submit" data-testid="create-project">Create project</button>
          </div>
        </form>`,
        (modal) => bindForms(modal),
      );
      return;
    }
    if (action === 'close-modal') return closeModal();
    if (action === 'quick-account') {
      state.account = { name: 'Alex Rivera', email: 'alex@acme.test', company: 'Acme Corporation', plan: 'Pro', createdAt: new Date().toISOString() };
      logActivity('account', 'Demo account created via quick action');
      save();
      toast('Demo account ready.', 'success');
      return;
    }
    if (action === 'sign-in' || action === 'sign-out') {
      state.account = null;
      save();
      location.hash = '#/signup';
      toast(action === 'sign-in' ? 'Sign in to the demo workspace.' : 'Signed out of the demo.', 'info');
      return;
    }
    if (action === 'reset-demo') {
      state.account = null;
      state.projects = [];
      state.activity = [];
      localStorage.removeItem('harbor.v1');
      render();
      toast('Demo data cleared.', 'info');
      return;
    }
    if (action === 'archive-project') {
      const project = state.projects.find((p) => p.id === trigger.dataset.id);
      if (project) {
        project.status = 'archived';
        project.updatedAt = new Date().toISOString();
        logActivity('project', `Project "${project.name}" archived`);
        save();
        toast(`${project.name} archived.`, 'info');
      }
      return;
    }
    if (action === 'open-project') {
      location.hash = `#/projects/${trigger.dataset.id}`;
      return;
    }
    if (action === 'project-tab') {
      location.hash = `#/projects/${trigger.dataset.id}?tab=${trigger.dataset.tab}`;
      return;
    }
    if (action === 'save-description') {
      const project = state.projects.find((p) => p.id === trigger.dataset.id);
      const field = document.querySelector('[data-testid="project-description"]');
      if (project && field) {
        project.description = field.value.trim();
        project.updatedAt = new Date().toISOString();
        logActivity('project', `Description updated for "${project.name}"`);
        save();
        toast('Description saved.', 'success');
      }
      return;
    }
    if (action === 'remove-record') {
      const project = state.projects.find((p) => p.id === trigger.dataset.id);
      if (project) {
        project.records = (project.records ?? []).filter((_, i) => i !== Number(trigger.dataset.index));
        project.updatedAt = new Date().toISOString();
        save();
      }
      return;
    }
    if (action === 'theme') {
      state.theme = trigger.dataset.theme;
      document.documentElement.dataset.theme = state.theme;
      save();
      return;
    }
    if (action === 'change-plan') {
      openModal(
        'Change plan',
        `<p class="muted">Pick the plan this demo workspace should report.</p>
         <div class="row">${['Starter', 'Pro', 'Scale']
           .map((plan) => `<button class="btn btn--ghost" type="button" data-action="set-plan" data-plan="${plan}">${plan}</button>`)
           .join('')}</div>`,
      );
      return;
    }
    if (action === 'set-plan') {
      if (state.account) state.account.plan = trigger.dataset.plan;
      logActivity('plan', `Plan changed to ${trigger.dataset.plan}`);
      save();
      closeModal();
      toast(`Plan set to ${trigger.dataset.plan}.`, 'success');
      return;
    }
    if (action === 'danger-reset') {
      if (!window.confirm('Delete every project and record stored in this browser?')) return;
      localStorage.removeItem('harbor.v1');
      Object.assign(state, { account: null, projects: [], activity: [] });
      render();
      toast('Demo workspace deleted.', 'info');
      return;
    }
    if (action === 'retry-analytics') {
      render();
      return;
    }
  }

  const cardLink = event.target.closest('a[href^="#/"]');
  if (cardLink) setTimeout(() => window.scrollTo({ top: 0, behavior: 'instant' }), 0);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el('modal').hidden) closeModal();
});

window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
});

function relativeTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ------------------------------------------------------------------- boot */

document.documentElement.dataset.theme = state.theme ?? 'dark';
if (DEFECTS) document.documentElement.dataset.defects = '1';
render();
bindForms(document);

// A single deliberate console warning so `lens console` has real signal to report.
if (DEFECTS) console.warn('[demo] defect mode enabled: expect layout and contrast findings');
if (!state.account && location.hash.startsWith('#/projects/')) console.error('[demo] opened a project with no account in this browser');

window.__harbor = {
  state,
  save,
  reset: () => {
    localStorage.removeItem('harbor.v1');
    location.hash = '#/';
    location.reload();
  },
  version: '2.4.0',
};
