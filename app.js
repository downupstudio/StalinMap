const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let map;
let markers = [];
let currentPlaces = [];
let currentProfile = null;
let currentFilterCat = 'all';
let currentSearch = '';
let editingPlaceId = null;
let currentGallery = [];
let currentGalleryIdx = 0;

const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☀' : '☾';
  if (map) map.setStyle(getMapStyle(theme));
}
$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
$('theme-icon').textContent =
  document.documentElement.getAttribute('data-theme') === 'dark' ? '☀' : '☾';

function getMapStyle(theme) {
  const name = theme === 'dark' ? 'dark_all' : 'light_all';
  const apiKey = 'cb1_5ejj_1_a029a23b6e7d50c753228df3'; 

  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: [
          `https://a.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`,
          `https://b.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`,
          `https://c.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`,
        ],
        tileSize: 256,
        attribution: '© OpenStreetMap © CARTO'
      }
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }]
  };
}

function initMapIfNeeded() {
  if (map) { map.resize(); return; }
  const theme = document.documentElement.getAttribute('data-theme');
  map = new maplibregl.Map({
    container: 'map',
    style: getMapStyle(theme),
    center: [19.9450, 50.0647],
    zoom: 11,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('style.load', () => {
    if (currentPlaces.length) renderMarkers(currentPlaces);
  });
}

function clearMarkers() {
  markers.forEach(({ marker }) => marker.remove());
  markers = [];
}

function renderMarkers(places) {
  clearMarkers();
  places.forEach(place => {
    const mEl = el('button', 'map-marker');
    mEl.setAttribute('aria-label', place.title);

    const marker = new maplibregl.Marker({ element: mEl })
      .setLngLat([place.longitude, place.latitude])
      .addTo(map);

    const tooltip = new maplibregl.Popup({
      offset: 16, closeButton: false, closeOnClick: false, className: 'marker-tooltip-popup'
    }).setHTML(`<div class="marker-tooltip">${escapeHtml(place.title)}</div>`);

    mEl.addEventListener('mouseenter', () =>
      tooltip.setLngLat(marker.getLngLat()).addTo(map));
    mEl.addEventListener('mouseleave', () => tooltip.remove());
    mEl.addEventListener('click', () => openPlace(place));

    markers.push({ marker, place });
  });
}

function flyTo(place) {
  if (!map) return;
  map.flyTo({ center: [place.longitude, place.latitude], zoom: 14 });
}

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('auth');
  return loadProfileAndRoute(session.user);
}

async function loadProfileAndRoute(user) {
  const { data: profile, error } = await sb
    .from('profiles').select('*').eq('id', user.id).single();

  if (error || !profile) {
    return show('pending');
  }
  currentProfile = profile;

  if (profile.role === 'admin' || profile.role === 'approved_user') {
    show('map');
    initMapIfNeeded();
    await loadPlaces();
    if (profile.role === 'admin') {
      $('nav-admin').classList.remove('hidden');
    } else {
      $('nav-admin').classList.add('hidden');
    }
    $('logout-btn').classList.remove('hidden');
  } else {
    show('pending');
  }
}

function show(which) {
  ['auth', 'pending', 'map'].forEach(v => {
    $('view-' + v).classList.toggle('hidden', v !== which);
  });
  if (which !== 'map') {
    $('nav-admin').classList.add('hidden');
    $('logout-btn').classList.add('hidden');
  }
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const msg = $('auth-msg');
  msg.className = 'msg'; msg.textContent = '';

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    msg.className = 'msg msg--error';
    msg.textContent = 'Błąd logowania: ' + error.message;
    return;
  }
  checkSession();
});

$('btn-register').addEventListener('click', async () => {
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const msg = $('auth-msg');
  msg.className = 'msg'; msg.textContent = '';

  if (!email || password.length < 6) {
    msg.className = 'msg msg--error';
    msg.textContent = 'Podaj e-mail i hasło (min. 6 znaków).';
    return;
  }
  const { error } = await sb.auth.signUp({ email, password });
  if (error) {
    msg.className = 'msg msg--error';
    msg.textContent = 'Błąd rejestracji: ' + error.message;
    return;
  }
  msg.className = 'msg msg--ok';
  msg.textContent = 'Konto utworzone. Poczekaj na zatwierdzenie przez administratora.';
});

async function logout() {
  await sb.auth.signOut();
  currentProfile = null;
  currentPlaces = [];
  clearMarkers();
  if (map) { map.remove(); map = null; }
  show('auth');
  $('auth-msg').className = 'msg'; $('auth-msg').textContent = '';
}
$('logout-btn').addEventListener('click', logout);
$('pending-logout').addEventListener('click', logout);

async function loadPlaces() {
  const { data, error } = await sb.from('places')
    .select('*').order('created_at', { ascending: false });
  if (error) { console.error(error); return; }
  currentPlaces = data || [];
  renderMarkers(currentPlaces);
  renderSidebar();
  renderAdminPlaces();
}

function renderSidebar() {
  const cats = new Map();
  currentPlaces.forEach(p => {
    const c = p.category || 'inne';
    cats.set(c, (cats.get(c) || 0) + 1);
  });
  const catList = $('category-list');
  catList.innerHTML = '';
  const allLi = el('li');
  const allBtn = el('button', 'filter-btn' + (currentFilterCat === 'all' ? ' active' : ''));
  allBtn.dataset.cat = 'all';
  allBtn.innerHTML = `<span>Wszystkie</span><span class="count">${currentPlaces.length}</span>`;
  allBtn.onclick = () => { currentFilterCat = 'all'; renderSidebar(); };
  allLi.appendChild(allBtn); catList.appendChild(allLi);

  [...cats.entries()].sort().forEach(([cat, count]) => {
    const li = el('li');
    const btn = el('button', 'filter-btn' + (currentFilterCat === cat ? ' active' : ''));
    btn.dataset.cat = cat;
    btn.innerHTML = `<span>${escapeHtml(cat)}</span><span class="count">${count}</span>`;
    btn.onclick = () => { currentFilterCat = cat; renderSidebar(); };
    li.appendChild(btn); catList.appendChild(li);
  });

  const filtered = currentPlaces.filter(p => {
    if (currentFilterCat !== 'all' && (p.category || 'inne') !== currentFilterCat) return false;
    if (currentSearch && !p.title.toLowerCase().includes(currentSearch)) return false;
    return true;
  });

  $('places-count').textContent = filtered.length;

  const list = $('places-list');
  list.innerHTML = '';
  if (!filtered.length) {
    const li = el('li', 'empty'); li.textContent = 'Brak wyników';
    list.appendChild(li); return;
  }
  filtered.forEach(p => {
    const li = el('li');
    const btn = el('button');
    btn.innerHTML = `
      <div class="place-item__title">${escapeHtml(p.title)}</div>
      <div class="place-item__cat">${escapeHtml(p.category || 'inne')}</div>`;
    btn.onclick = () => { flyTo(p); openPlace(p); };
    li.appendChild(btn); list.appendChild(li);
  });
}

$('search-input').addEventListener('input', (e) => {
  currentSearch = e.target.value.toLowerCase().trim();
  renderSidebar();
});

function openPlace(place) {
  $('place-title').textContent = place.title;
  $('place-meta').innerHTML = `
    <span>${escapeHtml(place.category || 'inne')}</span>
    <span>${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}</span>
  `;
  $('place-desc').textContent = place.description || '—';

  const gal = $('place-gallery');
  gal.innerHTML = '';
  const imgs = place.images || [];
  currentGallery = imgs;
  currentGalleryIdx = 0;

  if (!imgs.length) {
    const empty = el('div', 'empty'); empty.textContent = 'Brak zdjęć';
    gal.appendChild(empty);
  } else {
    imgs.forEach((url, i) => {
      const b = el('button', 'photo-card');
      b.innerHTML = `<div class="photo-card__img"><img src="${escapeAttr(url)}" alt="" loading="lazy"></div>`;
      b.onclick = () => openLightbox(i);
      gal.appendChild(b);
    });
  }
  openModal('place-modal');
}

function openLightbox(idx) {
  if (!currentGallery.length) return;
  currentGalleryIdx = idx;
  updateLightbox();
  $('lightbox').setAttribute('data-open', 'true');
}
function updateLightbox() {
  $('lb-img').src = currentGallery[currentGalleryIdx];
  $('lb-counter').textContent = `${currentGalleryIdx + 1} / ${currentGallery.length}`;
}
$('lb-close').onclick = () => $('lightbox').setAttribute('data-open', 'false');
$('lb-prev').onclick = () => {
  currentGalleryIdx = (currentGalleryIdx - 1 + currentGallery.length) % currentGallery.length;
  updateLightbox();
};
$('lb-next').onclick = () => {
  currentGalleryIdx = (currentGalleryIdx + 1) % currentGallery.length;
  updateLightbox();
};
document.addEventListener('keydown', (e) => {
  if ($('lightbox').getAttribute('data-open') === 'true') {
    if (e.key === 'Escape') $('lb-close').click();
    if (e.key === 'ArrowLeft') $('lb-prev').click();
    if (e.key === 'ArrowRight') $('lb-next').click();
  }
});

function openModal(id) { $(id).setAttribute('data-open', 'true'); }
function closeModal(id) { $(id).setAttribute('data-open', 'false'); }
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

$('nav-admin').addEventListener('click', async (e) => {
  e.preventDefault();
  if (currentProfile?.role !== 'admin') return;
  openModal('admin-modal');
  await renderAdminUsers();
  renderAdminPlaces();
});

$('admin-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  document.querySelectorAll('#admin-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
  $('tab-users').classList.toggle('hidden', t.dataset.tab !== 'users');
  $('tab-places').classList.toggle('hidden', t.dataset.tab !== 'places');
});

async function renderAdminUsers() {
  const { data, error } = await sb.from('profiles').select('*').order('created_at');
  if (error) { console.error(error); return; }
  const pending = data.filter(u => u.role === 'pending_user');
  const approved = data.filter(u => u.role !== 'pending_user');

  const pendingList = $('pending-users');
  pendingList.innerHTML = '';
  if (!pending.length) {
    pendingList.innerHTML = '<li class="empty">Brak oczekujących</li>';
  } else {
    pending.forEach(u => {
      const li = el('li');
      li.innerHTML = `<span class="email">${escapeHtml(u.email)}</span>`;
      const approve = el('button', 'btn btn--small');
      approve.textContent = 'Zatwierdź';
      approve.onclick = async () => {
        await sb.from('profiles').update({ role: 'approved_user' }).eq('id', u.id);
        renderAdminUsers();
      };
      const reject = el('button', 'btn btn--small btn--danger');
      reject.textContent = 'Odrzuć';
      reject.onclick = async () => {
        if (!confirm(`Usunąć konto ${u.email}?`)) return;
        await sb.from('profiles').delete().eq('id', u.id);
        renderAdminUsers();
      };
      li.append(approve, reject);
      pendingList.appendChild(li);
    });
  }

  const approvedList = $('approved-users');
  approvedList.innerHTML = '';
  approved.forEach(u => {
    const li = el('li');
    const badge = u.role === 'admin' ? 'ADMIN' : 'USER';
    li.innerHTML = `<span class="email">${escapeHtml(u.email)}</span>
      <span class="badge">${badge}</span>`;
    if (u.role !== 'admin' || u.id === currentProfile.id) {
      const demote = el('button', 'btn btn--small btn--ghost');
      demote.textContent = u.role === 'admin' ? 'Zdegraduj' : 'Zablokuj';
      demote.onclick = async () => {
        const newRole = u.role === 'admin' ? 'approved_user' : 'pending_user';
        if (!confirm(`Zmienić rolę na "${newRole}"?`)) return;
        await sb.from('profiles').update({ role: newRole }).eq('id', u.id);
        renderAdminUsers();
      };
      li.appendChild(demote);
    }
    approvedList.appendChild(li);
  });
}

function renderAdminPlaces() {
  const list = $('admin-places-list');
  list.innerHTML = '';
  if (!currentPlaces.length) {
    list.innerHTML = '<li class="empty">Brak miejsc — dodaj pierwsze</li>';
    return;
  }
  currentPlaces.forEach(p => {
    const li = el('li');
    li.innerHTML = `<span class="name">${escapeHtml(p.title)}</span>
      <span class="badge">${escapeHtml(p.category || 'inne')}</span>`;
    const edit = el('button', 'btn btn--small btn--ghost');
    edit.textContent = 'Edytuj';
    edit.onclick = () => openEditor(p);
    li.appendChild(edit);
    list.appendChild(li);
  });
}

$('btn-new-place').addEventListener('click', () => openEditor(null));

function openEditor(place) {
  editingPlaceId = place ? place.id : null;
  $('editor-title').textContent = place ? 'Edytuj miejsce' : 'Nowe miejsce';
  $('editor-msg').className = 'msg';
  $('editor-delete').classList.toggle('hidden', !place);

  const template = place
    ? {
        title: place.title,
        category: place.category || 'inne',
        description: place.description || '',
        latitude: place.latitude,
        longitude: place.longitude,
        images: place.images || []
      }
    : {
        title: 'Nowe miejsce',
        category: 'inne',
        description: 'Opis miejsca…',
        latitude: 50.0647,
        longitude: 19.9450,
        images: []
      };

  $('editor-json').value = JSON.stringify(template, null, 2);
  openModal('editor-modal');
}

$('editor-save').addEventListener('click', async () => {
  const msg = $('editor-msg');
  msg.className = 'msg'; msg.textContent = '';
  let data;
  try {
    data = JSON.parse($('editor-json').value);
    if (!data.title || typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
      throw new Error('Wymagane: title (tekst), latitude (liczba), longitude (liczba).');
    }
    if (data.images && !Array.isArray(data.images)) {
      throw new Error('Pole "images" musi być tablicą URL-i.');
    }
  } catch (err) {
    msg.className = 'msg msg--error';
    msg.textContent = 'Błąd JSON: ' + err.message;
    return;
  }

  const payload = {
    title: data.title,
    category: data.category || 'inne',
    description: data.description || '',
    latitude: data.latitude,
    longitude: data.longitude,
    images: data.images || []
  };

  const query = editingPlaceId
    ? sb.from('places').update(payload).eq('id', editingPlaceId)
    : sb.from('places').insert(payload);

  const { error } = await query;
  if (error) {
    msg.className = 'msg msg--error';
    msg.textContent = 'Błąd zapisu: ' + error.message;
    return;
  }
  msg.className = 'msg msg--ok';
  msg.textContent = 'Zapisano.';
  closeModal('editor-modal');
  await loadPlaces();
});

$('editor-delete').addEventListener('click', async () => {
  if (!editingPlaceId) return;
  if (!confirm('Usunąć to miejsce?')) return;
  const { error } = await sb.from('places').delete().eq('id', editingPlaceId);
  if (error) { alert('Błąd: ' + error.message); return; }
  closeModal('editor-modal');
  await loadPlaces();
});

$('editor-upload').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const msg = $('editor-msg');
  msg.className = 'msg msg--ok'; msg.textContent = 'Wgrywanie…';

  let data;
  try { data = JSON.parse($('editor-json').value); }
  catch { msg.className = 'msg msg--error'; msg.textContent = 'Najpierw popraw JSON.'; return; }
  if (!Array.isArray(data.images)) data.images = [];

  for (const file of files) {
    const clean = file.name.replace(/[^\w.\-]+/g, '_');
    const path = `places/${Date.now()}-${Math.random().toString(36).slice(2)}-${clean}`;
    const { error } = await sb.storage.from('place-images').upload(path, file);
    if (error) { msg.className = 'msg msg--error'; msg.textContent = 'Upload: ' + error.message; continue; }
    const { data: pub } = sb.storage.from('place-images').getPublicUrl(path);
    data.images.push(pub.publicUrl);
  }
  $('editor-json').value = JSON.stringify(data, null, 2);
  msg.className = 'msg msg--ok';
  msg.textContent = 'Dodano zdjęcia do JSON — zapisz zmiany.';
  e.target.value = '';
});

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
function escapeAttr(s = '') { return escapeHtml(s); }

(async function start() {
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  await checkSession();

  sb.auth.onAuthStateChange((_event, session) => {
    if (!session) {
      currentProfile = null;
      show('auth');
    }
  });
})();