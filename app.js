const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const BASE_PATH = location.pathname.toLowerCase().startsWith('/stalinmap') ? '/StalinMap' : '';
const RESERVED_SLUGS = new Set(['map', 'admin', 'login', 'register', 'profile', 'pending', '404', 'index.html']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let map = null;
let markers = [];
let currentPlaces = [];
let allProfilesMap = new Map();
let myVisitedIds = new Set();
let currentProfile = null;
let myProfile = null;
let currentFilterCat = 'all';
let currentSearch = '';
let editingPlaceId = null;
let isProposalMode = false;
let currentGallery = [];
let currentGalleryIdx = 0;
let currentPlace = null;
let isVisited = false;
let currentProfileId = null;
let authMode = 'login';
let initialRouteSlug = getSlugFromPath();

function getSlugFromPath() {
  let rel = location.pathname;
  if (BASE_PATH && rel.toLowerCase().startsWith(BASE_PATH.toLowerCase())) {
    rel = rel.slice(BASE_PATH.length);
  }
  const slug = decodeURIComponent(rel.replace(/^\/+|\/+$/g, ''));
  if (!slug || slug.toLowerCase() === 'index.html') return '';
  return slug;
}

function validateUsername(name) {
  if (!/^[a-zA-Z0-9._-]{2,30}$/.test(name)) {
    return 'Nazwa może zawierać 2–30 znaków (litery, cyfry, kropkę, myślnik, podkreślnik).';
  }
  if (RESERVED_SLUGS.has(name.toLowerCase())) {
    return 'Ta nazwa użytkownika jest zarezerwowana.';
  }
  return '';
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

function escapeAttr(s = '') {
  return escapeHtml(s);
}

function safeUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch {
    return '';
  }
}

function getApprovedPlaces() {
  return currentPlaces.filter((p) => (p.status || 'approved') === 'approved');
}

function getPendingPlaces() {
  return currentPlaces.filter((p) => p.status === 'pending');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☀' : '☾';
  if (map) map.setStyle(getMapStyle(theme));
}

$('theme-toggle').addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});
applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

function getMapStyle(theme) {
  const name = theme === 'dark' ? 'dark_all' : 'light_all';
  const apiKey = window.MAP_CONFIG?.cartoKey || '';

  return {
    version: 8,
    sources: {
      base: {
        type: 'raster',
        tiles: [
          `https://a.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`,
          `https://b.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`,
          `https://c.basemaps.cartocdn.com/${name}/{z}/{x}/{y}.png?key=${apiKey}`
        ],
        tileSize: 256,
        attribution: '© OSM © CARTO'
      }
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }]
  };
}

function initMapIfNeeded() {
  if (map) {
    map.resize();
    return;
  }
  const center = window.MAP_CONFIG?.center || [19.4560, 51.7592];
  const zoom = window.MAP_CONFIG?.zoom || 12;

  map = new maplibregl.Map({
    container: 'map',
    style: getMapStyle(document.documentElement.getAttribute('data-theme')),
    center,
    zoom
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('style.load', () => {
    renderSidebar();
  });
}

function clearMarkers() {
  markers.forEach((m) => m.marker.remove());
  markers = [];
}

function renderMarkers(places) {
  if (!map) return;
  clearMarkers();
  places.forEach((place) => {
    if (typeof place.longitude !== 'number' || typeof place.latitude !== 'number') return;
    const isPlaceVisited = myVisitedIds.has(place.id);
    const mEl = el('button', 'map-marker' + (isPlaceVisited ? ' map-marker--visited' : ''));
    mEl.setAttribute('aria-label', place.title || 'Miejsce');
    mEl.title = place.title || '';
    const marker = new maplibregl.Marker({ element: mEl })
      .setLngLat([place.longitude, place.latitude])
      .addTo(map);
    mEl.addEventListener('click', () => openPlace(place));
    markers.push({ marker, place });
  });
}

function fitMapToPlaces(places) {
  if (!map || !places.length) return;
  const valid = places.filter((p) => typeof p.longitude === 'number' && typeof p.latitude === 'number');
  if (!valid.length) return;
  if (valid.length === 1) {
    map.flyTo({ center: [valid[0].longitude, valid[0].latitude], zoom: 13 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  valid.forEach((p) => bounds.extend([p.longitude, p.latitude]));
  map.fitBounds(bounds, { padding: 60, maxZoom: 14 });
}

function show(which, pushUrl = false, isOwnProfile = false) {
  ['auth', 'pending', 'map', 'profile'].forEach((v) => {
    $('view-' + v)?.classList.toggle('hidden', v !== which);
  });

  const isAppView = which === 'map' || which === 'profile';
  $('nav-subbar').classList.toggle('hidden', !isAppView);
  $('nav-profile-btn').classList.toggle('hidden', !isAppView);
  $('logout-btn').classList.toggle('hidden', !isAppView);

  if (isAppView) {
    $('nav-admin').classList.toggle('hidden', myProfile?.role !== 'admin');
    $('nav-propose').classList.toggle('hidden', myProfile?.role !== 'moderator');
    $('nav-map-btn').classList.toggle('active', which === 'map');
    $('nav-profile-btn').classList.toggle('btn--ghost', !(which === 'profile' && isOwnProfile));
  } else {
    $('nav-admin').classList.add('hidden');
    $('nav-propose').classList.add('hidden');
  }

  if (which === 'map') {
    document.title = 'Mapa Urbex';
    if (pushUrl) {
      const homeUrl = `${BASE_PATH}/`;
      if (location.pathname !== homeUrl) {
        history.pushState({ view: 'map' }, '', homeUrl);
      }
    }
  }
}

function openModal(id) {
  $(id).setAttribute('data-open', 'true');
}

function closeModal(id) {
  $(id).setAttribute('data-open', 'false');
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('lightbox').getAttribute('data-open') === 'true') {
      closeModal('lightbox');
      return;
    }
    document.querySelectorAll('.modal[data-open="true"]').forEach((m) => closeModal(m.id));
  } else if ($('lightbox').getAttribute('data-open="true') === 'true') {
    if (e.key === 'ArrowLeft') $('lb-prev').click();
    if (e.key === 'ArrowRight') $('lb-next').click();
  }
});

window.addEventListener('popstate', async () => {
  if (!myProfile || !['admin', 'moderator', 'approved_user'].includes(myProfile.role)) return;
  const slug = getSlugFromPath();
  if (slug) {
    await openProfile(slug, false);
  } else {
    show('map', false);
    initMapIfNeeded();
  }
});

function setAuthMode(mode) {
  authMode = mode;
  const isReg = mode === 'register';
  $('tab-auth-login').classList.toggle('active', !isReg);
  $('tab-auth-register').classList.toggle('active', isReg);
  $('username-row').classList.toggle('hidden', !isReg);
  $('auth-heading').textContent = isReg ? 'Utwórz konto' : 'Zaloguj się';
  $('btn-auth-submit').textContent = isReg ? 'Zarejestruj się' : 'Zaloguj';
  $('auth-password').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
  $('auth-msg').className = 'msg';
}

$('tab-auth-login').addEventListener('click', () => setAuthMode('login'));
$('tab-auth-register').addEventListener('click', () => setAuthMode('register'));

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('auth');
  await loadProfileAndRoute(session.user);
}

async function loadProfileAndRoute(user) {
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) return show('pending');
  currentProfile = profile;
  myProfile = profile;
  currentProfileId = user.id;

  if (['admin', 'moderator', 'approved_user'].includes(profile.role)) {
    await loadMyVisits();
    await loadPlaces(false);

    const slugToOpen = initialRouteSlug || getSlugFromPath();
    initialRouteSlug = '';

    if (slugToOpen) {
      const opened = await openProfile(slugToOpen, false);
      if (!opened) {
        show('map', true);
        initMapIfNeeded();
        fitMapToPlaces(getApprovedPlaces());
      }
    } else {
      show('map', false);
      initMapIfNeeded();
      fitMapToPlaces(getApprovedPlaces());
    }
  } else {
    show('pending');
  }
}

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const username = $('auth-username').value.trim();

  if (authMode === 'login') {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $('auth-msg').className = 'msg msg--error';
      $('auth-msg').textContent = error.message === 'Email not confirmed'
        ? 'Adres e-mail nie został jeszcze potwierdzony.'
        : error.message;
    } else {
      await checkSession();
    }
  } else {
    const userErr = validateUsername(username);
    if (userErr) {
      $('auth-msg').className = 'msg msg--error';
      $('auth-msg').textContent = userErr;
      return;
    }
    if (!email || password.length < 6) {
      $('auth-msg').className = 'msg msg--error';
      $('auth-msg').textContent = 'Podaj e-mail i hasło (min. 6 znaków).';
      return;
    }
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { username },
        emailRedirectTo: window.location.origin + `${BASE_PATH}/`
      }
    });
    if (error) {
      $('auth-msg').className = 'msg msg--error';
      $('auth-msg').textContent = error.message;
    } else if (data?.session) {
      await loadProfileAndRoute(data.session.user);
    } else {
      $('auth-msg').className = 'msg msg--ok';
      $('auth-msg').textContent = 'Konto utworzone. Poczekaj na zatwierdzenie przez administratora.';
    }
  }
});

async function logout() {
  await sb.auth.signOut();
  location.href = `${BASE_PATH}/`;
}
$('logout-btn').addEventListener('click', logout);
$('pending-logout').addEventListener('click', logout);

async function loadMyVisits() {
  if (!myProfile) return;
  const { data } = await sb.from('visits').select('place_id').eq('user_id', myProfile.id);
  myVisitedIds = new Set((data || []).map((v) => v.place_id));
}

async function loadPlaces(shouldFit = false) {
  const { data } = await sb.from('places').select('*').order('created_at', { ascending: false });
  currentPlaces = data || [];
  const approved = getApprovedPlaces();
  renderSidebar();
  renderAdminPlaces();
  if (shouldFit && approved.length) fitMapToPlaces(approved);
}

function renderSidebar() {
  const approvedPlaces = getApprovedPlaces();
  const cats = new Map();
  approvedPlaces.forEach((p) => {
    const c = p.category || 'inne';
    cats.set(c, (cats.get(c) || 0) + 1);
  });

  const catList = $('category-list');
  catList.innerHTML = '';

  const allLi = el('li');
  const allBtn = el('button', 'filter-btn' + (currentFilterCat === 'all' ? ' active' : ''));
  allBtn.innerHTML = `<span>Wszystkie</span><span>${approvedPlaces.length}</span>`;
  allBtn.onclick = () => {
    currentFilterCat = 'all';
    renderSidebar();
  };
  allLi.appendChild(allBtn);
  catList.appendChild(allLi);

  [...cats.entries()].sort().forEach(([cat, count]) => {
    const li = el('li');
    const btn = el('button', 'filter-btn' + (currentFilterCat === cat ? ' active' : ''));
    btn.innerHTML = `<span>${escapeHtml(cat)}</span><span>${count}</span>`;
    btn.onclick = () => {
      currentFilterCat = cat;
      renderSidebar();
    };
    li.appendChild(btn);
    catList.appendChild(li);
  });

  const filtered = approvedPlaces.filter((p) => {
    const matchCat = currentFilterCat === 'all' || (p.category || 'inne') === currentFilterCat;
    const matchSearch = !currentSearch || (p.title || '').toLowerCase().includes(currentSearch);
    return matchCat && matchSearch;
  });

  renderMarkers(filtered);

  $('places-count').textContent = filtered.length;
  const list = $('places-list');
  list.innerHTML = '';

  if (!filtered.length) {
    const emptyLi = el('li');
    emptyLi.innerHTML = '<div class="empty" style="padding: 16px 20px;">Brak miejsc spełniających kryteria.</div>';
    list.appendChild(emptyLi);
    return;
  }

  filtered.forEach((p) => {
    const li = el('li');
    const btn = el('button');
    const visitedBadge = myVisitedIds.has(p.id) ? ' • ✓ odwiedzone' : '';
    btn.innerHTML = `
      <div class="place-item__title">${escapeHtml(p.title)}</div>
      <div class="place-item__cat">${escapeHtml(p.category || 'inne')}${visitedBadge}</div>
    `;
    btn.onclick = () => {
      if (map && typeof p.longitude === 'number' && typeof p.latitude === 'number') {
        map.flyTo({ center: [p.longitude, p.latitude], zoom: 14 });
      }
      openPlace(p);
    };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

$('search-input').addEventListener('input', (e) => {
  currentSearch = e.target.value.toLowerCase().trim();
  renderSidebar();
});

async function openPlace(place) {
  currentPlace = place;
  $('place-title').textContent = place.title || 'Bez nazwy';

  const coordsText = (typeof place.latitude === 'number' && typeof place.longitude === 'number')
    ? `${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}`
    : '';
  $('place-meta').innerHTML = `<span>${escapeHtml(place.category || 'inne')}</span><span>${coordsText}</span>`;
  $('place-desc').textContent = place.description || 'Brak opisu.';

  if (place.entry_info) {
    $('place-entry-wrap').style.display = 'block';
    $('place-entry-info').textContent = place.entry_info;
  } else {
    $('place-entry-wrap').style.display = 'none';
  }

  const gal = $('place-gallery');
  gal.innerHTML = '';
  currentGallery = Array.isArray(place.images) ? place.images.map(safeUrl).filter(Boolean) : [];
  currentGalleryIdx = 0;

  if (!currentGallery.length) {
    gal.innerHTML = '<div class="empty">Brak zdjęć</div>';
  } else {
    currentGallery.forEach((url, i) => {
      const b = el('button', 'photo-card');
      b.innerHTML = `<img src="${escapeAttr(url)}" alt="${escapeAttr(place.title || '')}" loading="lazy">`;
      b.onclick = () => {
        currentGalleryIdx = i;
        updateLightbox();
        openModal('lightbox');
      };
      gal.appendChild(b);
    });
  }

  await checkVisitedStatus(place.id);
  openModal('place-modal');
}

async function checkVisitedStatus(placeId) {
  if (!myProfile) return;
  const { data } = await sb
    .from('visits')
    .select('id')
    .eq('place_id', placeId)
    .eq('user_id', myProfile.id)
    .maybeSingle();

  isVisited = !!data;
  if (isVisited) myVisitedIds.add(placeId);
  else myVisitedIds.delete(placeId);

  $('btn-visited').textContent = isVisited ? '✓ Odwiedzone (kliknij by usunąć)' : 'Odwiedziłem to miejsce';
  $('btn-visited').className = isVisited ? 'btn btn--small btn--ghost' : 'btn btn--small';
}

$('btn-visited').addEventListener('click', async () => {
  if (!currentPlace || !myProfile) return;
  if (isVisited) {
    await sb.from('visits').delete().eq('place_id', currentPlace.id).eq('user_id', myProfile.id);
  } else {
    await sb.from('visits').insert({ place_id: currentPlace.id, user_id: myProfile.id });
  }
  await checkVisitedStatus(currentPlace.id);
  renderSidebar();
});

function updateLightbox() {
  if (!currentGallery.length) return;
  $('lb-img').src = currentGallery[currentGalleryIdx];
  $('lb-counter').textContent = `${currentGalleryIdx + 1} / ${currentGallery.length}`;
}

$('lb-close').onclick = () => closeModal('lightbox');
$('lb-prev').onclick = () => {
  if (!currentGallery.length) return;
  currentGalleryIdx = (currentGalleryIdx - 1 + currentGallery.length) % currentGallery.length;
  updateLightbox();
};
$('lb-next').onclick = () => {
  if (!currentGallery.length) return;
  currentGalleryIdx = (currentGalleryIdx + 1) % currentGallery.length;
  updateLightbox();
};

$('nav-profile-btn').addEventListener('click', () => {
  openProfile(myProfile.username || myProfile.id, true);
});

$('nav-map-btn').addEventListener('click', (e) => {
  e.preventDefault();
  show('map', true);
  initMapIfNeeded();
});

$('nav-propose').addEventListener('click', (e) => {
  e.preventDefault();
  openEditor(null, true);
});

function renderAvatarHtml(avatarUrl, username) {
  const valid = safeUrl(avatarUrl);
  if (valid) return `<img src="${escapeAttr(valid)}" alt="">`;
  return escapeHtml((username || '?')[0].toUpperCase());
}

async function openProfile(identifier, pushUrl = true) {
  if (!identifier) return false;
  const isUuid = UUID_RE.test(identifier);
  const query = isUuid
    ? sb.from('profiles').select('*').eq('id', identifier).maybeSingle()
    : sb.from('profiles').select('*').ilike('username', identifier).maybeSingle();

  const { data: profile } = await query;
  if (!profile) return false;

  const userId = profile.id;
  const isOwnProfile = userId === myProfile.id;
  currentProfileId = userId;

  const slug = profile.username || profile.id;
  const targetUrl = `${BASE_PATH}/${encodeURIComponent(slug)}`;
  if (pushUrl) {
    if (location.pathname !== targetUrl) {
      history.pushState({ view: 'profile', slug }, '', targetUrl);
    }
  } else if (location.pathname !== targetUrl) {
    history.replaceState({ view: 'profile', slug }, '', targetUrl);
  }

  document.title = `${profile.username || 'Profil'} — Mapa Urbex`;
  show('profile', false, isOwnProfile);

  const [
    { data: visits },
    { data: friends },
    { data: posts },
    extraSocial
  ] = await Promise.all([
    sb.from('visits').select('place_id').eq('user_id', userId),
    sb.from('friendships')
      .select('*, user1:profiles!friendships_user1_id_fkey(id, username, avatar_url), user2:profiles!friendships_user2_id_fkey(id, username, avatar_url)')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .eq('status', 'accepted'),
    sb.from('wall_posts')
      .select('*, author:profiles!wall_posts_author_id_fkey(id, username, avatar_url)')
      .eq('target_id', userId)
      .order('created_at', { ascending: false }),
    isOwnProfile
      ? sb.from('friendships')
          .select('*, sender:profiles!friendships_user1_id_fkey(id, username, avatar_url)')
          .eq('user2_id', myProfile.id)
          .eq('status', 'pending')
      : sb.from('friendships')
          .select('*')
          .or(`and(user1_id.eq.${myProfile.id},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${myProfile.id})`)
          .maybeSingle()
  ]);

  $('profile-avatar-display').innerHTML = renderAvatarHtml(profile.avatar_url, profile.username);
  $('profile-name-display').textContent = profile.username || 'User';
  $('profile-handle').textContent = profile.username ? `/${profile.username}` : '';

  const actions = $('profile-actions');
  actions.innerHTML = '';

  const copyBtn = el('button', 'btn btn--small btn--ghost');
  copyBtn.textContent = 'Kopiuj link';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      copyBtn.textContent = 'Skopiowano ✓';
      setTimeout(() => { copyBtn.textContent = 'Kopiuj link'; }, 1500);
    } catch {}
  };
  actions.appendChild(copyBtn);

  if (isOwnProfile) {
    const btn = el('button', 'btn btn--small btn--ghost');
    btn.textContent = 'Edytuj profil';
    btn.onclick = openEditProfile;
    actions.appendChild(btn);
  } else {
    const f = extraSocial.data;
    if (f) {
      if (f.status === 'accepted') {
        const btn = el('button', 'btn btn--small btn--danger');
        btn.textContent = 'Usuń znajomego';
        btn.onclick = async () => {
          await sb.from('friendships').delete().eq('id', f.id);
          openProfile(slug, false);
        };
        actions.appendChild(btn);
      } else if (f.user1_id === myProfile.id) {
        const btn = el('button', 'btn btn--small btn--ghost');
        btn.textContent = 'Zaproszenie wysłane';
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.style.cursor = 'not-allowed';
        actions.appendChild(btn);
      } else if (f.user2_id === myProfile.id) {
        const btn = el('button', 'btn btn--small');
        btn.textContent = 'Akceptuj';
        btn.onclick = async () => {
          await sb.from('friendships').update({ status: 'accepted' }).eq('id', f.id);
          openProfile(slug, false);
        };

        const rej = el('button', 'btn btn--small btn--danger');
        rej.textContent = 'Odrzuć';
        rej.onclick = async () => {
          await sb.from('friendships').delete().eq('id', f.id);
          openProfile(slug, false);
        };

        actions.appendChild(btn);
        actions.appendChild(rej);
      }
    } else {
      const btn = el('button', 'btn btn--small');
      btn.textContent = 'Dodaj do znajomych';
      btn.onclick = async () => {
        await sb.from('friendships').insert({ user1_id: myProfile.id, user2_id: userId, status: 'pending' });
        openProfile(slug, false);
      };
      actions.appendChild(btn);
    }
  }

  if (isOwnProfile) {
    const reqs = extraSocial.data;
    const reqList = $('incoming-requests-list');
    reqList.innerHTML = '';
    $('incoming-requests-wrap').style.display = reqs?.length ? 'block' : 'none';

    (reqs || []).forEach((r) => {
      if (!r.sender) return;
      const li = el('li');
      li.innerHTML = `
        <div class="sidebar-avatar">${renderAvatarHtml(r.sender.avatar_url, r.sender.username)}</div>
        <span style="flex:1; font-size:0.8rem;">${escapeHtml(r.sender.username || 'User')}</span>
      `;

      const acc = el('button', 'btn btn--small');
      acc.textContent = '✓';
      acc.title = 'Akceptuj';
      acc.onclick = async () => {
        await sb.from('friendships').update({ status: 'accepted' }).eq('id', r.id);
        openProfile(myProfile.username || myProfile.id, false);
      };

      const rej = el('button', 'btn btn--small btn--danger');
      rej.textContent = '✕';
      rej.title = 'Odrzuć';
      rej.onclick = async () => {
        await sb.from('friendships').delete().eq('id', r.id);
        openProfile(myProfile.username || myProfile.id, false);
      };

      li.appendChild(acc);
      li.appendChild(rej);
      reqList.appendChild(li);
    });
  } else {
    $('incoming-requests-wrap').style.display = 'none';
  }

  const fList = $('friends-list');
  fList.innerHTML = '';
  let fCount = 0;

  (friends || []).forEach((f) => {
    const fp = f.user1_id === userId ? f.user2 : f.user1;
    if (!fp) return;
    fCount++;
    const li = el('li');
    li.innerHTML = `<div class="sidebar-avatar">${renderAvatarHtml(fp.avatar_url, fp.username)}</div>`;
    const nameBtn = el('button');
    nameBtn.textContent = fp.username || 'User';
    nameBtn.onclick = () => openProfile(fp.username || fp.id, true);
    li.appendChild(nameBtn);
    fList.appendChild(li);
  });

  if (!fCount) {
    fList.innerHTML = '<li class="empty">Brak znajomych</li>';
  }

  const placesById = new Map(getApprovedPlaces().map((p) => [p.id, p]));
  const vList = $('visited-list');
  vList.innerHTML = '';
  let vCount = 0;

  (visits || []).forEach((v) => {
    const place = placesById.get(v.place_id);
    if (!place) return;
    vCount++;
    const li = el('li');
    const btn = el('button', 'visited-link');
    btn.textContent = place.title;
    btn.onclick = () => {
      show('map', true);
      initMapIfNeeded();
      if (map && typeof place.longitude === 'number' && typeof place.latitude === 'number') {
        map.flyTo({ center: [place.longitude, place.latitude], zoom: 14 });
      }
      openPlace(place);
    };
    li.appendChild(btn);
    vList.appendChild(li);
  });

  if (!vCount) {
    vList.innerHTML = '<li class="empty">Brak odwiedzonych miejsc</li>';
  }

  $('profile-stats').textContent = `${fCount} znajomych • ${vCount} odwiedzonych`;

  const feed = $('wall-feed');
  feed.innerHTML = '';

  if (!posts?.length) {
    feed.innerHTML = '<div class="empty">Brak wpisów na ścianie.</div>';
    return true;
  }

  posts.forEach((p) => {
    const authorName = p.author?.username || 'User';
    const d = new Date(p.created_at).toLocaleString('pl-PL');
    const div = el('div', 'wall-post');
    div.innerHTML = `
      <div class="wall-post__header">
        <div class="sidebar-avatar">${renderAvatarHtml(p.author?.avatar_url, authorName)}</div>
        <div>
          <button type="button" class="wall-post__author">${escapeHtml(authorName)}</button>
          <div class="wall-post__date">${escapeHtml(d)}</div>
        </div>
      </div>
      <div class="wall-post__content">${escapeHtml(p.content)}</div>
    `;
    const authorBtn = div.querySelector('.wall-post__author');
    if (p.author?.username || p.author?.id) {
      authorBtn.onclick = () => openProfile(p.author.username || p.author.id, true);
    }
    feed.appendChild(div);
  });

  return true;
}

$('wall-submit').addEventListener('click', async () => {
  const content = $('wall-input').value.trim();
  if (!content || !myProfile || !currentProfileId) return;
  $('wall-input').value = '';
  await sb.from('wall_posts').insert({
    author_id: myProfile.id,
    target_id: currentProfileId,
    content
  });
  openProfile(getSlugFromPath() || currentProfileId, false);
});

let searchTimer = null;
$('global-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const resBox = $('search-results');

  if (q.length < 2) {
    resBox.classList.add('hidden');
    resBox.innerHTML = '';
    return;
  }

  searchTimer = setTimeout(async () => {
    const { data } = await sb
      .from('profiles')
      .select('id, username, avatar_url')
      .ilike('username', `%${q}%`)
      .limit(5);

    resBox.innerHTML = '';
    if (!data?.length) {
      resBox.innerHTML = '<li><button type="button" disabled style="opacity:0.6">Brak wyników</button></li>';
      resBox.classList.remove('hidden');
      return;
    }

    data.forEach((u) => {
      const li = el('li');
      const btn = el('button');
      btn.type = 'button';
      btn.innerHTML = `
        <div class="sidebar-avatar" style="width:26px;height:26px;font-size:0.75rem;">${renderAvatarHtml(u.avatar_url, u.username)}</div>
        <span>${escapeHtml(u.username || 'User')}</span>
      `;
      btn.onclick = () => {
        $('global-search').value = '';
        resBox.classList.add('hidden');
        openProfile(u.username || u.id, true);
      };
      li.appendChild(btn);
      resBox.appendChild(li);
    });
    resBox.classList.remove('hidden');
  }, 250);
});

document.addEventListener('click', (e) => {
  if (!$('global-search-wrap')?.contains(e.target)) {
    $('search-results')?.classList.add('hidden');
  }
});

function openEditProfile() {
  $('edit-username').value = myProfile.username || '';
  $('edit-avatar').value = myProfile.avatar_url || '';
  $('edit-msg').className = 'msg';
  openModal('profile-edit-modal');
}

$('edit-save').addEventListener('click', async () => {
  const username = $('edit-username').value.trim();
  const rawAvatar = $('edit-avatar').value.trim();

  const userErr = validateUsername(username);
  if (userErr) {
    $('edit-msg').className = 'msg msg--error';
    $('edit-msg').textContent = userErr;
    return;
  }

  if (rawAvatar && !safeUrl(rawAvatar)) {
    $('edit-msg').className = 'msg msg--error';
    $('edit-msg').textContent = 'Podaj poprawny link zaczynający się od https://';
    return;
  }

  const avatar_url = rawAvatar ? safeUrl(rawAvatar) : '';
  const { error } = await sb
    .from('profiles')
    .update({ username, avatar_url })
    .eq('id', myProfile.id);

  if (error) {
    $('edit-msg').className = 'msg msg--error';
    $('edit-msg').textContent = error.code === '23505'
      ? 'Ta nazwa użytkownika jest już zajęta.'
      : error.message;
  } else {
    myProfile.username = username;
    myProfile.avatar_url = avatar_url;
    closeModal('profile-edit-modal');
    openProfile(myProfile.username, true);
  }
});

$('nav-admin').addEventListener('click', async (e) => {
  e.preventDefault();
  openModal('admin-modal');
  await renderAdminUsers();
  renderAdminPlaces();
});

$('admin-tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (!t) return;
  document.querySelectorAll('#admin-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
  $('tab-users').classList.toggle('hidden', t.dataset.tab !== 'users');
  $('tab-places').classList.toggle('hidden', t.dataset.tab !== 'places');
});

async function renderAdminUsers() {
  const { data } = await sb.from('profiles').select('*').order('created_at');
  const users = data || [];
  allProfilesMap = new Map(users.map((u) => [u.id, u]));

  const pending = users.filter((u) => u.role === 'pending_user');
  const approved = users.filter((u) => u.role !== 'pending_user');

  $('pending-users').innerHTML = pending.length ? '' : '<li class="empty">Brak oczekujących</li>';
  pending.forEach((u) => {
    const li = el('li');
    li.innerHTML = `<span class="email">${escapeHtml(u.username ? `${u.username} (${u.email})` : u.email)}</span>`;
    const actions = el('div', 'admin-row-actions');

    const a = el('button', 'btn btn--small');
    a.textContent = 'Zatwierdź';
    a.onclick = async () => {
      await sb.from('profiles').update({ role: 'approved_user' }).eq('id', u.id);
      await renderAdminUsers();
    };

    const r = el('button', 'btn btn--small btn--danger');
    r.textContent = 'Odrzuć';
    r.onclick = async () => {
      if (!confirm('Usunąć użytkownika?')) return;
      await sb.from('profiles').delete().eq('id', u.id);
      await renderAdminUsers();
    };

    actions.append(a, r);
    li.appendChild(actions);
    $('pending-users').appendChild(li);
  });

  $('approved-users').innerHTML = '';
  approved.forEach((u) => {
    const li = el('li');
    const label = u.username ? `${u.username} (${u.email})` : u.email;
    li.innerHTML = `<span class="email">${escapeHtml(label)}</span>`;

    const actions = el('div', 'admin-row-actions');
    if (u.id === myProfile.id) {
      const selfTag = el('span');
      selfTag.style.fontSize = '0.7rem';
      selfTag.style.opacity = '0.6';
      selfTag.textContent = 'ADMIN (TY)';
      actions.appendChild(selfTag);
    } else {
      const select = el('select', 'role-select');
      select.setAttribute('aria-label', 'Rola użytkownika');
      [
        ['approved_user', 'Użytkownik'],
        ['moderator', 'Moderator'],
        ['admin', 'Admin'],
        ['pending_user', 'Zablokowany']
      ].forEach(([val, text]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        if (u.role === val) opt.selected = true;
        select.appendChild(opt);
      });

      select.onchange = async () => {
        select.disabled = true;
        await sb.from('profiles').update({ role: select.value }).eq('id', u.id);
        await renderAdminUsers();
      };
      actions.appendChild(select);
    }

    li.appendChild(actions);
    $('approved-users').appendChild(li);
  });
}

function renderAdminPlaces() {
  const pendingList = $('admin-pending-places');
  const approvedList = $('admin-places-list');
  const pending = getPendingPlaces();
  const approved = getApprovedPlaces();

  pendingList.innerHTML = pending.length ? '' : '<li class="empty">Brak propozycji do zatwierdzenia</li>';
  pending.forEach((p) => {
    const li = el('li');
    const author = p.created_by ? allProfilesMap.get(p.created_by) : null;
    const authorName = author?.username || author?.email || 'Nieznany';

    const info = el('div', 'admin-place-info');
    info.innerHTML = `
      <span>${escapeHtml(p.title)}</span>
      <div class="admin-place-meta">${escapeHtml(p.category || 'inne')} • Autor: ${escapeHtml(authorName)}</div>
    `;

    const actions = el('div', 'admin-row-actions');

    const approveBtn = el('button', 'btn btn--small');
    approveBtn.textContent = 'Zatwierdź';
    approveBtn.onclick = async () => {
      await sb.from('places').update({ status: 'approved' }).eq('id', p.id);
      await loadPlaces(false);
    };

    const editBtn = el('button', 'btn btn--small btn--ghost');
    editBtn.textContent = 'Edytuj';
    editBtn.onclick = () => openEditor(p, false);

    const rejectBtn = el('button', 'btn btn--small btn--danger');
    rejectBtn.textContent = 'Odrzuć';
    rejectBtn.onclick = async () => {
      if (!confirm('Odrzucić i usunąć propozycję?')) return;
      await sb.from('places').delete().eq('id', p.id);
      await loadPlaces(false);
    };

    actions.append(approveBtn, editBtn, rejectBtn);
    li.append(info, actions);
    pendingList.appendChild(li);
  });

  approvedList.innerHTML = approved.length ? '' : '<li class="empty">Brak miejsc</li>';
  approved.forEach((p) => {
    const li = el('li');
    li.innerHTML = `<span>${escapeHtml(p.title)}</span>`;
    const actions = el('div', 'admin-row-actions');
    const e = el('button', 'btn btn--small btn--ghost');
    e.textContent = 'Edytuj';
    e.onclick = () => openEditor(p, false);
    actions.appendChild(e);
    li.appendChild(actions);
    approvedList.appendChild(li);
  });
}

function syncFormToJson() {
  let currentImages = [];
  try {
    const parsed = JSON.parse($('editor-json').value);
    if (Array.isArray(parsed.images)) currentImages = parsed.images;
  } catch {}

  const obj = {
    title: $('ed-title').value.trim(),
    category: $('ed-category').value.trim() || 'inne',
    description: $('ed-desc').value,
    entry_info: $('ed-entry').value,
    latitude: parseFloat($('ed-lat').value) || 0,
    longitude: parseFloat($('ed-lng').value) || 0,
    images: currentImages
  };
  $('editor-json').value = JSON.stringify(obj, null, 2);
}

function syncJsonToForm() {
  try {
    const d = JSON.parse($('editor-json').value);
    $('ed-title').value = d.title || '';
    $('ed-category').value = d.category || 'inne';
    $('ed-desc').value = d.description || '';
    $('ed-entry').value = d.entry_info || '';
    $('ed-lat').value = d.latitude ?? '';
    $('ed-lng').value = d.longitude ?? '';
  } catch {}
}

['ed-title', 'ed-category', 'ed-desc', 'ed-entry', 'ed-lat', 'ed-lng'].forEach((id) => {
  $(id).addEventListener('input', syncFormToJson);
});
$('editor-json').addEventListener('input', syncJsonToForm);

$('ed-use-center').addEventListener('click', () => {
  if (!map) return;
  const c = map.getCenter();
  $('ed-lat').value = c.lat.toFixed(6);
  $('ed-lng').value = c.lng.toFixed(6);
  syncFormToJson();
});

$('btn-new-place').addEventListener('click', () => openEditor(null, false));

function openEditor(place, propose = false) {
  isProposalMode = propose || myProfile?.role !== 'admin';
  editingPlaceId = place ? place.id : null;

  if (isProposalMode) {
    $('editor-title').textContent = 'Zaproponuj miejsce';
    $('editor-save').textContent = 'Wyślij propozycję';
    $('editor-delete').classList.add('hidden');
  } else {
    $('editor-title').textContent = place ? 'Edytuj miejsce' : 'Nowe miejsce';
    $('editor-save').textContent = 'Zapisz';
    $('editor-delete').classList.toggle('hidden', !place);
  }

  $('editor-msg').className = 'msg';

  const defaultCenter = map ? map.getCenter() : { lat: 51.7592, lng: 19.4560 };
  const t = place
    ? {
        title: place.title,
        category: place.category,
        description: place.description,
        entry_info: place.entry_info,
        latitude: place.latitude,
        longitude: place.longitude,
        images: place.images || []
      }
    : {
        title: '',
        category: 'inne',
        description: '',
        entry_info: '',
        latitude: Number(defaultCenter.lat.toFixed(6)),
        longitude: Number(defaultCenter.lng.toFixed(6)),
        images: []
      };

  $('editor-json').value = JSON.stringify(t, null, 2);
  syncJsonToForm();
  openModal('editor-modal');
}

$('editor-save').addEventListener('click', async () => {
  try {
    const d = JSON.parse($('editor-json').value);
    if (!d.title || !d.title.trim()) {
      throw new Error('Podaj nazwę obiektu.');
    }

    const baseData = {
      title: d.title.trim(),
      category: (d.category || 'inne').trim(),
      description: d.description || '',
      entry_info: d.entry_info || '',
      latitude: Number(d.latitude),
      longitude: Number(d.longitude),
      images: Array.isArray(d.images) ? d.images : []
    };

    if (editingPlaceId && !isProposalMode) {
      const { error } = await sb.from('places').update(baseData).eq('id', editingPlaceId);
      if (error) throw error;
      closeModal('editor-modal');
      await loadPlaces(false);
    } else {
      const insertData = {
        ...baseData,
        status: isProposalMode ? 'pending' : 'approved',
        created_by: myProfile?.id || null
      };
      const { error } = await sb.from('places').insert(insertData);
      if (error) throw error;

      if (isProposalMode) {
        $('editor-msg').className = 'msg msg--ok';
        $('editor-msg').textContent = 'Propozycja wysłana do zatwierdzenia przez administratora.';
        setTimeout(() => {
          closeModal('editor-modal');
        }, 1100);
      } else {
        closeModal('editor-modal');
        await loadPlaces(false);
      }
    }
  } catch (e) {
    $('editor-msg').className = 'msg msg--error';
    $('editor-msg').textContent = e.message;
  }
});

$('editor-delete').addEventListener('click', async () => {
  if (!editingPlaceId || isProposalMode || !confirm('Usunąć to miejsce?')) return;
  await sb.from('places').delete().eq('id', editingPlaceId);
  closeModal('editor-modal');
  await loadPlaces(false);
});

$('editor-upload').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  let d;
  try {
    d = JSON.parse($('editor-json').value);
  } catch {
    return;
  }
  if (!Array.isArray(d.images)) d.images = [];

  for (const f of files) {
    const path = `places/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, '_')}`;
    const { error } = await sb.storage.from('place-images').upload(path, f);
    if (!error) {
      const { data } = sb.storage.from('place-images').getPublicUrl(path);
      d.images.push(data.publicUrl);
    }
  }
  $('editor-json').value = JSON.stringify(d, null, 2);
  e.target.value = '';
});

(async function start() {
  await checkSession();
  sb.auth.onAuthStateChange((_e, s) => {
    if (!s) show('auth');
  });
})();
