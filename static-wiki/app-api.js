// API-backed static wiki frontend
(function(){
  const API = ""; // same origin
  const APP_BASE = (() => {
    const path = window.location.pathname || '';
    const lower = path.toLowerCase();
    const wikiIndex = lower.indexOf('/wiki/');
    if (wikiIndex >= 0) return path.slice(0, wikiIndex);
    if (lower.endsWith('/wiki')) return path.slice(0, -5);
    return '';
  })();

  function appUrl(path) {
    if (!path || typeof path !== 'string') return path;
    if (/^(https?:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:') || path.startsWith('#')) {
      return path;
    }
    if (!path.startsWith('/')) return path;
    return `${APP_BASE}${path}` || path;
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    if (typeof input === 'string') {
      return nativeFetch(appUrl(input), init);
    }
    return nativeFetch(input, init);
  };

  // Auto-refresh interval for multi-user sync (30 seconds)
  let autoRefreshInterval = null;
  let lastDataHash = null;
  
  // Global categories array for editor selector
  let allCategories = [];
  const appState = {
    pages: [],
    categories: [],
    bootstrapLoaded: false,
    bootstrapPromise: null,
    snapshotHash: null,
    currentSearch: '',
    routeBeforeSearch: null,
    searchToken: 0,
    searchController: null
  };

  // helpers
  const el = id => document.getElementById(id);
  // registry for page loader functions (ensures router finds loaders regardless of declaration order)
  const pageLoaders = {};
  // Global error handlers to surface uncaught errors to UI for debugging
  window.addEventListener('error', (e) => {
    try { showNotification('Error JS: ' + (e && e.message ? e.message : 'unknown'), 'error', 8000); } catch(_){}
    console.error('Unhandled error', e.error || e.message || e);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { showNotification('Promise rejection: ' + (ev && ev.reason ? (ev.reason.message || String(ev.reason)) : 'unknown'), 'error', 8000); } catch(_){}
    console.error('Unhandled rejection', ev);
  });
  function parseServerDate(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    // If it's a number (timestamp)
    if (typeof s === 'number') return new Date(s);
    // ISO or other parseable formats
    const isoTry = new Date(s);
    if (!isNaN(isoTry.getTime())) return isoTry;
    // Try DD/MM/YYYY[ ,HH:MM:SS] pattern (European)
    const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const year = parseInt(m[3], 10);
      const hh = m[4] ? parseInt(m[4], 10) : 0;
      const mm = m[5] ? parseInt(m[5], 10) : 0;
      const ss = m[6] ? parseInt(m[6], 10) : 0;
      return new Date(year, month, day, hh, mm, ss);
    }
    // Fallback to Date constructor (may be NaN)
    const fallback = new Date(s);
    return isNaN(fallback.getTime()) ? null : fallback;
  }
  function slugify(s){ return s.toLowerCase().trim().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g,''); }
  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Hide all main SPA pages/views
  function hideAllPages(){
    const ids = ['homeView','viewPage','editor','categoriesPage','noticesPage','diagramsPage','incidentsPage'];
    ids.forEach(id=>{ const e = el(id); if (e) e.style.display = 'none'; });
  }

  async function fetchJson(url, opts){
    const r = await fetch(url, opts);
    const txt = await r.text();

    if (!r.ok) {
      let message = txt || r.statusText || `HTTP ${r.status}`;
      if (txt) {
        try {
          const payload = JSON.parse(txt);
          message = payload.error || payload.detail || payload.title || payload.message || message;
        } catch (_) {}
      }
      throw new Error(message);
    }

    if (!txt) return null;
    try { return JSON.parse(txt); } catch (e) { throw new Error('Invalid JSON response: ' + e.message); }
  }

  // Simple hash function for change detection
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }
  // Debounce helper
  function debounce(fn, ms){ let t; return function(...args){ clearTimeout(t); t = setTimeout(()=> fn.apply(this,args), ms); }; }
  function normalizeText(value){
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }
  function getHashRoute(){
    return window.location.hash.slice(1) || '/';
  }
  function getPageCategoryNames(page){
    return String(page && page.categories || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  function buildCategoryNameLookup(categories){
    const map = new Map();
    (categories || []).forEach(category => {
      map.set(normalizeText(category.name), category);
    });
    return map;
  }
  function dedupePages(items){
    const seen = new Set();
    return (items || []).filter(item => {
      const key = item && (item.slug || item.id || item.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function scoreLocalResult(page, query){
    const needle = normalizeText(query);
    const title = normalizeText(page.title);
    const excerpt = normalizeText(page.excerpt);
    const categories = normalizeText(page.categories);
    let score = 0;
    if (!needle) return 0;
    if (title === needle) score += 300;
    if (title.startsWith(needle)) score += 220;
    if (title.includes(needle)) score += 140;
    if (categories.includes(needle)) score += 90;
    if (excerpt.includes(needle)) score += 50;
    if (score > 0 && page.updatedAt) score += Math.max(0, 20 - Math.floor((Date.now() - new Date(page.updatedAt).getTime()) / 86400000));
    return score;
  }
  function runLocalSearch(query){
    const items = (appState.pages || [])
      .map(page => ({ ...page, _score: scoreLocalResult(page, query) }))
      .filter(page => page._score > 0)
      .sort((a, b) => (b._score - a._score) || (new Date(b.updatedAt) - new Date(a.updatedAt)))
      .slice(0, 20)
      .map(({ _score, ...page }) => page);
    return dedupePages(items);
  }
  function mergeSearchResults(primary, secondary){
    return dedupePages([...(primary || []), ...(secondary || [])]);
  }
  function clearDynamicResults(){
    const main = el('contentArea');
    if (!main) return;
    main.querySelectorAll('.search-results').forEach(node => node.remove());
  }
  function renderDashboardStats(){
    const pages = appState.pages || [];
    const categories = appState.categories || [];
    const latest = [...pages].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    const metricPages = el('metricTotalPages');
    const metricCategories = el('metricTotalCategories');
    const metricLastUpdated = el('metricLastUpdated');
    const recentCountBadge = el('recentCountBadge');
    if (metricPages) metricPages.textContent = String(pages.length);
    if (metricCategories) metricCategories.textContent = String(categories.length);
    if (metricLastUpdated) metricLastUpdated.textContent = latest && latest.updatedAt ? new Date(latest.updatedAt).toLocaleString() : 'Sin datos';
    if (recentCountBadge) recentCountBadge.textContent = String(Math.min(pages.length, 8));
  }
  async function ensureBootstrap(force = false){
    if (!force && appState.bootstrapLoaded) return appState;
    if (!force && appState.bootstrapPromise) return appState.bootstrapPromise;

    const load = Promise.all([
      fetchJson('/api/pages'),
      fetchJson('/api/categories')
    ]).then(([pages, categories]) => {
      appState.pages = Array.isArray(pages) ? pages : [];
      appState.categories = Array.isArray(categories) ? categories : [];
      appState.bootstrapLoaded = true;
      appState.snapshotHash = simpleHash(JSON.stringify(appState.pages) + JSON.stringify(appState.categories));
      renderDashboardStats();
      return appState;
    }).finally(() => {
      appState.bootstrapPromise = null;
    });

    appState.bootstrapPromise = load;
    return load;
  }

  // Current loaded diagram items (used for client-side filtering)
  let currentDiagramItems = [];
  // Current boards for Incidencias
  let currentIncidentsBoards = [];

  // Check for data changes and refresh if needed
  async function checkForUpdates() {
    try {
      // Don't auto-refresh if user is editing to prevent data loss
      const editorVisible = el('editor') && el('editor').style.display !== 'none';
      if (editorVisible) {
        console.log('Skipping auto-refresh: editor is open');
        return;
      }
      
      await ensureBootstrap(true);
      const currentHash = appState.snapshotHash;
      
      if (lastDataHash !== null && currentHash !== lastDataHash) {
        console.log('Data changed, refreshing interface snapshot...');
        await renderLatest();
        await refreshCategories();
        if (appState.currentSearch) {
          await search(appState.currentSearch, { preserveContext: true });
        }
        showNotification('Contenido actualizado', 'success', 2000);
      }
      
      lastDataHash = currentHash;
    } catch (err) {
      console.error('Auto-refresh check failed:', err);
    }
  }

  // Start auto-refresh for multi-user sync
  function startAutoRefresh() {
    if (autoRefreshInterval) return;
    autoRefreshInterval = setInterval(checkForUpdates, 30000); // Check every 30 seconds
    console.log('Auto-refresh enabled (30s interval)');
  }

  // Stop auto-refresh
  function stopAutoRefresh() {
    if (autoRefreshInterval) {
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
      console.log('Auto-refresh disabled');
    }
  }

  // === ROUTING SYSTEM ===
  
  // Navigate to a route and update URL
  function navigateTo(path) {
    const target = path && path.startsWith('#') ? path.slice(1) : (path || '/');
    try {
      if (getHashRoute() === target) {
        // same hash, trigger router explicitly
        setTimeout(() => router().catch(()=>{}), 0);
      } else {
        window.location.hash = target;
      }
    } catch (e) {
      window.location.hash = target;
    }
  }
  
  // Router: handle hash changes and route to appropriate view
  async function router() {
    const hash = getHashRoute();
    // Ensure all pages hidden before routing to avoid overlap between views
    try { hideAllPages(); } catch(e) { /* ignore */ }
    const parts = hash.split('/');

    console.log('Routing to:', hash);

    // Home
    if (hash === '/' || hash === '') { showHome({ syncUrl: false }); return; }

    // Diagrams list
    if (hash === '/diagramas') { if (pageLoaders.diagramas && typeof pageLoaders.diagramas === 'function') { await pageLoaders.diagramas(); } else { console.warn('loadDiagramasPage not available in this context'); } return; }

    // Incidencias (kanban)
    if (hash === '/incidencias') { if (pageLoaders.incidencias && typeof pageLoaders.incidencias === 'function') { await pageLoaders.incidencias(); } else { console.warn('loadIncidenciasPage not available in this context'); } return; }

    // Single diagram route: /diagramas/{filename}
    if (parts[1] === 'diagramas' && parts[2]) {
      const name = decodeURIComponent(parts.slice(2).join('/'));
      if (pageLoaders.diagramas && typeof pageLoaders.diagramas === 'function') { await pageLoaders.diagramas(); } else { console.warn('loadDiagramasPage not available in this context'); }
      openDiagrama(name, /*push*/ false, /*fullscreen*/ true);
      return;
    }

    // Notices
    if (hash === '/avisos') { await showNoticesPage(); return; }

    // Categories
    if (hash === '/categorias') { await showCategoriesPage(); return; }

    // Create page
    if (hash === '/crear') { loadEditor(null); return; }

    // View article
    if (parts[1] === 'articulo' && parts[2]) { const slug = parts.slice(2).join('/'); await openPage(slug); return; }

    // Edit article
    if (parts[1] === 'editar' && parts[2]) {
      const slug = parts.slice(2).join('/');
      const page = await fetchJson('/api/pages/' + encodeURIComponent(slug));
      if (page) { loadEditor(page); } else { showNotification('Pagina no encontrada', 'error'); navigateTo('/'); }
      return;
    }

    // Unknown route -> go home
    console.warn('Unknown route:', hash);
    navigateTo('/');
  }

  // Global notification helper (uses #globalNotification first, then #catNotification, then creates toast)
  function showNotification(msg, type='success', timeout=3500){
    // Try global notification first
    let n = document.getElementById('globalNotification');
    if (n){ 
      n.className = 'notification global-notification ' + (type === 'error' ? 'error' : 'success'); 
      n.innerHTML = `<span class="close" onclick="this.parentNode.style.display='none'">x</span>${msg}`; 
      n.style.display = 'block'; 
      if (timeout) setTimeout(()=> { try { n.style.display='none' } catch(e){} }, timeout); 
      return; 
    }
    
    // Fallback to category notification
    n = document.getElementById('catNotification');
    if (n){ 
      n.className = 'notification ' + (type === 'error' ? 'error' : 'success'); 
      n.innerHTML = `<span class="close" onclick="this.parentNode.style.display='none'">x</span>${msg}`; 
      n.style.display = 'block'; 
      if (timeout) setTimeout(()=> { try { n.style.display='none' } catch(e){} }, timeout); 
      return; 
    }
    
    // Last fallback: temporary top-right toast
    const t = document.createElement('div'); 
    t.className = 'notification ' + (type === 'error' ? 'error' : 'success'); 
    t.style.position='fixed'; 
    t.style.top='80px'; 
    t.style.right='16px'; 
    t.style.zIndex=9999; 
    t.style.minWidth='300px';
    t.innerHTML = `<span class="close" style="cursor:pointer">x</span>${msg}`;
    t.querySelector('.close').onclick = ()=> t.remove(); 
    document.body.appendChild(t); 
    if (timeout) setTimeout(()=> t.remove(), timeout);
  }

  function clearNotification(){ const n = document.getElementById('catNotification'); if (n) n.style.display='none'; }


  function showEditor(){
    hideAllPages();
    clearDynamicResults();
    const editor = el('editor');
    if (editor) editor.style.display = 'block';
  }

  // --- Notices UI ---
  function loadNoticesIntoHome() {
    const list = el('noticesList');
    if (!list) return;
    list.innerHTML = '<li>Cargando avisos...</li>';
    fetch('/api/notices?limit=5').then(r => r.json()).then(data => {
      list.innerHTML = '';
      if (!data || data.length === 0) { list.innerHTML = '<li>No hay avisos.</li>'; return; }
      // determine last seen timestamp from localStorage (parse robustly)
      const lastSeenIso = localStorage.getItem('notices:lastSeen');
      const lastSeen = lastSeenIso ? parseServerDate(lastSeenIso) : null;
      data.forEach(n => {
        const li = document.createElement('li');
        const title = escapeHtml(n.title || '');
        const body = (n.body || '');
        const bodyHtml = escapeHtml(body).replace(/\r?\n/g, '<br>');
        // createdAt parsing
        const created = n.createdAt ? parseServerDate(n.createdAt) : null;
        let dateHtml = '';
        if (created) {
          dateHtml = `<span class="notice-date">${created.toLocaleString()}</span>`;
        }
        // new marker: only based on time threshold (25 hours)
        let isNew = false;
        if (created) {
          isNew = (Date.now() - created.getTime()) <= (25 * 3600 * 1000);
        }
        const newBadge = isNew ? `<span class="badge-new">Nuevo</span>` : '';
        li.innerHTML = `<div class="notice-item"><div class="notice-title"><strong>${title}</strong>${dateHtml}${newBadge}</div><div class="notice-body">${bodyHtml}</div></div>`;
        list.appendChild(li);
      });
    }).catch(err => { list.innerHTML = '<li>Error cargando avisos.</li>'; });
  }

  async function showNoticesPage(){
    // Render notices page from template
    el('homeView').style.display = 'none';
    el('viewPage').style.display = 'none';
    el('editor').style.display = 'none';
    const np = el('noticesPage'); if (np) np.style.display = 'block';
    const cp = el('categoriesPage'); if (cp) cp.style.display = 'none';
    const dp = el('diagramsPage'); if (dp) dp.style.display = 'none';
    const main = el('contentArea'); if (main) {
      const existingResults = main.querySelectorAll('.search-results'); existingResults.forEach(r=>r.remove());
    }
    // bind buttons
    const btn = el('noticeCreateBtn'); if (btn) btn.onclick = createNotice;
    const btnCancel = el('noticeCancelBtn'); if (btnCancel) btnCancel.onclick = ()=> navigateTo('/');
    const search = el('noticeSearch'); if (search) { search.oninput = function(){ loadNoticesForManagement(); }; }
    // load existing notices for management
    loadNoticesForManagement();
  }

  function getNoticesLastSeen(){
    const iso = localStorage.getItem('notices:lastSeen');
    return iso ? new Date(iso) : null;
  }

  // removed: markAllNoticesRead - no longer used

  async function updateNotice(id, title, body, createdAt) {
    try {
      const payload = { id, title, body, createdAt };
      const res = await fetch('/api/notices/' + id, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) {
        const txt = await res.text().catch(()=>null);
        throw new Error(txt || `HTTP ${res.status}`);
      }
      showNotification('Aviso actualizado', 'success', 1500);
      loadNoticesForManagement();
      loadNoticesIntoHome();
    } catch (err) {
      showNotification('Error al actualizar aviso: ' + (err.message || ''), 'error');
      console.error('updateNotice error', err);
    }
  }

    function toLocalDateTimeInput(dt) {
      // dt is Date
      const d = new Date(dt);
      const pad = n => n.toString().padStart(2,'0');
      const yyyy = d.getFullYear();
      const mm = pad(d.getMonth()+1);
      const dd = pad(d.getDate());
      const hh = pad(d.getHours());
      const mi = pad(d.getMinutes());
      return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
    }

    function fromLocalDateTimeInput(val) {
      // returns ISO string in UTC-ish (browser local converted to ISO)
      const d = new Date(val);
      return d.toISOString();
    }

  function loadNoticesForManagement() {
    const container = el('noticesContainer');
    if (!container) return;
    container.innerHTML = 'Cargando avisos...';
    fetch('/api/notices?limit=1000')
      .then(async r => {
        if (!r.ok) {
          const txt = await r.text().catch(()=>null);
          throw new Error(txt || `HTTP ${r.status}`);
        }
        let data = await r.json();
        container.innerHTML = '';
        if (!data || data.length === 0) { container.innerHTML = '<p>No hay avisos.</p>'; return; }
        const list = document.createElement('div'); list.style.display = 'grid'; list.style.gap = '12px';
        // determine lastSeen timestamp (parse robustly)
        const lastSeenIso = localStorage.getItem('notices:lastSeen');
        const lastSeen = lastSeenIso ? parseServerDate(lastSeenIso) : null;
        // apply search filter (client-side)
        const q = (el('noticeSearch') && el('noticeSearch').value) ? (el('noticeSearch').value||'').trim().toLowerCase() : '';
        if (q) {
          data = data.filter(n => ((n.title||'').toLowerCase().includes(q) || (n.body||'').toLowerCase().includes(q)));
        }
        data.forEach(n => {
          const card = document.createElement('div'); card.className = 'notice-card'; card.style.border = '1px solid #e2e8f0'; card.style.padding = '12px'; card.style.borderRadius = '8px'; card.style.background='#fff';
          const h = document.createElement('h4'); h.style.margin='0 0 6px 0'; h.style.display='flex'; h.style.alignItems='center';
          // title + date + new badge
          const titleSpan = document.createElement('span'); titleSpan.textContent = n.title || '';
          titleSpan.style.fontWeight='700';
          h.appendChild(titleSpan);
          if (n.createdAt){ const metaDate = parseServerDate(n.createdAt); const meta = document.createElement('span'); meta.className='notice-date'; meta.textContent = metaDate ? metaDate.toLocaleString() : String(n.createdAt); h.appendChild(meta); }
          const created = n.createdAt ? parseServerDate(n.createdAt) : null;
          let isNew = false;
          if (created) {
            isNew = (Date.now() - created.getTime()) <= (25 * 3600 * 1000);
          }
          if (isNew){ const badge = document.createElement('span'); badge.className='badge-new'; badge.textContent='Nuevo'; h.appendChild(badge); }
          const p = document.createElement('p'); p.innerHTML = escapeHtml(n.body || '').replace(/\r?\n/g,'<br>'); p.style.margin='8px 0';
          const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
          const btnEdit = document.createElement('button'); btnEdit.className='btn'; btnEdit.textContent='Editar'; btnEdit.onclick = ()=>{
            // replace card contents with inline edit form
            card.innerHTML = '';
            const formWrap = document.createElement('div'); formWrap.style.display='flex'; formWrap.style.flexDirection='column'; formWrap.style.gap='8px';
            const inTitle = document.createElement('input'); inTitle.className='form-input'; inTitle.value = n.title || '';
            const inBody = document.createElement('textarea'); inBody.className='form-input'; inBody.rows = 6; inBody.value = n.body || '';
            const inDate = document.createElement('input'); inDate.type = 'datetime-local'; inDate.className='form-input';
            try { if (n.createdAt) inDate.value = toLocalDateTimeInput(parseServerDate(n.createdAt)); } catch(e){}
            const btnSave = document.createElement('button'); btnSave.className='btn btn-primary'; btnSave.textContent='Guardar';
            const btnCancel = document.createElement('button'); btnCancel.className='btn'; btnCancel.textContent='Cancelar';
            const actionsEdit = document.createElement('div'); actionsEdit.style.display='flex'; actionsEdit.style.gap='8px'; actionsEdit.appendChild(btnSave); actionsEdit.appendChild(btnCancel);
            formWrap.appendChild(document.createElement('label')).textContent='Titulo'; formWrap.appendChild(inTitle);
            formWrap.appendChild(document.createElement('label')).textContent='Texto'; formWrap.appendChild(inBody);
            formWrap.appendChild(document.createElement('label')).textContent='Fecha (modificar para marcar como nuevo)'; formWrap.appendChild(inDate);
            formWrap.appendChild(actionsEdit);
            card.appendChild(formWrap);
            btnCancel.onclick = ()=>{ loadNoticesForManagement(); };
            btnSave.onclick = async ()=>{
              const newTitle = inTitle.value.trim(); const newBody = inBody.value.trim(); const newDateVal = inDate.value;
              const createdAt = newDateVal ? fromLocalDateTimeInput(newDateVal) : new Date().toISOString();
              await updateNotice(n.id, newTitle, newBody, createdAt);
            };
          };
          actions.appendChild(btnEdit);
          const btnDel = document.createElement('button'); btnDel.className='btn btn-danger'; btnDel.textContent='Borrar'; btnDel.onclick = async ()=>{
            if (!confirm('Eliminar aviso?')) return;
            try {
              const res = await fetch('/api/notices/' + n.id, { method: 'DELETE' });
              if (!res.ok) throw new Error('failed');
              showNotification('Aviso eliminado', 'success');
              loadNoticesForManagement();
              loadNoticesIntoHome();
            } catch (err) { showNotification('Error al borrar aviso', 'error'); }
          };
          actions.appendChild(btnDel);
          card.appendChild(h); card.appendChild(p); card.appendChild(actions);
          list.appendChild(card);
        });
        container.appendChild(list);
      })
        .catch(err=>{ container.innerHTML = `<p>Error cargando avisos: ${escapeHtml(err.message || '')}</p>`; console.error('loadNoticesForManagement error', err); });
  }

  function createNotice(){
    const title = (el('noticeTitle').value||'').trim();
    const body = (el('noticeBody').value||'').trim();
    const note = el('noticeNotification');
    if (!title) { if (note){ note.style.display='block'; note.innerText='El titulo es requerido.'; } return; }
    // reset previous notification
    if (note){ note.style.display='none'; note.innerText=''; }
    fetch('/api/notices', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ title, body }) })
      .then(async r => {
        const txt = await r.text().catch(()=>null);
        if (r.ok) {
          // parse if available
          try { return txt ? JSON.parse(txt) : null; } catch(e){ return null; }
        }
        // If server returned non-OK, try to verify if the notice was actually created by fetching recent notices
        try {
          const recent = await fetch('/api/notices?limit=10').then(rr=>rr.json()).catch(()=>[]);
          const found = (recent || []).some(n => (n.title||'').trim().toLowerCase() === title.toLowerCase());
          if (found) return null; // treat as success
        } catch(e){}
        // not found - propagate error text if present
        throw new Error(txt || `HTTP ${r.status}`);
      })
      .then(j=>{
        if (note){ note.className = 'notification success'; note.style.display='block'; note.innerText='Aviso creado.'; }
        // clear form
        if (el('noticeTitle')) el('noticeTitle').value = '';
        if (el('noticeBody')) el('noticeBody').value = '';
        // refresh management list and home notices but remain on notices page
        try { loadNoticesForManagement(); } catch(e){}
        try { loadNoticesIntoHome(); } catch(e){}
        // auto-hide success after a short delay
        if (note) setTimeout(()=>{ note.style.display='none'; }, 3000);
      })
      .catch(async e=>{
        // On error, try one last time to detect the created notice
        try {
          const recent = await fetch('/api/notices?limit=10').then(rr=>rr.json()).catch(()=>[]);
          const found = (recent || []).some(n => (n.title||'').trim().toLowerCase() === title.toLowerCase());
          if (found) {
            if (note){ note.className = 'notification success'; note.style.display='block'; note.innerText='Aviso creado (verificado).' }
            try { loadNoticesForManagement(); } catch(e){}
            try { loadNoticesIntoHome(); } catch(e){}
            if (note) setTimeout(()=>{ note.style.display='none'; }, 3000);
            return;
            return;
          }
        } catch(_){}
        if (note){ note.className = 'notification error'; note.style.display='block'; note.innerText = e?.message || 'Error creando aviso.'; }
        // refresh home to surface possible new notice
        loadNoticesIntoHome();
      });
  }

  function showView(){
    hideAllPages();
    clearDynamicResults();
    const view = el('viewPage');
    if (view) view.style.display = 'block';
  }

  async function showCategoriesPage(){
    // Update URL if not already on categories (avoid infinite loop)
    const currentHash = getHashRoute();
    if (currentHash !== '/categorias') {
      history.replaceState(null, '', '#/categorias');
    }
    
    // show categories SPA page
    el('homeView').style.display = 'none';
    el('viewPage').style.display = 'none';
    el('editor').style.display = 'none';
    el('categoriesPage').style.display = 'block';
    const np = el('noticesPage'); if (np) np.style.display = 'none';
    const dp = el('diagramsPage'); if (dp) dp.style.display = 'none';
    // Clear search results
    const main = el('contentArea');
    if (main) {
      const existingResults = main.querySelectorAll('.search-results');
      existingResults.forEach(r => r.remove());
    }
    await renderCategoriesPage();
  }

  async function renderCategoriesPage(){
    const container = el('categoriesContainer');
    container.innerHTML = '<p>Cargando categorias...</p>';

    // fetch all categories
    const all = await fetchJson('/api/categories');
    // build map id -> node
    const byId = {};
    all.forEach(c=> byId[c.id] = {...c, children: []});
    const roots = [];
    // build parent/child relationships; treat 0, null or missing as "no parent"
    all.forEach(c=>{
      const pid = c.parentId == null ? null : Number(c.parentId);
      if (pid && pid > 0) {
        if (byId[pid]) {
          byId[pid].children.push(byId[c.id]);
        } else {
          // parent not found (or missing), treat as root
          roots.push(byId[c.id]);
        }
      } else {
        roots.push(byId[c.id]);
      }
    });

    // populate parent select in create form with all categories (indented)
    const parentSel = el('newCatParent');
    parentSel.innerHTML = '<option value="">-- Ninguno (raiz) --</option>';
    // build a depth-first list with indentation
    function walk(node, level){
      const opt = document.createElement('option'); opt.value = node.id; opt.textContent = ' '.repeat(level*2) + node.name; parentSel.appendChild(opt);
      if (node.children) node.children.forEach(ch => walk(ch, level+1));
    }
    roots.forEach(r => walk(r, 0));

    container.innerHTML = '';

    function openEdit(node, cardEl){
      // replace content with inline form
      const form = document.createElement('div'); form.style.display='flex'; form.style.flexDirection='column'; form.style.gap='8px';
      const nameInput = document.createElement('input'); nameInput.value = node.name; nameInput.style.padding='8px';
      const parentSelect = document.createElement('select'); parentSelect.innerHTML = '<option value="">-- Ninguno --</option>';
      // build options - include all but remove node itself to avoid choosing self as parent
      all.forEach(c=>{
        if (c.id == node.id) return; // skip self
        const opt = document.createElement('option'); opt.value=c.id; opt.textContent = c.name; if (c.id == node.parentId) opt.selected=true; parentSelect.appendChild(opt);
      });
      const btnSave = document.createElement('button'); btnSave.className='btn primary'; btnSave.textContent='Guardar';
      const btnCancel = document.createElement('button'); btnCancel.className='btn'; btnCancel.textContent='Cancelar';

      form.appendChild(nameInput); form.appendChild(parentSelect);
      const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px'; actions.appendChild(btnSave); actions.appendChild(btnCancel); form.appendChild(actions);

      cardEl.innerHTML = ''; cardEl.appendChild(form);

      btnCancel.onclick = ()=> renderCategoriesPage();
      btnSave.onclick = async ()=>{
        const newName = nameInput.value.trim(); const newParent = parentSelect.value || null;
        if (!newName) return showNotification('Nombre requerido', 'error');
        try {
          await fetchJson('/api/categories/'+node.id, { method:'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ name: newName, parentId: newParent ? Number(newParent) : null }) });
          await refreshSharedState();
          await renderCategoriesPage();
          showNotification('Categoria actualizada', 'success');
        } catch (err){
          console.error('Failed to update category', err);
          showNotification('Error al actualizar categoria: '+ (err.message||err), 'error');
        }
      };
    }

    // render tree view under root 'Inicio' with improved visual hierarchy
    function buildNodeHtml(node, level = 0){
      const li = document.createElement('li');
      li.setAttribute('data-level', level);
      li.setAttribute('data-category-id', node.id);
      
      const nodeDiv = document.createElement('div'); nodeDiv.className = 'cat-node';
      
      // Add indentation based on level
      const indent = document.createElement('span'); 
      indent.style.display = 'inline-block'; 
      indent.style.width = (level * 24) + 'px';
      indent.innerHTML = level > 0 ? '- ' : '';
      indent.style.color = '#999';
      indent.style.fontSize = '0.9em';
      
      const caret = document.createElement('span'); 
      caret.className = 'caret'; 
      caret.textContent = node.children && node.children.length ? '+' : '-';
      caret.style.marginRight = '8px';
      if (!node.children || !node.children.length) caret.style.color = '#ccc';
      
      const name = document.createElement('span'); 
      name.className = 'name'; 
      name.textContent = node.name;
      name.style.fontWeight = level === 0 ? 'bold' : 'normal';
      name.style.color = level === 0 ? '#2c5282' : '#4a5568';
      
      const badge = document.createElement('span');
      badge.style.marginLeft = '8px';
      badge.style.fontSize = '0.75em';
      badge.style.padding = '2px 6px';
      badge.style.borderRadius = '3px';
      badge.style.backgroundColor = level === 0 ? '#e6f2ff' : '#f7fafc';
      badge.style.color = level === 0 ? '#2c5282' : '#718096';
      badge.textContent = !node.parentId ? 'Raiz' : 'Subcategoria';
      
      const actions = document.createElement('div'); actions.className = 'node-actions';
      const btnView = document.createElement('button'); btnView.className='btn'; btnView.textContent='Ver'; btnView.title='Ver paginas'; btnView.onclick = async (e)=>{ e.stopPropagation(); const list = await fetchJson('/api/pages?categoryId='+node.id); showListResults(list, node.name, { sourceLabel: 'Categoria' }); };
      const btnEdit = document.createElement('button'); btnEdit.className='btn'; btnEdit.textContent='Editar'; btnEdit.onclick = (e)=>{ e.stopPropagation(); openEdit(node, li); };
      const btnDel = document.createElement('button'); btnDel.className='btn'; btnDel.textContent='Borrar'; btnDel.onclick = async (e)=>{ e.stopPropagation(); if (!confirm('Eliminar categoria? Esto quitara las asociaciones con paginas.')) return; await fetchJson('/api/categories/'+node.id, { method:'DELETE' }); await refreshSharedState(); await renderCategoriesPage(); showNotification('Categoria eliminada', 'success'); };
      actions.appendChild(btnView); actions.appendChild(btnEdit); actions.appendChild(btnDel);

      nodeDiv.appendChild(indent); 
      nodeDiv.appendChild(caret); 
      nodeDiv.appendChild(name);
      nodeDiv.appendChild(badge);
      nodeDiv.appendChild(actions);
      li.appendChild(nodeDiv);

      if (node.children && node.children.length){
        const ul = document.createElement('ul'); ul.className = 'cat-children'; ul.style.display = 'none';
        ul.style.borderLeft = '2px solid #e2e8f0';
        ul.style.marginLeft = (level * 24 + 12) + 'px';
        ul.style.paddingLeft = '12px';
        node.children.forEach(ch => ul.appendChild(buildNodeHtml(ch, level + 1)));
        li.appendChild(ul);
        // caret click toggles expand and updates display and caret icon
        function collapse(){ ul.style.display = 'none'; caret.textContent = '+'; }
        function expand(){ ul.style.display = 'block'; caret.textContent = '-'; }
        collapse();
        caret.onclick = (ev)=>{ ev.stopPropagation(); if (ul.style.display === 'none') expand(); else collapse(); };
        name.onclick = (ev)=>{ ev.stopPropagation(); if (ul.style.display === 'none') expand(); else collapse(); };
      }

      return li;
    }

    container.innerHTML = '';
    const treeWrap = document.createElement('div'); treeWrap.className = 'cat-tree';
    const rootUl = document.createElement('ul');
    const rootLi = document.createElement('li');
    const rootDiv = document.createElement('div'); rootDiv.className = 'cat-node';
    const rootCaret = document.createElement('span'); rootCaret.className = 'caret'; rootCaret.textContent = '+';
    const rootName = document.createElement('span'); rootName.className = 'name'; rootName.textContent = 'Inicio';
    rootDiv.appendChild(rootCaret); rootDiv.appendChild(rootName);
    rootLi.appendChild(rootDiv);
    const rootChildrenUl = document.createElement('ul'); rootChildrenUl.style.display = 'none';
    roots.forEach(r=> rootChildrenUl.appendChild(buildNodeHtml(r)));
    rootLi.appendChild(rootChildrenUl);
    // default EXPANDED (root expanded by default) with caret behavior
    function collapseRoot(){ rootChildrenUl.style.display='none'; rootCaret.textContent='+'; }
    function expandRoot(){ rootChildrenUl.style.display='block'; rootCaret.textContent='-'; }
    expandRoot(); // START EXPANDED
    rootCaret.onclick = (e)=>{ e.stopPropagation(); if (rootChildrenUl.style.display==='none') expandRoot(); else collapseRoot(); };
    rootName.onclick = (e)=>{ e.stopPropagation(); if (rootChildrenUl.style.display==='none') expandRoot(); else collapseRoot(); };
    rootUl.appendChild(rootLi);
    treeWrap.appendChild(rootUl);
    container.appendChild(treeWrap);

    // search handler for SPA categories
    const catSearch = document.getElementById('catSearch');
    function matchesNode(li, q){
      q = (q||'').trim().toLowerCase(); if (!q) return true;
      const txt = (li.querySelector('.name')?.textContent || '').toLowerCase(); if (txt.indexOf(q)!==-1) return true;
      // check descendants
      const childUl = li.querySelector('ul'); if (childUl){ const lis = childUl.querySelectorAll('li'); for (let i=0;i<lis.length;i++){ if ((lis[i].querySelector('.name')?.textContent||'').toLowerCase().indexOf(q)!==-1) return true; } }
      return false;
    }
    function applySearch(){
      const q = (catSearch.value||'').trim().toLowerCase();
      const list = treeWrap.querySelectorAll('li');
      list.forEach(li =>{
        // only handle list items that contain a node name
        if (!li.querySelector('.name')) return;
        if (matchesNode(li,q)){
          li.style.display = '';
          // ensure ancestors are visible/expanded
          let parent = li.parentElement;
          while (parent && parent !== treeWrap){
            if (parent.tagName === 'UL') parent.style.display = 'block';
            if (parent.tagName === 'LI'){
              const caret = parent.querySelector('.caret'); if (caret) caret.textContent = '-';
            }
            parent = parent.parentElement;
          }
        } else {
          li.style.display = 'none';
        }
      });
    }
    if (catSearch){ catSearch.oninput = function(){ if (!this.value){ // reset to initial state
        // Collapse all children ULs except root
        treeWrap.querySelectorAll('ul').forEach(u=>{ if (u !== rootChildrenUl && u !== rootUl) u.style.display = 'none'; });
        // Keep root EXPANDED
        rootChildrenUl.style.display = 'block';
        // Reset all carets to collapsed state
        treeWrap.querySelectorAll('.caret').forEach(c=>{ if (c !== rootCaret && c.textContent.trim()) c.textContent='+'; });
        // Root caret should show expanded
        rootCaret.textContent='-';
        // Make all li items visible
        treeWrap.querySelectorAll('li').forEach(li=>{ if (li.querySelector('.name')) li.style.display=''; });
      } else { applySearch(); } } }

    // bind create form

    // bind create form
    const form = el('catCreateForm');
    if (form){
      const createHandler = async ev => {
        if (ev) ev.preventDefault();
        try {
          const name = (el('newCatName').value || '').trim();
          const parent = el('newCatParent').value || null;
          if (!name) return showNotification('Nombre requerido', 'error');
          const btn = el('catCreateBtn'); if (btn) btn.disabled = true;
          await fetchJson('/api/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: parent ? Number(parent) : null }) });
          el('newCatName').value = '';
          await refreshSharedState();
          await renderCategoriesPage();
          showNotification('Categoria creada', 'success');
        } catch (err) {
          console.error('Failed to create category', err);
          showNotification('Error al crear categoria: ' + (err.message || err), 'error');
        } finally {
          const btn = el('catCreateBtn'); if (btn) btn.disabled = false;
        }
      };
      form.onsubmit = createHandler;
      const btn = el('catCreateBtn'); if (btn) btn.onclick = createHandler;
    }
  }

  async function openPage(slug){
    const p = await fetchJson('/api/pages/' + encodeURIComponent(slug));
    if (!p){ showNotification('Pagina no encontrada','error'); return navigateTo('/'); }
    
    // Update URL if not already on this article (avoid infinite loop)
    const currentHash = getHashRoute();
    const expectedHash = `/articulo/${slug}`;
    if (currentHash !== expectedHash) {
      history.replaceState(null, '', `#${expectedHash}`);
    }
    
    el('viewTitle').textContent = p.title;
    el('viewHtml').innerHTML = p.htmlContent || '';
    el('viewMeta').textContent = `Ultima edicion: ${new Date(p.updatedAt).toLocaleString()} | Categorias: ${(p.categories||'').split(',').map(s=>s.trim()).filter(x=>x).join(', ')}`;
    el('breadcrumbs').innerHTML = `<a href='#/' onclick='event.preventDefault();'>Inicio</a> > ${p.title}`;
    el('btnEdit').onclick = ()=> navigateTo(`/editar/${p.slug}`);
    const btnCopyLink = el('btnCopyLink');
    if (btnCopyLink) {
      btnCopyLink.onclick = async ()=> {
        try {
          await navigator.clipboard.writeText(window.location.href);
          showNotification('Enlace copiado al portapapeles', 'success', 1800);
        } catch (err) {
          showNotification('No se pudo copiar el enlace', 'error');
        }
      };
    }
    el('btnDelete').onclick = async ()=> {
      if (!confirm(`Estas seguro de que quieres eliminar "${p.title}"?\n\nEsta accion no se puede deshacer.`)) return;
      try {
        await fetchJson('/api/pages/' + encodeURIComponent(slug), { method: 'DELETE' });
        showNotification('Articulo eliminado correctamente', 'success');
        await refreshSharedState();
        navigateTo('/');
      } catch (err) {
        showNotification('Error al eliminar el articulo: ' + (err.message || err), 'error');
        console.error(err);
      }
    };
    showView();
  }

  function ensureEditorInstance(){
    if (window.quillInstance && window.quillInstance.root) return window.quillInstance;

    const editorHost = el('quillEditor');
    if (!editorHost) return null;

    if (window.Quill) {
      window.quillInstance = new Quill('#quillEditor', {
        theme: 'snow',
        modules: {
          toolbar: [
            [{ 'header': [1, 2, 3, 4, 5, 6, false] }],
            ['bold', 'italic', 'underline', 'strike'],
            [{ 'color': [] }, { 'background': [] }],
            [{ 'list': 'ordered' }, { 'list': 'bullet' }],
            [{ 'indent': '-1' }, { 'indent': '+1' }],
            [{ 'align': [] }],
            ['blockquote', 'code-block'],
            ['link', 'image'],
            ['clean']
          ]
        },
        placeholder: 'Escribe el contenido de tu articulo aqui...'
      });
      return window.quillInstance;
    }

    editorHost.classList.add('basic-editor-fallback');
    editorHost.setAttribute('contenteditable', 'true');
    editorHost.setAttribute('data-placeholder', 'Escribe el contenido del articulo aqui...');
    window.quillInstance = { root: editorHost, __fallback: true };

    if (!window.__editorFallbackWarned) {
      window.__editorFallbackWarned = true;
      showNotification('Editor enriquecido no disponible. Se activa el modo basico.', 'error', 3000);
    }

    return window.quillInstance;
  }

  function setEditorHtml(html){
    const instance = ensureEditorInstance();
    if (!instance || !instance.root) return;
    instance.root.innerHTML = html || '';
  }

  function getEditorHtml(){
    const instance = ensureEditorInstance();
    return instance && instance.root ? instance.root.innerHTML : '';
  }

  function loadEditor(page){
    // Update URL based on create/edit mode (avoid infinite loop)
    const currentHash = getHashRoute();
    if (page) {
      const expectedHash = `/editar/${page.slug}`;
      if (currentHash !== expectedHash) {
        history.replaceState(null, '', `#${expectedHash}`);
      }
    } else {
      if (currentHash !== '/crear') {
        history.replaceState(null, '', '#/crear');
      }
    }
    
    showEditor();
    
    ensureEditorInstance();
    
    // Update titles
    el('editorTitle').textContent = page ? 'Editar articulo' : 'Crear pagina';
    el('editorSubtitle').textContent = page ? 'Modifica el contenido de este articulo' : 'Crear un nuevo procedimiento.';
    
    // Fill form
    el('titleInput').value = page?.title || '';
    setEditorHtml(page?.htmlContent || '');
    
    // Reset category selector (will be populated after categories load)
    window.selectedCategoriesSPA = [];
    renderSelectedCategoriesSPA();
    
    // Setup auto-slug preview
    setupSlugPreview();
    
    // Load categories and setup selector
    loadCategoriesForEditor().then(() => {
      setupCategorySelectorSPA();
      setupQuickCategoryCreator();
      populateCategoryDropdown();
      populateQuickCategoryParentOptions();
      resetQuickCategoryCreatePanel();
      // If editing an existing page, pre-select its categories in the selector
      try {
        if (page && page.categories) {
          const names = getPageCategoryNames(page);
          const categoryLookup = buildCategoryNameLookup(allCategories);
          window.selectedCategoriesSPA = [];
          names.forEach(nm => {
            const cat = categoryLookup.get(normalizeText(nm));
            if (cat) window.selectedCategoriesSPA.push({ id: cat.id, name: cat.name });
          });
          renderSelectedCategoriesSPA();
        }
      } catch (e) { console.warn('Preselect categories failed', e); }
    });
    
    // Save button
    el('btnSave').onclick = async ()=>{
      console.log('Guardando articulo...');
      const title = el('titleInput').value.trim();
      if (!title) {
        showNotification('El titulo es requerido', 'error');
        return;
      }
      
      const slug = page ? page.slug : slugify(title);
      const html = getEditorHtml();
      // Backend espera nombres de categorias (CSV), no IDs
      const categoryNames = window.selectedCategoriesSPA.map(c => c.name).join(',');
      
      const payload = { 
        id: page?.id || 0,
        slug, 
        title, 
        htmlContent: html, 
        categories: categoryNames 
      };
      
      console.log('Payload:', payload);
      
      try {
        const btnSave = el('btnSave');
        if (btnSave) btnSave.disabled = true;
        
        const result = await fetchJson('/api/pages', { 
          method:'POST', 
          headers:{'content-type':'application/json'}, 
          body:JSON.stringify(payload) 
        });
        
        console.log('Articulo guardado:', result);
        showNotification('Articulo guardado correctamente', 'success');
        await refreshSharedState();
        navigateTo(`/articulo/${result?.slug || slug}`);
      } catch (err) {
        console.error('Error al guardar:', err);
        showNotification('Error al guardar el articulo: ' + (err.message || err), 'error');
      } finally {
        const btnSave = el('btnSave');
        if (btnSave) btnSave.disabled = false;
      }
    };
  }

  function slugify(text) {
    if (!text) return '';
    return text.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  function getCategoryRootName(category) {
    return category.path && category.path.length ? category.path[0] : category.name;
  }

  function compareCategoriesForSelector(a, b) {
    const rootCompare = getCategoryRootName(a).localeCompare(getCategoryRootName(b));
    if (rootCompare !== 0) return rootCompare;

    const depthCompare = (a.path?.length || 0) - (b.path?.length || 0);
    if (depthCompare !== 0) return depthCompare;

    const pathA = [...(a.path || []), a.name].join(' > ');
    const pathB = [...(b.path || []), b.name].join(' > ');
    return pathA.localeCompare(pathB);
  }

  function getCategoryOptionLabel(category) {
    if (!category.parentId) return `${category.name} (Raiz)`;
    const fullPath = [...(category.path || []), category.name];
    return fullPath.slice(1).join(' > ');
  }

  function populateGroupedCategorySelect(select, placeholderText, selectedValue = '') {
    if (!select) return;

    select.innerHTML = '';
    if (placeholderText) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = placeholderText;
      select.appendChild(placeholder);
    }

    const groups = new Map();
    [...allCategories]
      .sort(compareCategoriesForSelector)
      .forEach(category => {
        const rootName = getCategoryRootName(category);
        if (!groups.has(rootName)) groups.set(rootName, []);
        groups.get(rootName).push(category);
      });

    groups.forEach((items, rootName) => {
      const group = document.createElement('optgroup');
      group.label = rootName;

      items.forEach(category => {
        const option = document.createElement('option');
        option.value = category.id;
        option.dataset.name = category.name;
        option.textContent = getCategoryOptionLabel(category);
        if (String(category.id) === String(selectedValue)) option.selected = true;
        group.appendChild(option);
      });

      select.appendChild(group);
    });
  }

  function populateCategoryDropdown() {
    const select = el('categorySelectSPA');
    if (!select) {
      console.warn('categorySelectSPA no encontrado');
      return;
    }

    populateGroupedCategorySelect(select, '-- Selecciona una categoria --');
    
    select.onchange = function() {
      if (this.value) {
        const id = parseInt(this.value);
        const name = this.options[this.selectedIndex].dataset.name;
        console.log('Categoria seleccionada:', id, name);
        toggleCategorySPA(id, name);
        this.value = ''; // Reset select
      }
    };
    
    console.log('Desplegable poblado con', allCategories.length, 'categorias');
  }

  function populateQuickCategoryParentOptions(selectedValue = '') {
    const select = el('quickCategoryParent');
    if (!select) return;
    populateGroupedCategorySelect(select, '-- Categoria raiz --', selectedValue);
  }
  
  function setupSlugPreview() {
    const titleInput = el('titleInput');
    const slugPreview = el('slugPreviewSPA');
    
    titleInput.oninput = function() {
      const slug = slugify(this.value);
      if (slug) {
        slugPreview.textContent = slug;
        slugPreview.style.display = 'inline-block';
      } else {
        slugPreview.style.display = 'none';
      }
    };
    
    // Trigger on load
    if (titleInput.value) {
      titleInput.dispatchEvent(new Event('input'));
    } else {
      slugPreview.style.display = 'none';
    }
  }

  function setupCategorySelectorSPA() {
    const categoryInput = el('categoryInputSPA');
    const categoryDropdown = el('categoryDropdownSPA');
    const clearCatInput = el('clearCatInputSPA');
    const catInputWrapper = el('catInputWrapperSPA');
    
    categoryInput.oninput = function() {
      const query = normalizeText(this.value);
      catInputWrapper.classList.toggle('has-value', query.length > 0);
      
      if (query.length === 0) {
        categoryDropdown.classList.remove('show');
        return;
      }
      
      // Fuzzy search
      const filtered = allCategories.filter(cat => {
        const nameMatch = normalizeText(cat.name).includes(query);
        const pathMatch = cat.path && cat.path.some(p => normalizeText(p).includes(query));
        return nameMatch || pathMatch;
      }).sort(compareCategoriesForSelector).slice(0, 10);
      
      if (filtered.length > 0) {
        renderCategoryDropdownSPA(filtered);
        categoryDropdown.classList.add('show');
      } else {
        categoryDropdown.classList.remove('show');
      }
    };
    
    categoryInput.onfocus = function() {
      if (this.value.length > 0 && categoryDropdown.children.length > 0) {
        categoryDropdown.classList.add('show');
      }
    };
    
    clearCatInput.onclick = function() {
      categoryInput.value = '';
      categoryInput.focus();
      catInputWrapper.classList.remove('has-value');
      categoryDropdown.classList.remove('show');
    };
  }

  function resetQuickCategoryCreatePanel() {
    const panel = el('quickCategoryCreatePanel');
    const nameInput = el('quickCategoryName');
    if (panel) panel.hidden = true;
    if (nameInput) nameInput.value = '';
    populateQuickCategoryParentOptions();
  }

  function setupQuickCategoryCreator() {
    const toggleBtn = el('toggleQuickCategoryCreate');
    const panel = el('quickCategoryCreatePanel');
    const createBtn = el('quickCategoryCreateBtn');
    const cancelBtn = el('quickCategoryCancelBtn');
    const nameInput = el('quickCategoryName');
    const categoryDropdown = el('categoryDropdownSPA');
    const categoryInput = el('categoryInputSPA');
    if (!toggleBtn || !panel || !createBtn || !cancelBtn || !nameInput) return;

    toggleBtn.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        populateQuickCategoryParentOptions();
        nameInput.focus();
      }
    };

    cancelBtn.onclick = () => resetQuickCategoryCreatePanel();

    createBtn.onclick = async () => {
      const name = (nameInput.value || '').trim();
      const parentId = el('quickCategoryParent').value || null;
      if (!name) {
        showNotification('El nombre de la categoria es requerido', 'error');
        return;
      }

      createBtn.disabled = true;
      try {
        const created = await fetchJson('/api/categories', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, parentId: parentId ? Number(parentId) : null })
        });

        await refreshSharedState();
        await loadCategoriesForEditor();
        populateCategoryDropdown();
        populateQuickCategoryParentOptions();

        if (created && !window.selectedCategoriesSPA.some(cat => cat.id === created.id)) {
          window.selectedCategoriesSPA.push({ id: created.id, name: created.name });
          renderSelectedCategoriesSPA();
        }

        if (categoryInput) categoryInput.value = '';
        if (categoryDropdown) categoryDropdown.classList.remove('show');

        resetQuickCategoryCreatePanel();
        showNotification('Categoria creada y seleccionada', 'success');
      } catch (err) {
        console.error('Error creating category from editor', err);
        showNotification('Error al crear la categoria: ' + (err.message || err), 'error');
      } finally {
        createBtn.disabled = false;
      }
    };
  }

  function renderCategoryDropdownSPA(categories) {
    const categoryDropdown = el('categoryDropdownSPA');
    categoryDropdown.innerHTML = categories.map(cat => {
      const isSelected = window.selectedCategoriesSPA.some(sc => sc.id === cat.id);
      const pathStr = cat.path && cat.path.length > 0 ? cat.path.join(' > ') + ' > ' : '';
      const badge = !cat.parentId ? '<span class="cat-badge">Raiz</span>' : '';
      
      return `
        <div class="category-option ${isSelected ? 'selected' : ''}" data-id="${cat.id}" data-name="${cat.name}">
          <div style="flex: 1;">
            <div class="cat-name">${cat.name} ${badge}</div>
            ${pathStr ? `<div class="cat-path">${pathStr}</div>` : ''}
          </div>
          ${isSelected ? '<span style="color: #2563eb;">OK</span>' : ''}
        </div>
      `;
    }).join('');
    
    categoryDropdown.querySelectorAll('.category-option').forEach(opt => {
      opt.addEventListener('click', function() {
        const id = parseInt(this.dataset.id);
        const name = this.dataset.name;
        toggleCategorySPA(id, name);
      });
    });
  }

  function toggleCategorySPA(id, name) {
    const index = window.selectedCategoriesSPA.findIndex(sc => sc.id === id);
    
    if (index > -1) {
      window.selectedCategoriesSPA.splice(index, 1);
    } else {
      window.selectedCategoriesSPA.push({ id, name });
    }
    
    renderSelectedCategoriesSPA();
    
    // Refresh dropdown
    const categoryInput = el('categoryInputSPA');
    if (categoryInput.value.length > 0) {
      categoryInput.dispatchEvent(new Event('input'));
    }
  }

  function renderSelectedCategoriesSPA() {
    const container = el('selectedCategoriesSPA');
    container.innerHTML = window.selectedCategoriesSPA.map(cat => `
      <span class="selected-cat-tag">
        ${cat.name}
        <span class="remove" data-id="${cat.id}">x</span>
      </span>
    `).join('');
    
    container.querySelectorAll('.remove').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = parseInt(this.dataset.id);
        const cat = window.selectedCategoriesSPA.find(sc => sc.id === id);
        if (cat) toggleCategorySPA(cat.id, cat.name);
      });
    });
  }

  function bindToolbar(){
    document.querySelectorAll('#toolbar button').forEach(btn=>{
      btn.onclick = ()=>{
        const cmd = btn.getAttribute('data-cmd');
        if (cmd === 'createLink'){
          const url = prompt('URL'); if (url) document.execCommand('createLink', false, url);
        } else if (cmd === 'insertImage'){
          const url = prompt('URL de la imagen'); if (url) document.execCommand('insertImage', false, url);
        } else {
          document.execCommand(cmd, false, null);
        }
      };
    });
  }

  async function search(q, options = {}){
    q = (q||'').trim();

    if (!q) {
      if (appState.searchController) {
        try { appState.searchController.abort(); } catch(_){}
        appState.searchController = null;
      }
      appState.currentSearch = '';
      await refreshUI({ preserveRoute: true });
      if (appState.routeBeforeSearch && appState.routeBeforeSearch !== '/' && appState.routeBeforeSearch !== '') {
        const restore = appState.routeBeforeSearch;
        appState.routeBeforeSearch = null;
        if (getHashRoute() !== restore) {
          navigateTo(restore);
        } else {
          await router();
        }
      } else {
        appState.routeBeforeSearch = null;
        showHome({ syncUrl: false });
      }
      return;
    }

    await ensureBootstrap();
    if (!appState.currentSearch) {
      appState.routeBeforeSearch = getHashRoute();
    }
    appState.currentSearch = q;

    const localResults = runLocalSearch(q);
    showListResults(localResults, null, { query: q, loading: true, sourceLabel: localResults.length ? 'Coincidencias rapidas' : 'Buscando...' });

    if (appState.searchController) {
      try { appState.searchController.abort(); } catch(_){}
    }

    const controller = new AbortController();
    const token = ++appState.searchToken;
    appState.searchController = controller;

    try {
      const res = await fetchJson('/api/search?q=' + encodeURIComponent(q), { signal: controller.signal });
      if (token !== appState.searchToken || appState.currentSearch !== q) return;
      const merged = mergeSearchResults(localResults, res || []);
      showListResults(merged, null, { query: q, sourceLabel: 'Busqueda completa' });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error('search failed', err);
      if (token === appState.searchToken) {
        showListResults(localResults, null, { query: q, sourceLabel: 'Coincidencias rapidas' });
      }
    } finally {
      if (appState.searchController === controller) appState.searchController = null;
    }
  }

  async function refreshUI(options = {}){
    const { force = false, preserveRoute = false } = options;
    await ensureBootstrap(force);
    await renderLatest();
    await refreshCategories();
    if (!preserveRoute) showHome({ syncUrl: true });
  }

  async function refreshSharedState() {
    await ensureBootstrap(true);
    await renderLatest();
    await refreshCategories();
  }

  // 2026 UI and performance overrides
  function formatPageMeta(page){
    const parts = [];
    if (page && page.categories) parts.push(page.categories);
    if (page && page.updatedAt) parts.push(new Date(page.updatedAt).toLocaleString());
    return parts.join(' | ');
  }

  async function renderLatest(){
    await ensureBootstrap();
    const list = [...(appState.pages || [])]
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 8);

    const ul = el('featuredList');
    if (!ul) return;

    ul.className = 'featured-list';
    ul.innerHTML = '';

    const fragment = document.createDocumentFragment();
    for (const page of list) {
      const li = document.createElement('li');
      li.className = 'featured-entry';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'featured-link';
      button.innerHTML = `
        <span class="featured-title">${escapeHtml(page.title || '(sin titulo)')}</span>
        <span class="featured-meta">${escapeHtml(formatPageMeta(page) || 'Sin contexto adicional')}</span>
        ${page.excerpt ? `<span class="featured-excerpt">${escapeHtml(page.excerpt)}</span>` : ''}
      `;
      button.onclick = () => navigateTo(`/articulo/${page.slug}`);

      li.appendChild(button);
      fragment.appendChild(li);
    }

    ul.appendChild(fragment);
    renderDashboardStats();
  }

  function showListResults(list, categoryName = null, options = {}){
    const main = el('contentArea');
    if (!main) return;

    const query = (options.query || '').trim();
    const loading = !!options.loading;
    const sourceLabel = options.sourceLabel || '';
    const items = dedupePages(Array.isArray(list) ? list : []);

    hideAllPages();
    clearDynamicResults();

    const shell = document.createElement('section');
    shell.className = 'search-results search-shell';

    const header = document.createElement('div');
    header.className = 'results-header';

    const copy = document.createElement('div');
    const kicker = document.createElement('p');
    kicker.className = 'results-kicker';
    kicker.textContent = categoryName ? 'Categoria' : (query ? 'Busqueda global' : 'Listado');

    const title = document.createElement('h2');
    if (categoryName) {
      title.textContent = `${categoryName} (${items.length})`;
    } else if (query) {
      title.textContent = `Resultados para "${query}"`;
    } else {
      title.textContent = `Resultados (${items.length})`;
    }

    const summary = document.createElement('p');
    summary.className = 'results-summary';
    if (items.length === 0) {
      summary.textContent = query
        ? 'No hemos encontrado coincidencias. Prueba otra palabra o una categoria.'
        : 'No hay elementos para mostrar.';
    } else {
      summary.textContent = `${items.length} articulo(s) visibles ahora.`;
    }

    copy.appendChild(kicker);
    copy.appendChild(title);
    copy.appendChild(summary);

    const status = document.createElement('div');
    status.className = 'results-status';
    status.textContent = loading ? 'Actualizando...' : (sourceLabel || 'Resultados listos');

    header.appendChild(copy);
    header.appendChild(status);
    shell.appendChild(header);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = `
        <strong>Sin resultados</strong>
        <p>Prueba un termino mas corto, busca por una categoria o revisa la ortografia.</p>
      `;
      shell.appendChild(empty);
      main.appendChild(shell);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'results-list';

    const fragment = document.createDocumentFragment();
    for (const page of items) {
      const li = document.createElement('li');
      li.className = 'result-card';

      const link = document.createElement('a');
      link.href = `#/articulo/${page.slug}`;
      link.className = 'result-title-link';
      link.textContent = page.title || '(sin titulo)';
      link.onclick = ev => {
        ev.preventDefault();
        navigateTo(`/articulo/${page.slug}`);
      };

      const meta = document.createElement('div');
      meta.className = 'result-meta';
      meta.textContent = formatPageMeta(page);

      li.appendChild(link);
      if (meta.textContent) li.appendChild(meta);

      if (page.excerpt) {
        const excerpt = document.createElement('p');
        excerpt.className = 'result-excerpt';
        excerpt.textContent = page.excerpt;
        li.appendChild(excerpt);
      }

      fragment.appendChild(li);
    }

    ul.appendChild(fragment);
    shell.appendChild(ul);
    main.appendChild(shell);
  }

  async function loadCategoriesForEditor() {
    try {
      await ensureBootstrap();
      const categories = (appState.categories && appState.categories.length)
        ? appState.categories
        : await fetchJson('/api/categories');

      const byId = {};
      categories.forEach(category => {
        byId[category.id] = { ...category, children: [], path: [] };
      });

      categories.forEach(category => {
        const parentId = category.parentId;
        if (parentId && byId[parentId]) {
          byId[parentId].children.push(byId[category.id]);
        }
      });

      function buildPath(category) {
        if (category.parentId && byId[category.parentId]) {
          const parent = byId[category.parentId];
          if (parent.path.length === 0) buildPath(parent);
          category.path = [...parent.path, parent.name];
        }
      }

      categories.forEach(category => buildPath(byId[category.id]));
      allCategories = categories.map(category => byId[category.id]);
    } catch (err) {
      console.error('Error loading categories:', err);
      allCategories = [];
    }
  }

  function showHome(options = {}){
    const { syncUrl = true } = options;
    const currentHash = getHashRoute();
    if (syncUrl && currentHash !== '/' && currentHash !== '') {
      history.replaceState(null, '', '#/');
    }

    hideAllPages();
    clearDynamicResults();

    const home = el('homeView');
    if (home) home.style.display = 'grid';

    const noticesList = el('noticesList');
    if (noticesList) noticesList.className = 'notice-stream';

    renderDashboardStats();
    try { loadNoticesIntoHome(); } catch (e) { console.warn('Could not load notices', e); }
    try {
      if (window.homeIncidentsLoader) {
        window.homeIncidentsLoader();
      }
    } catch (e) {
      console.warn('Could not load incidents summary', e);
    }
  }

  async function refreshCategories(){
    await ensureBootstrap();
    const all = appState.categories || [];
    const pages = appState.pages || [];
    const sidebar = el('sidebarList');
    if (!sidebar) return;
    const categoryLookup = buildCategoryNameLookup(all);

    const byId = {};
    all.forEach(category => {
      byId[category.id] = { ...category, children: [], pages: [] };
    });

    all.forEach(category => {
      const parentId = category.parentId;
      if (parentId && byId[parentId]) {
        byId[parentId].children.push(byId[category.id]);
      }
    });

    pages.forEach(page => {
      const names = getPageCategoryNames(page);
      names.forEach(name => {
        const match = categoryLookup.get(normalizeText(name));
        if (match && byId[match.id]) {
          byId[match.id].pages.push(page);
        }
      });
    });

    Object.values(byId).forEach(node => {
      node.children.sort((a, b) => a.name.localeCompare(b.name));
      node.pages.sort((a, b) => a.title.localeCompare(b.title));
    });

    const roots = Object.values(byId)
      .filter(node => !node.parentId)
      .sort((a, b) => a.name.localeCompare(b.name));

    sidebar.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const homeItem = document.createElement('li');
    homeItem.className = 'sidebar-home';
    homeItem.innerHTML = `<button type="button" class="sidebar-home-link">Inicio</button>`;
    homeItem.querySelector('button').onclick = () => showHome();
    fragment.appendChild(homeItem);

    const divider = document.createElement('li');
    divider.className = 'sidebar-divider';
    fragment.appendChild(divider);

    function buildNode(node, level = 0){
      const li = document.createElement('li');
      li.className = 'sidebar-branch';

      const row = document.createElement('div');
      row.className = 'sidebar-node';
      row.style.setProperty('--level', level);

      const hasNested = node.children.length > 0 || node.pages.length > 0;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'sidebar-node-toggle';
      toggle.textContent = hasNested ? '+' : '';
      toggle.disabled = !hasNested;

      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'sidebar-node-link';
      link.textContent = node.name;
      let nested = null;
      link.onclick = async () => {
        if (nested && nested.hidden) {
          nested.hidden = false;
          toggle.textContent = '-';
        }
        await filterByCategory(node.id);
      };

      row.appendChild(toggle);
      row.appendChild(link);
      li.appendChild(row);

      if (hasNested) {
        nested = document.createElement('div');
        nested.className = 'sidebar-nested';
        nested.hidden = true;

        if (node.children.length) {
          const children = document.createElement('ul');
          children.className = 'sidebar-tree';
          node.children.forEach(child => children.appendChild(buildNode(child, level + 1)));
          nested.appendChild(children);
        }

        if (node.pages.length) {
          const pageList = document.createElement('ul');
          pageList.className = 'sidebar-pages';
          node.pages.forEach(page => {
            const pageItem = document.createElement('li');
            pageItem.innerHTML = `<button type="button" class="sidebar-page-link">${escapeHtml(page.title || '(sin titulo)')}</button>`;
            pageItem.querySelector('button').onclick = () => navigateTo(`/articulo/${page.slug}`);
            pageList.appendChild(pageItem);
          });
          nested.appendChild(pageList);
        }

        toggle.onclick = () => {
          nested.hidden = !nested.hidden;
          toggle.textContent = nested.hidden ? '+' : '-';
        };

        li.appendChild(nested);
      }

      return li;
    }

    roots.forEach(root => fragment.appendChild(buildNode(root)));
    sidebar.appendChild(fragment);
  }

  async function filterByCategory(categoryId){
    await ensureBootstrap();
    const allCategories = appState.categories || [];
    const allPages = appState.pages || [];
    const category = allCategories.find(item => item.id === categoryId);

    if (!category) {
      showNotification('Categoria no encontrada', 'error');
      return;
    }

    const children = allCategories
      .filter(item => item.parentId === categoryId)
      .sort((a, b) => a.name.localeCompare(b.name));

    const articles = allPages.filter(page => {
      const names = getPageCategoryNames(page);
      return names.some(name => normalizeText(name) === normalizeText(category.name));
    });

    showCategoryContent(category, children, articles);
  }

  function showCategoryContent(category, children, articles) {
    const main = el('contentArea');
    if (!main) return;

    hideAllPages();
    clearDynamicResults();

    const shell = document.createElement('section');
    shell.className = 'search-results search-shell category-shell';

    const header = document.createElement('div');
    header.className = 'results-header';

    const copy = document.createElement('div');
    const kicker = document.createElement('p');
    kicker.className = 'results-kicker';
    kicker.textContent = 'Categoria';

    const title = document.createElement('h2');
    title.textContent = `Contenido de ${category.name}`;

    const summary = document.createElement('p');
    summary.className = 'results-summary';
    summary.textContent = `${children.length} subcategoria(s) y ${articles.length} articulo(s) visibles.`;

    copy.appendChild(kicker);
    copy.appendChild(title);
    copy.appendChild(summary);
    header.appendChild(copy);
    shell.appendChild(header);

    if (children.length > 0) {
      const block = document.createElement('section');
      block.className = 'category-block';

      const subTitle = document.createElement('h3');
      subTitle.className = 'category-block-title';
      subTitle.textContent = `Subcategorias (${children.length})`;
      block.appendChild(subTitle);

      const grid = document.createElement('div');
      grid.className = 'category-card-grid';

      children.forEach(child => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'category-card';
        card.onclick = () => filterByCategory(child.id);
        card.innerHTML = `
          <span class="category-card-icon">Subcategoria</span>
          <strong class="category-card-title">${escapeHtml(child.name)}</strong>
        `;
        grid.appendChild(card);
      });

      block.appendChild(grid);
      shell.appendChild(block);
    }

    if (articles.length > 0) {
      const block = document.createElement('section');
      block.className = 'category-block';

      const artTitle = document.createElement('h3');
      artTitle.className = 'category-block-title';
      artTitle.textContent = `Articulos (${articles.length})`;
      block.appendChild(artTitle);

      const ul = document.createElement('ul');
      ul.className = 'results-list';

      articles.forEach(page => {
        const li = document.createElement('li');
        li.className = 'result-card';

        const link = document.createElement('a');
        link.href = `#/articulo/${page.slug}`;
        link.className = 'result-title-link';
        link.textContent = page.title || '(sin titulo)';
        link.onclick = ev => {
          ev.preventDefault();
          navigateTo(`/articulo/${page.slug}`);
        };
        li.appendChild(link);

        if (page.excerpt) {
          const excerpt = document.createElement('p');
          excerpt.className = 'result-excerpt';
          excerpt.textContent = page.excerpt;
          li.appendChild(excerpt);
        }

        ul.appendChild(li);
      });

      block.appendChild(ul);
      shell.appendChild(block);
    }

    if (children.length === 0 && articles.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<strong>Sin contenido</strong><p>Esta categoria no tiene subcategorias ni articulos visibles.</p>';
      shell.appendChild(empty);
    }

    main.appendChild(shell);
  }

  // Wire UI
  document.addEventListener('DOMContentLoaded', async ()=>{
    console.debug('app-api: DOMContentLoaded');
    bindToolbar();

    // Menu item inside header dropdown (created dynamically) - bind when present
    const menuItemNotices = el('menuItemNotices'); if (menuItemNotices) {
      menuItemNotices.addEventListener('click', function(e){ try { e.preventDefault(); navigateTo('/avisos'); } catch(err){ console.error(err); } });
    }
    const menuItemCategories = el('menuItemCategories'); if (menuItemCategories) {
      menuItemCategories.addEventListener('click', function(e){ try { e.preventDefault(); navigateTo('/categorias'); } catch(err){ console.error(err); } });
    }
    const menuItemAddPage = el('menuItemAddPage'); if (menuItemAddPage) {
      menuItemAddPage.addEventListener('click', function(e){ try { e.preventDefault(); loadEditor(null); } catch(err){ console.error('menuItemAddPage handler failed', err); } });
    }
    const menuItemIncidencias = el('menuItemIncidencias'); if (menuItemIncidencias) {
      menuItemIncidencias.addEventListener('click', function(e){ try { e.preventDefault(); navigateTo('/incidencias'); } catch(err){ console.error(err); } });
    }

    const bBack = el('btnBack'); if (bBack) bBack.onclick = ()=> navigateTo('/');
    const bCancel = el('btnCancel'); if (bCancel) bCancel.onclick = ()=> navigateTo('/');

    const searchInput = el('searchInput');
    if (searchInput) {
      searchInput.placeholder = 'Buscar articulos, temas...';
      const debouncedSearch = debounce(value => search(value), 180);
      searchInput.oninput = e => debouncedSearch(e.target.value);
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          search('');
        }
      });
    }
    document.addEventListener('keydown', e => {
      const activeTag = document.activeElement && document.activeElement.tagName;
      if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
        e.preventDefault();
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    });

    // Back to top button behavior
    const backBtn = document.getElementById('backToTop');
    if (backBtn) {
      const toggle = () => {
        if (window.scrollY > 300) backBtn.classList.add('show'); else backBtn.classList.remove('show');
      };
      window.addEventListener('scroll', toggle);
      toggle();
      backBtn.addEventListener('click', function(){ window.scrollTo({ top: 0, behavior: 'smooth' }); });
    }

    // Close category dropdown when clicking outside
    document.addEventListener('click', function(e) {
      const categoryDropdown = el('categoryDropdownSPA');
      if (categoryDropdown && !e.target.closest('.category-selector')) {
        categoryDropdown.classList.remove('show');
      }
    });


    // --- Diagramas: listar, subir, abrir y borrar ---
    async function fetchDiagramas(){
      try{ const r = await fetch('/api/diagramas'); if (!r.ok) return []; return await r.json(); } catch(e){ console.error('fetchDiagramas', e); return []; }
    }

    // Render helper for the diagrams grid (used by search)
    function renderDiagramGrid(items){
      const grid = el('diagramGrid'); if (!grid) return;
      if (!items || items.length === 0) { grid.innerHTML = '<p>No hay diagramas.</p>'; return; }
      grid.innerHTML = items.map(it => `
        <div class="diagram-card" data-name="${it.file}">
          <div class="diagram-title">${escapeHtml(it.displayName || it.file)}</div>
          <div class="diagram-desc">${escapeHtml(it.description || '')}</div>
          <div class="diagram-actions">
            <button class="open-diagram" data-name="${it.file}">Abrir</button>
            <button class="open-diagram-new" data-name="${it.file}">Abrir en ventana</button>
            <button class="delete-diagram" data-name="${it.file}">Borrar</button>
          </div>
        </div>
      `).join('');
      // bind actions
      grid.querySelectorAll('.open-diagram').forEach(b => b.addEventListener('click', e=>{ const name = e.currentTarget.dataset.name; openDiagrama(name, true, true); }));
      grid.querySelectorAll('.open-diagram-new').forEach(b => b.addEventListener('click', e=>{ const name = e.currentTarget.dataset.name; window.open(appUrl('/diagramas/' + encodeURIComponent(name)), '_blank'); }));
      grid.querySelectorAll('.delete-diagram').forEach(b => b.addEventListener('click', async e=>{
        const name = e.currentTarget.dataset.name; if (!confirm('Borrar ' + name + '?')) return;
        try{ const res = await fetch('/api/diagramas/' + encodeURIComponent(name), { method: 'DELETE' }); if (!res.ok) throw new Error('failed'); showNotification('Diagrama borrado', 'success'); await loadDiagramasPage(); } catch(err){ showNotification('Error borrando diagrama', 'error'); }
      }));
    }

    async function loadDiagramasPage(){
      console.debug('loadDiagramasPage invoked');
      // hide other pages
      el('homeView').style.display='none';
      el('viewPage').style.display='none';
      el('editor').style.display='none';
      const cp = el('categoriesPage'); if (cp) cp.style.display = 'none';
      const np = el('noticesPage'); if (np) np.style.display = 'none';
      const dp = el('diagramsPage'); if (dp) dp.style.display = 'block';
      const grid = el('diagramGrid'); if (!grid) return; grid.innerHTML = 'Cargando...';
      const items = await fetchDiagramas();
      // update URL to diagrams list
      if (getHashRoute() !== '/diagramas') navigateTo('/diagramas');
      currentDiagramItems = items || [];
      // setup search box
      const searchInput = el('diagramSearch');
      if (searchInput) {
        searchInput.value = '';
        searchInput.oninput = debounce(() => {
          const q = (searchInput.value || '').trim().toLowerCase();
          const filtered = currentDiagramItems.filter(it => ((it.displayName || it.file) || '').toLowerCase().includes(q));
          renderDiagramGrid(filtered);
        }, 200);
      }
      // initial render
      renderDiagramGrid(currentDiagramItems);
    }

    // register loader
    pageLoaders.diagramas = loadDiagramasPage;

    // openDiagrama: opens modal; if push===true updates URL to /diagramas/{name}; if fullscreen===true uses fullscreen styling
    function openDiagrama(name, push = true, fullscreen = false){
      const modal = el('diagramModal'); const iframe = el('diagramPreview'); if (!modal || !iframe) return;
      iframe.src = appUrl('/diagramas/' + encodeURIComponent(name));
      // apply fullscreen class if requested
      if (fullscreen) modal.classList.add('fullscreen'); else modal.classList.remove('fullscreen');
      modal.style.display = 'flex';
      // prevent body scroll while modal open
      try { document.body.style.overflow = 'hidden'; } catch(e){}
      if (push) navigateTo('/diagramas/' + encodeURIComponent(name));
    }

    // expose to global so iframe or other scopes can call parent.openDiagrama safely
    try { window.openDiagrama = openDiagrama; } catch(e) { /* ignore */ }

    document.getElementById('diagramModalClose')?.addEventListener('click', ()=>{
      const m = el('diagramModal'); if (!m) return; m.style.display='none'; m.classList.remove('fullscreen'); const iframe = el('diagramPreview'); if (iframe) iframe.src=''; try { document.body.style.overflow = ''; } catch(e){}
      // Only navigate back to /diagramas if we opened a diagram via the router URL
      try {
        const h = getHashRoute();
        if (h.startsWith('/diagramas/')) navigateTo('/diagramas');
      } catch(e){}
    });

    document.getElementById('diagramUploadBtn')?.addEventListener('click', async ()=>{
      const input = el('diagramFile'); if (!input || !input.files || input.files.length === 0) return alert('Selecciona un archivo .html');
      const file = input.files[0]; if (!file.name.toLowerCase().endsWith('.html')) return alert('Solo .html permitido');
      const fd = new FormData(); fd.append('file', file, file.name);
      const nameVal = (el('diagramName') && el('diagramName').value) ? el('diagramName').value.trim() : '';
      const descVal = (el('diagramDesc') && el('diagramDesc').value) ? el('diagramDesc').value.trim() : '';
      if (nameVal) fd.append('displayName', nameVal); if (descVal) fd.append('description', descVal);
      try{
        const res = await fetch('/api/diagramas', { method: 'POST', body: fd });
        if (!res.ok) { const txt = await res.text().catch(()=>null); throw new Error(txt || 'HTTP ' + res.status); }
        showNotification('Diagrama subido', 'success'); if (el('diagramFile')) el('diagramFile').value=''; if (el('diagramName')) el('diagramName').value=''; if (el('diagramDesc')) el('diagramDesc').value=''; await loadDiagramasPage();
      } catch(err){ console.error('upload diagram error', err); showNotification('Error subiendo diagrama', 'error'); }
    });

    // --- Incidencias: listar, crear, mover, borrar ---
    async function fetchIncidentsBoards(){
      const r = await fetch('/api/incidents/boards');
      if (!r.ok) throw new Error('Failed to fetch incidents boards');
      return await r.json();
    }
    async function fetchIncidentsCards(boardId){
      const q = boardId ? ('/api/incidents/cards?boardId=' + encodeURIComponent(boardId)) : '/api/incidents/cards';
      const r = await fetch(q);
      if (!r.ok) throw new Error('Failed to fetch incidents cards');
      return await r.json();
    }

    async function loadIncidenciasPage(){
      console.debug('loadIncidenciasPage invoked');
      try {
        hideAllPages();
        const page = el('incidentsPage'); if (!page) return; page.style.display = 'block';
        const container = el('incidentsBoardContainer'); if (container) container.innerHTML = 'Cargando...';
        const nb = el('newBoardName'); if (nb) nb.value = '';
        const createBtn = el('createBoardBtn'); if (createBtn) createBtn.onclick = async ()=>{
        const name = (el('newBoardName') && el('newBoardName').value) ? el('newBoardName').value.trim() : '';
        if (!name) { showNotification('Nombre requerido','error'); return; }
        try { await fetchJson('/api/incidents/boards', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) }); el('newBoardName').value = ''; await renderIncidents(); } catch(e){ showNotification('Error creando columna','error'); }
      };
      // update URL
        if (getHashRoute() !== '/incidencias') navigateTo('/incidencias');
        await renderIncidents();
      } catch (err) {
        console.error('loadIncidenciasPage error', err);
        const container = el('incidentsBoardContainer'); if (container) container.innerHTML = '<p>Error cargando Incidencias.</p>';
        showNotification('Error cargando Incidencias: ' + (err && err.message ? err.message : ''), 'error');
      }
    }

    // register loader
    pageLoaders.incidencias = loadIncidenciasPage;

    // Load incidents summary into Home tab: grouped by column, only pending
    async function loadIncidentsSummaryIntoHome(){
      const container = el('homeIncidentsInner'); if (!container) return; container.innerHTML = 'Cargando incidencias...';
      try{
        const boards = await fetchIncidentsBoards();
        const allCards = await fetchIncidentsCards();
        container.innerHTML = '';
        if (!boards || boards.length === 0) { container.innerHTML = '<p>No hay columnas.</p>'; return; }
        boards.forEach(b=>{
          const box = document.createElement('div'); box.style.marginBottom='12px'; box.innerHTML = `<h4 style="margin:4px 0">${escapeHtml(b.name)}</h4>`;
          const ul = document.createElement('ul');
          const cards = (allCards || []).filter(c => c.boardId === b.id);
          if (!cards || cards.length === 0) { ul.innerHTML = '<li>No hay incidencias</li>'; }
          else { cards.forEach(c=>{ const li = document.createElement('li'); li.textContent = c.title; ul.appendChild(li); }); }
          box.appendChild(ul); container.appendChild(box);
        });
      }catch(e){ container.innerHTML = '<p>Error cargando incidencias.</p>'; }
    }
    window.homeIncidentsLoader = loadIncidentsSummaryIntoHome;

    function lockBodyScroll() {
      try { document.body.style.overflow = 'hidden'; } catch (_) {}
    }

    function unlockBodyScroll() {
      try { document.body.style.overflow = ''; } catch (_) {}
    }

    function closeCardModal() {
      const modal = el('cardModal');
      if (!modal) return;
      modal.style.display = 'none';
      modal.onclick = null;
      unlockBodyScroll();
      el('saveCardBtn').style.display = 'inline-block';
      el('cancelCardBtn').textContent = 'Cancelar';
    }

    function showCardModal() {
      const modal = el('cardModal');
      if (!modal) return null;
      modal.style.display = 'flex';
      lockBodyScroll();
      modal.onclick = ev => {
        if (ev.target === modal) closeCardModal();
      };
      return modal;
    }

    async function renderIncidents(){
      try {
        const boards = await fetchIncidentsBoards();
      const q = (el('incidentsSearchInput') && el('incidentsSearchInput').value) ? (el('incidentsSearchInput').value||'').trim().toLowerCase() : '';
      const allCards = await fetchIncidentsCards();
      currentIncidentsBoards = boards || [];
      const container = el('incidentsBoardContainer'); if (!container) return; container.innerHTML = '';
      if (!boards || boards.length === 0) { container.innerHTML = '<p>No hay columnas. Crea una columna nueva.</p>'; return; }
      // wire search input (debounced)
      const searchIn = el('incidentsSearchInput'); if (searchIn) searchIn.oninput = debounce(()=> renderIncidents(), 250);
      boards.forEach(b=>{
        const col = document.createElement('div'); col.className = 'inc-board'; col.dataset.boardId = b.id;
        col.innerHTML = `<div class="inc-board-header"><strong>${escapeHtml(b.name)}</strong> <button class="deleteBoardBtn" data-id="${b.id}">x</button></div><div class="inc-card-list" data-board="${b.id}"></div><div class="inc-add-card"><button class="addCardBtn" data-board="${b.id}">+ Anadir incidencia</button></div>`;
        container.appendChild(col);
        const list = col.querySelector('.inc-card-list');
        // determine cards to show in this column according to query:
        // - if q matches board name -> show all cards in column
        // - else show only cards whose title or description contains q
        const allBoardCards = (allCards || []).filter(c=> c.boardId === b.id);
        const boardMatches = q && b.name && b.name.toLowerCase().includes(q);
        const cards = (!q || boardMatches) ? allBoardCards : allBoardCards.filter(c => { const hay = ((c.title||'') + ' ' + (c.description||'')).toLowerCase(); return hay.includes(q); });
        // if not matching and no cards to show, skip rendering column
        if (q && !boardMatches && (!cards || cards.length === 0)) return;
        cards.forEach(c=>{
          const card = document.createElement('div'); card.className = 'inc-card'; card.draggable = true; card.dataset.cardId = c.id;
          // truncate description for card preview
          const desc = c.description || '';
          const max = 120;
          const short = desc.length > max ? (escapeHtml(desc.slice(0, max)) + '...') : escapeHtml(desc);
          const detailsBtn = desc.length > max ? `<button class="viewDetailsBtn" data-id="${c.id}">Ver detalles</button>` : '';
          const resolveBtn = `<button class="resolveBtn" data-id="${c.id}">Marcar resuelta</button>`;
          card.innerHTML = `<div class="inc-card-title">${escapeHtml(c.title)}</div><div class="inc-card-desc">${short}</div><div class="inc-card-actions">${detailsBtn}${resolveBtn}<button class="delCardBtn" data-id="${c.id}">Eliminar</button></div>`;
          card.addEventListener('dragstart', (ev)=> { ev.dataTransfer.setData('text/plain', c.id); });
          list.appendChild(card);
        });
        // bind view details buttons
        list.querySelectorAll('.viewDetailsBtn').forEach(b=> b.addEventListener('click', (e)=>{
          const id = parseInt(e.currentTarget.dataset.id,10);
          const cardObj = (allCards || []).find(x=> x.id === id);
          if (!cardObj) return;
          // open modal in read-only mode (centered fixed modal)
          const modal = showCardModal(); if (!modal) return;
          el('cardModalTitle').textContent = cardObj.title || 'Incidencia';
          el('cardTitleInput').value = cardObj.title || '';
          el('cardDescInput').value = cardObj.description || '';
          // populate board select and set selection
          const sel = el('cardBoardSelect'); sel.innerHTML = '';
          currentIncidentsBoards.forEach(b=>{ const o = document.createElement('option'); o.value = b.id; o.textContent = b.name; if (b.id === cardObj.boardId) o.selected = true; sel.appendChild(o); });
          // hide save button while viewing
          el('saveCardBtn').style.display = 'none';
          el('cancelCardBtn').textContent = 'Cerrar';
          el('cancelCardBtn').onclick = closeCardModal;
        }));
        // bind resolve buttons
        list.querySelectorAll('.resolveBtn').forEach(b=> b.addEventListener('click', async (e)=>{
          const id = e.currentTarget.dataset.id;
          if (!confirm('Marcar incidencia como resuelta?')) return;
          try { await fetchJson('/api/incidents/cards/' + encodeURIComponent(id) + '/resolve', { method: 'POST' }); await renderIncidents(); showNotification('Incidencia marcada como resuelta','success'); } catch(err){ showNotification('Error marcando resuelta','error'); }
        }));
        // drag handlers
        list.addEventListener('dragover', (ev)=>{ ev.preventDefault(); });
        list.addEventListener('drop', async (ev)=>{
          ev.preventDefault(); const cardId = ev.dataTransfer.getData('text/plain'); if (!cardId) return; const targetBoard = parseInt(list.dataset.board,10);
          try{ await fetchJson('/api/incidents/cards/' + encodeURIComponent(cardId) + '/move?boardId=' + encodeURIComponent(targetBoard), { method:'PUT' }); await renderIncidents(); } catch(e){ showNotification('Error moviendo incidencia','error'); }
        });
        // add card
        col.querySelector('.addCardBtn').onclick = ()=> openCardModal(b.id);
        // delete board
        col.querySelector('.deleteBoardBtn').onclick = async (e)=>{ if (!confirm('Borrar columna y sus incidencias?')) return; const id = e.target.dataset.id; await fetchJson('/api/incidents/boards/' + encodeURIComponent(id), { method:'DELETE' }); await renderIncidents(); };
      });
      // wire resolved toggle to show/hide resolved section
      const resolvedToggle = el('incidentsShowResolved');
      const resolvedContainer = el('incidentsResolvedContainer');
      if (resolvedToggle && resolvedContainer) {
        // ensure state is persistent within page lifecycle
        resolvedToggle.onchange = async function(){
          try {
            if (this.checked) {
              const resolved = await fetchJson('/api/incidents/cards/resolved');
              renderResolvedSection(resolved || []);
              resolvedContainer.style.display = 'block';
            } else {
              resolvedContainer.style.display = 'none';
              resolvedContainer.innerHTML = '';
            }
          } catch (err) {
            console.error('resolved toggle error', err);
            showNotification('Error cargando incidencias resueltas','error');
            this.checked = false;
          }
        };
      }

      return; // successful end
      } catch (err) {
        console.error('renderIncidents error', err);
        const container = el('incidentsBoardContainer'); if (container) container.innerHTML = '<p>Error cargando columnas.</p>';
        showNotification('Error cargando columnas: ' + (err && err.message ? err.message : ''), 'error');
      }
    }

    // card modal helpers
    function openCardModal(boardId){
      const modal = showCardModal(); if (!modal) return;
      const sel = el('cardBoardSelect'); sel.innerHTML = '';
      currentIncidentsBoards.forEach(b=>{ const o = document.createElement('option'); o.value = b.id; o.textContent = b.name; if (b.id === boardId) o.selected = true; sel.appendChild(o); });
      el('cardTitleInput').value = ''; el('cardDescInput').value = '';
      // ensure create mode (show save button)
      el('saveCardBtn').style.display = 'inline-block';
      el('cancelCardBtn').textContent = 'Cancelar';
      el('saveCardBtn').onclick = async ()=>{
        const title = el('cardTitleInput').value.trim(); const desc = el('cardDescInput').value.trim(); const b = parseInt(el('cardBoardSelect').value,10);
        if (!title) { showNotification('Titulo requerido','error'); return; }
        try{
          await fetchJson('/api/incidents/cards', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ boardId: String(b), title, description: desc })});
          closeCardModal();
          await renderIncidents();
        } catch(e){ showNotification('Error guardando incidencia','error'); }
      };
      el('cancelCardBtn').onclick = closeCardModal;
    }

    function renderResolvedSection(items){
      const container = el('incidentsResolvedContainer'); if (!container) return; container.innerHTML = '';
      if (!items || items.length === 0) { container.innerHTML = '<p>No hay incidencias resueltas.</p>'; return; }
      // group by board
      const byBoard = {};
      items.forEach(it => { const k = it.boardId || 'sin'; if (!byBoard[k]) byBoard[k] = []; byBoard[k].push(it); });
      for (const k of Object.keys(byBoard)){
        const boardName = (currentIncidentsBoards.find(b=>String(b.id) === String(k)) || {}).name || ('Columna ' + k);
        const h = document.createElement('h4'); h.textContent = boardName; h.style.marginTop='12px'; container.appendChild(h);
        const ul = document.createElement('ul'); ul.style.marginTop='4px'; ul.style.marginBottom='12px';
        byBoard[k].forEach(it=>{ const li = document.createElement('li'); li.innerHTML = `<strong>${escapeHtml(it.title)}</strong> - <button class='unresolveBtn btn' data-id='${it.id}'>Desmarcar</button>`; ul.appendChild(li); });
        container.appendChild(ul);
      }
      // bind unresolve
      container.querySelectorAll('.unresolveBtn').forEach(b=> b.addEventListener('click', async (e)=>{ const id = e.currentTarget.dataset.id; if (!confirm('Desmarcar como resuelta?')) return; try{ await fetchJson('/api/incidents/cards/' + encodeURIComponent(id) + '/unresolve', { method:'POST' }); showNotification('Incidencia marcada como pendiente','success'); await renderIncidents(); // refresh
        // also refresh resolved section
        const resolved = await fetchJson('/api/incidents/cards/resolved'); renderResolvedSection(resolved || []);
      } catch(err){ showNotification('Error','error'); } }));
    }

    // header menu is created after this script in index.html; use delegated listener so clicks always work
    document.addEventListener('click', function(e){
      try {
        const btnDiag = e.target.closest && e.target.closest('#menuItemDiagramas');
        if (btnDiag) { e.preventDefault(); navigateTo('/diagramas'); return; }
        const btnInc = e.target.closest && e.target.closest('#menuItemIncidencias');
        if (btnInc) { e.preventDefault(); navigateTo('/incidencias'); return; }
      } catch(_){ }
    });

    await refreshUI({ preserveRoute: true });
    
    // Initialize data hash for change detection
    await ensureBootstrap();
    lastDataHash = appState.snapshotHash;
    
    // Setup hash-based routing
    window.addEventListener('hashchange', router);
    
    // Route to initial hash or home
    await router();
    
    // Start auto-refresh for multi-user environment
    startAutoRefresh();
    console.log('Multi-user auto-sync enabled');
    console.log('Hash-based routing enabled');
  });

})();
