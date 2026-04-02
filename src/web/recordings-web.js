function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSidebar({ viewer, oauthConfigured, currentPath, retentionDays, storageRoot }) {
  const signedInBlock = viewer
    ? `
      <div class="account">
        <small>Linked Discord</small>
        <strong>${escapeHtml(viewer.displayName || viewer.username || `User ${viewer.id}`)}</strong>
        <div class="account-user">
          <span class="avatar"${viewer.avatarUrl ? ` style="background-image:url('${escapeHtml(viewer.avatarUrl)}')"` : ""}></span>
          <div>
            <small>Signed in</small>
            <strong>@${escapeHtml(viewer.username || viewer.id)}</strong>
          </div>
        </div>
        <div class="account-actions">
          <a class="control" href="/recordings/mine/">My Sessions</a>
          <a class="control" href="/auth/logout?next=${encodeURIComponent(currentPath)}">Logout</a>
        </div>
      </div>
    `
    : `
      <div class="account">
        <small>Library</small>
        <strong>recording.olavehome.uk</strong>
        ${
          oauthConfigured
            ? `<div class="account-actions"><a class="action" href="/auth/discord/login?next=${encodeURIComponent(currentPath)}">Link Discord</a></div>`
            : `<p class="meta">Discord linking is available once OAuth is configured.</p>`
        }
      </div>
    `;

  return `
    <aside id="sidebar" class="sidebar">
      <div class="brand"><span class="brand-mark">📁</span><span>Recfile</span></div>
      ${signedInBlock}
      <nav class="nav">
        <a class="nav-item${currentPath === "/recordings/" || currentPath === "/" ? " active" : ""}" href="/recordings/">Home</a>
        <a class="nav-item${currentPath === "/recordings/mine/" ? " active" : ""}" href="/recordings/mine/">My Sessions</a>
        <a class="nav-item${currentPath === "/recordings/recent/" ? " active" : ""}" href="/recordings/recent/">Recent Sessions</a>
        <a class="nav-item${currentPath === "/recordings/archives/" ? " active" : ""}" href="/recordings/archives/">Archives</a>
        <a class="nav-item${currentPath === "/recordings/help/" ? " active" : ""}" href="/recordings/help/">Help</a>
      </nav>
      <div class="sidebar-foot">
        Retention: ${escapeHtml(retentionDays)} days<br>
        Storage root: ${escapeHtml(storageRoot)}
      </div>
    </aside>
  `;
}

function renderShell({
  title,
  viewer,
  oauthConfigured,
  currentPath,
  retentionDays,
  storageRoot,
  heroText = "",
  contentMarkup,
  extraScripts = "",
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #141c2b; color: #e5eefc; }
      a { color: inherit; text-decoration: none; }
      .layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; transition: grid-template-columns .18s ease; }
      .layout.sidebar-collapsed { grid-template-columns: 0 minmax(0, 1fr); }
      .sidebar { padding: 24px 18px; background: #1b2435; border-right: 1px solid #2e3a52; overflow: hidden; transition: transform .18s ease, opacity .18s ease; }
      .layout.sidebar-collapsed .sidebar { transform: translateX(-100%); opacity: 0; pointer-events: none; }
      .brand { display: flex; align-items: center; gap: 12px; font-size: 1.8rem; font-weight: 800; margin-bottom: 24px; }
      .brand-mark { width: 42px; height: 42px; display: grid; place-items: center; background: linear-gradient(135deg, #facc15, #f59e0b); border-radius: 12px; color: #111827; }
      .account { padding: 14px 16px; border: 1px solid #3557a6; border-radius: 12px; background: #222d41; margin-bottom: 18px; }
      .account-user { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
      .avatar { width: 42px; height: 42px; border-radius: 50%; background: linear-gradient(135deg, #4f46e5, #06b6d4); background-size: cover; background-position: center; display: inline-block; }
      .account small { display: block; color: #91a3c7; margin-bottom: 4px; }
      .account strong { display: block; font-size: 1rem; }
      .account-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
      .nav { margin-top: 26px; display: grid; gap: 10px; }
      .nav-item { display: block; padding: 11px 12px; border-radius: 10px; color: #dce7fb; background: transparent; border: 1px solid transparent; }
      .nav-item.active { background: #243149; border-color: #3557a6; }
      .sidebar-foot { margin-top: 28px; color: #8ea1c4; font-size: 0.92rem; line-height: 1.5; }
      .content { padding: 8px 14px 18px; min-width: 0; }
      .topbar { margin-top: 8px; background: #1c2638; border: 1px solid #2e3a52; border-radius: 14px; min-height: 48px; display: flex; align-items: center; padding: 0 14px; }
      .topbar .hamburger { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 8px; background: #3268f0; color: white; font-weight: 700; border: 0; cursor: pointer; }
      .hero { text-align: center; color: #a8bbda; padding: 18px 12px 8px; font-size: 0.95rem; }
      .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
      .stat { background: #1c2638; border: 1px solid #2e3a52; border-radius: 14px; padding: 14px 16px; }
      .stat small { display: block; color: #90a4c7; margin-bottom: 4px; }
      .stat strong { font-size: 1.3rem; }
      .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 16px 0 10px; }
      .toolbar-left { display: flex; gap: 10px; align-items: center; color: #9eb1d1; }
      .toolbar-right { display: flex; gap: 8px; flex-wrap: wrap; }
      .control, .action { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 8px 12px; border-radius: 10px; border: 1px solid #3b4d6d; background: #2a364d; color: #eef4ff; cursor: pointer; font: inherit; }
      .action { background: #2563eb; border-color: #2563eb; }
      .control.green { background: #16a34a; border-color: #16a34a; }
      .search { padding: 8px 12px; border-radius: 10px; border: 1px solid #3b4d6d; background: #202b3f; color: #eef4ff; min-width: 220px; }
      .table { border-top: 1px solid #314158; }
      .row { display: grid; grid-template-columns: minmax(0, 1fr) 220px 210px; gap: 16px; padding: 18px 8px; border-bottom: 1px solid #314158; align-items: center; }
      .row-main { display: flex; gap: 14px; min-width: 0; }
      .row-icon { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: #21304a; font-size: 1.1rem; }
      .row-copy h2 { margin: 0 0 4px; font-size: 1.1rem; font-weight: 700; }
      .meta { margin: 0 0 4px; color: #9db0d0; font-size: 0.92rem; }
      .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .file-chip { display: inline-flex; gap: 8px; align-items: center; padding: 6px 10px; border-radius: 999px; background: #243149; border: 1px solid #36507d; color: #dfeafe; font-size: 0.88rem; }
      .file-chip span { color: #9eb1d1; }
      .row-side { display: grid; gap: 8px; justify-items: end; }
      .row-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
      .badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; font-size: 0.84rem; font-weight: 700; }
      .badge-ready { background: rgba(34,197,94,.18); color: #86efac; }
      .badge-recording { background: rgba(239,68,68,.18); color: #fca5a5; }
      .badge-match { background: rgba(59,130,246,.18); color: #93c5fd; }
      .badge-archived { background: rgba(250,204,21,.18); color: #fde68a; }
      .empty, .panel, .help-card { padding: 28px; margin-top: 16px; border-radius: 14px; background: #1c2638; border: 1px solid #2e3a52; color: #9fb3d4; }
      .grid-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
      .help-card h2, .panel h2 { margin-top: 0; }
      .footer { margin-top: 24px; padding: 16px 8px 0; color: #8ea1c4; font-size: 0.9rem; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; border-top: 1px solid #314158; }
      @media (max-width: 1100px) { .layout, .layout.sidebar-collapsed { grid-template-columns: 1fr; } .sidebar { position: fixed; inset: 0 auto 0 0; width: 260px; z-index: 10; box-shadow: 12px 0 40px rgba(0,0,0,.35); } .layout.sidebar-collapsed .sidebar { transform: translateX(-100%); opacity: 1; } .row { grid-template-columns: 1fr; } .row-side, .row-actions { justify-items: start; justify-content: flex-start; } .stats, .grid-two { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <div id="layout" class="layout">
      ${renderSidebar({ viewer, oauthConfigured, currentPath, retentionDays, storageRoot })}
      <main class="content">
        <div class="topbar"><button id="sidebarToggle" class="hamburger" type="button">☰</button></div>
        <div class="hero">${heroText}</div>
        ${contentMarkup}
        <footer class="footer">
          <span>Home | Terms of Service | Privacy Policy | Contact</span>
          <span>Olavehome Recordings</span>
        </footer>
      </main>
    </div>
    <script>
      const layout = document.getElementById('layout');
      const toggle = document.getElementById('sidebarToggle');
      const saved = localStorage.getItem('recfile.sidebar');
      if (saved === 'collapsed') layout.classList.add('sidebar-collapsed');
      toggle?.addEventListener('click', () => {
        layout.classList.toggle('sidebar-collapsed');
        localStorage.setItem('recfile.sidebar', layout.classList.contains('sidebar-collapsed') ? 'collapsed' : 'open');
      });
      ${extraScripts}
    </script>
  </body>
</html>`;
}

function renderStats(stats) {
  return `
    <section class="stats">
      ${stats
        .map(
          (stat) => `
            <div class="stat">
              <small>${escapeHtml(stat.label)}</small>
              <strong${stat.id ? ` id="${escapeHtml(stat.id)}"` : ""}>${escapeHtml(stat.value)}</strong>
            </div>
          `,
        )
        .join("")}
    </section>
  `;
}

function renderRowsSection(rows) {
  return `<section id="rows" class="table">${rows
    .map(
      (row) => `
        <article class="row" data-status="${escapeHtml(row.status.toLowerCase())}" data-sort="${escapeHtml(row.sortKey)}" data-label="${escapeHtml(row.searchLabel)}">
          <div class="row-main">
            <div class="row-icon">${escapeHtml(row.icon)}</div>
            <div class="row-copy">
              <h2>${escapeHtml(row.title)}</h2>
              <p class="meta">${escapeHtml(row.subtitle)}</p>
              <p class="meta">${escapeHtml(row.details)}</p>
              <div class="chip-row">
                ${row.fileChips
                  .map(
                    (file) => `<a class="file-chip" href="${escapeHtml(file.href)}">${escapeHtml(file.label)} <span>${escapeHtml(file.sizeLabel)}</span></a>`,
                  )
                  .join("")}
              </div>
            </div>
          </div>
          <div class="row-side">
            <span class="badge badge-${escapeHtml(row.status.toLowerCase())}">${escapeHtml(row.status)}</span>
            ${row.includesViewer ? '<span class="badge badge-match">Includes you</span>' : ""}
            ${row.archived ? '<span class="badge badge-archived">Compressed</span>' : ""}
            <span class="meta">${escapeHtml(row.sideText)}</span>
          </div>
          <div class="row-actions">
            <a class="action" href="${escapeHtml(row.openHref)}">Open</a>
            ${row.zipHref ? `<a class="action" href="${escapeHtml(row.zipHref)}">Download ZIP</a>` : ""}
          </div>
        </article>
      `,
    )
    .join("")}</section>`;
}

function renderListTools(toolbarLabel) {
  return `
    <section class="toolbar">
      <div class="toolbar-left"><span>${escapeHtml(toolbarLabel)}</span></div>
      <div class="toolbar-right">
        <button class="control green" type="button" onclick="window.location.reload()">Refresh</button>
        <select id="sortSelect" class="control">
          <option value="newest">Sort by newest</option>
          <option value="oldest">Sort by oldest</option>
          <option value="ready">Ready first</option>
        </select>
        <input id="searchInput" class="search" type="search" placeholder="Search sessions or files">
      </div>
    </section>
  `;
}

function listScripts() {
  return `
    const rows = Array.from(document.querySelectorAll('.row'));
    const searchInput = document.getElementById('searchInput');
    const sortSelect = document.getElementById('sortSelect');
    const sessionCount = document.getElementById('sessionCount');
    const applyFilters = () => {
      const query = (searchInput?.value || '').trim().toLowerCase();
      const sort = sortSelect?.value || 'newest';
      const ordered = rows.slice().sort((a, b) => {
        if (sort === 'oldest') return Number(a.dataset.sort) - Number(b.dataset.sort);
        if (sort === 'ready' && a.dataset.status !== b.dataset.status) return a.dataset.status === 'ready' ? -1 : 1;
        return Number(b.dataset.sort) - Number(a.dataset.sort);
      });
      const container = document.getElementById('rows');
      if (container) {
        for (const row of ordered) {
          const matches = !query || row.dataset.label.includes(query);
          row.style.display = matches ? '' : 'none';
          container.appendChild(row);
        }
      }
      if (sessionCount) {
        sessionCount.textContent = ordered.filter((row) => row.style.display !== 'none').length;
      }
    };
    searchInput?.addEventListener('input', applyFilters);
    sortSelect?.addEventListener('change', applyFilters);
    applyFilters();
  `;
}

function renderRecordingsHomePage({ viewer, oauthConfigured, retentionDays, storageRoot, recentWindowDays, stats }) {
  const contentMarkup = `
    ${renderStats(stats)}
    <section class="grid-two">
      <article class="panel">
        <h2>Overview</h2>
        <p>Home now shows the library status only: recent activity, archive volume, active captures, and your linked Discord account if you choose to sign in.</p>
        <p>Use the navigation to move between recent sessions, archived sessions, your matched sessions, and the help page.</p>
      </article>
      <article class="panel">
        <h2>${viewer ? "Discord linked" : "Discord login"}</h2>
        <p>${
          viewer
            ? "Your Discord account is linked in this browser. Use My Sessions to see every recording you were included in."
            : oauthConfigured
              ? "Link your Discord account to unlock My Sessions and access protected recording downloads."
              : "Discord OAuth is not configured yet for this site."
        }</p>
        ${
          !viewer && oauthConfigured
            ? `<div class="account-actions"><a class="action" href="/auth/discord/login?next=%2Frecordings%2Fmine%2F">Link Discord</a></div>`
            : ""
        }
      </article>
      <article class="panel">
        <h2>Recent window</h2>
        <p>Recent Sessions contains anything from the last ${escapeHtml(recentWindowDays)} days.</p>
      </article>
      <article class="panel">
        <h2>Archives</h2>
        <p>Anything older than ${escapeHtml(recentWindowDays)} days moves into Archives and is stored as smaller compressed audio files.</p>
      </article>
    </section>
  `;

  return renderShell({
    title: "Recording Library",
    viewer,
    oauthConfigured,
    currentPath: "/recordings/",
    retentionDays,
    storageRoot,
    heroText: "Library overview, Discord sign-in, and storage status.",
    contentMarkup,
  });
}

function renderRecordingsListPage({
  viewer,
  oauthConfigured,
  currentPath,
  retentionDays,
  storageRoot,
  heroText,
  toolbarLabel,
  sessionCountLabel,
  stats,
  rows,
  emptyText,
}) {
  const contentMarkup = `
    ${renderStats(stats)}
    ${renderListTools(toolbarLabel)}
    ${
      rows.length > 0
        ? renderRowsSection(rows)
        : `<section class="empty">${escapeHtml(emptyText)}</section>`
    }
  `;

  return renderShell({
    title: "Recording Library",
    viewer,
    oauthConfigured,
    currentPath,
    retentionDays,
    storageRoot,
    heroText,
    contentMarkup,
    extraScripts: listScripts(),
  });
}

function renderRecordingSessionPage({
  viewer,
  oauthConfigured,
  currentPath,
  retentionDays,
  storageRoot,
  title,
  subtitle,
  details,
  zipHref,
  files,
  archived,
}) {
  const contentMarkup = `
    <section class="panel">
      <h2>${escapeHtml(title)}</h2>
      <p class="meta">${escapeHtml(subtitle)}</p>
      <p class="meta">${escapeHtml(details)}</p>
      ${archived ? '<p class="meta">This session is in archive storage and uses smaller compressed audio files.</p>' : ""}
      <div class="account-actions" style="margin-top:16px;">
        ${zipHref ? `<a class="action" href="${escapeHtml(zipHref)}">Download ZIP</a>` : ""}
        <a class="control" href="/recordings/">Back to library</a>
      </div>
    </section>
    <section class="table">
      ${files
        .map(
          (file) => `
            <article class="row">
              <div class="row-main">
                <div class="row-icon">🎵</div>
                <div class="row-copy">
                  <h2>${escapeHtml(file.name)}</h2>
                  <p class="meta">${escapeHtml(file.sizeLabel)}</p>
                </div>
              </div>
              <div class="row-side">${file.archived ? '<span class="badge badge-archived">Compressed</span>' : '<span class="badge badge-ready">Recent</span>'}</div>
              <div class="row-actions"><a class="action" href="${escapeHtml(file.href)}">Download</a></div>
            </article>
          `,
        )
        .join("")}
    </section>
  `;

  return renderShell({
    title,
    viewer,
    oauthConfigured,
    currentPath,
    retentionDays,
    storageRoot,
    heroText: "Session files available for your Discord account.",
    contentMarkup,
  });
}

function renderRecordingsHelpPage({ viewer, oauthConfigured, currentPath, retentionDays, storageRoot, recentWindowDays }) {
  const contentMarkup = `
    <section class="help-card">
      <h2>Help</h2>
      <p>Home shows general library statistics and your Discord sign-in state.</p>
      <p>Recent Sessions lists recordings from the last ${escapeHtml(recentWindowDays)} days.</p>
      <p>Archives lists anything older than ${escapeHtml(recentWindowDays)} days. Those recordings are stored as smaller compressed audio files.</p>
      <p>My Sessions shows every recording that includes your Discord user ID.</p>
      <p>When Discord OAuth is configured, session pages and download links are restricted to people included in that recording.</p>
    </section>
  `;

  return renderShell({
    title: "Recording Help",
    viewer,
    oauthConfigured,
    currentPath,
    retentionDays,
    storageRoot,
    heroText: "Basic help for browsing and downloading recordings.",
    contentMarkup,
  });
}

function renderRecordingAccessDeniedPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Access denied</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #141c2b; color: #e5eefc; font-family: Inter, system-ui, sans-serif; }
      .card { width: min(560px, calc(100vw - 32px)); padding: 28px; border-radius: 18px; background: #1c2638; border: 1px solid #2e3a52; }
      h1 { margin: 0 0 10px; font-size: 1.5rem; }
      p { margin: 0 0 14px; color: #a7bbda; line-height: 1.6; }
      .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
      a { display: inline-flex; align-items: center; justify-content: center; padding: 10px 14px; border-radius: 10px; text-decoration: none; border: 1px solid #3b4d6d; background: #2a364d; color: #eef4ff; }
      a.primary { background: #2563eb; border-color: #2563eb; }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Access denied</h1>
      <p>This recording is restricted to Discord users who were included in the session.</p>
      <p>If you believe this is your recording, sign in with the Discord account that was present in voice chat when the recording was captured.</p>
      <div class="actions">
        <a class="primary" href="/recordings/mine/">Go to My Sessions</a>
        <a href="/recordings/">Back to library</a>
      </div>
    </main>
  </body>
</html>`;
}

module.exports = {
  renderRecordingAccessDeniedPage,
  renderRecordingsHelpPage,
  renderRecordingsHomePage,
  renderRecordingsListPage,
  renderRecordingSessionPage,
};
