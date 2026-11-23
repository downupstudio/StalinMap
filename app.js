const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

let map, markers = [], currentPlaces = [], currentProfile = null, myProfile = null;
let currentFilterCat = 'all', currentSearch = '';
let editingPlaceId = null, currentGallery = [], currentGalleryIdx = 0;
let currentPlace = null, isVisited = false, currentProfileId = null;

// motyw
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

// mapa
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
  if (map) { map.resize(); return; }
  map = new maplibregl.Map({ container: 'map', style: getMapStyle(document.documentElement.getAttribute('data-theme')), center: [19.9450, 50.0647], zoom: 11 });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('style.load', () => { if (currentPlaces.length) renderMarkers(currentPlaces); });
}
function clearMarkers() { markers.forEach(m => m.marker.remove()); markers = []; }
function renderMarkers(places) {
  clearMarkers();
  places.forEach(place => {
    const mEl = el('button', 'map-marker');
    const marker = new maplibregl.Marker({ element: mEl }).setLngLat([place.longitude, place.latitude]).addTo(map);
    mEl.addEventListener('click', () => openPlace(place));
    markers.push({ marker, place });
  });
}

// routing ui
function show(which) {
  ['auth', 'pending', 'map', 'profile'].forEach(v => $('view-' + v)?.classList.toggle('hidden', v !== which));
  if (which === 'map' || which === 'profile') {
    $('nav-profile-btn').classList.remove('hidden');
    $('logout-btn').classList.remove('hidden');
    if (myProfile?.role === 'admin') $('nav-admin').classList.remove('hidden');
  } else {
    $('nav-admin').classList.add('hidden');
    $('nav-profile-btn').classList.add('hidden');
    $('logout-btn').classList.add('hidden');
  }
}
function openModal(id) { $(id).setAttribute('data-open', 'true'); }
function closeModal(id) { $(id).setAttribute('data-open', 'false'); }
document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));

// autoryzacja
async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return show('auth');
  loadProfileAndRoute(session.user);
}
async function loadProfileAndRoute(user) {
  const { data: profile, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (error || !profile) return show('pending');
  currentProfile = profile; myProfile = profile; currentProfileId = user.id;
  if (profile.role === 'admin' || profile.role === 'approved_user') {
    show('map'); initMapIfNeeded(); await loadPlaces();
  } else show('pending');
}
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithPassword({ email: $('auth-email').value.trim(), password: $('auth-password').value });
  if (error) { $('auth-msg').className = 'msg msg--error'; $('auth-msg').textContent = error.message; }
  else checkSession();
});
$('btn-register').addEventListener('click', async () => {
  const email = $('auth-email').value.trim(), password = $('auth-password').value, username = $('auth-username').value.trim();
  if (!email || password.length < 6) { $('auth-msg').className = 'msg msg--error'; $('auth-msg').textContent = 'Podaj e-mail i hasło (min. 6 znaków).'; return; }
  const { error } = await sb.auth.signUp({ email, password, options: { data: { username } } });
  if (error) { $('auth-msg').className = 'msg msg--error'; $('auth-msg').textContent = error.message; }
  else { $('auth-msg').className = 'msg msg--ok'; $('auth-msg').textContent = 'Konto utworzone. Poczekaj na zatwierdzenie.'; }
});
async function logout() { await sb.auth.signOut(); location.reload(); }
$('logout-btn').addEventListener('click', logout);
$('pending-logout').addEventListener('click', logout);

$('username-row').style.display = 'block';

// miejsca na mapie
async function loadPlaces() {
  const { data } = await sb.from('places').select('*').order('created_at', { ascending: false });
  currentPlaces = data || [];
  renderMarkers(currentPlaces); renderSidebar(); renderAdminPlaces();
}
function renderSidebar() {
  const cats = new Map(); currentPlaces.forEach(p => { const c = p.category || 'inne'; cats.set(c, (cats.get(c)||0)+1); });
  const catList = $('category-list'); catList.innerHTML = '';
  const allLi = el('li'); const allBtn = el('button', 'filter-btn' + (currentFilterCat==='all'?' active':''));
  allBtn.innerHTML = `<span>Wszystkie</span><span>${currentPlaces.length}</span>`;
  allBtn.onclick = () => { currentFilterCat='all'; renderSidebar(); }; allLi.appendChild(allBtn); catList.appendChild(allLi);
  [...cats.entries()].sort().forEach(([cat, count]) => {
    const li = el('li'); const btn = el('button', 'filter-btn' + (currentFilterCat===cat?' active':''));
    btn.innerHTML = `<span>${escapeHtml(cat)}</span><span>${count}</span>`;
    btn.onclick = () => { currentFilterCat=cat; renderSidebar(); }; li.appendChild(btn); catList.appendChild(li);
  });
  const filtered = currentPlaces.filter(p => (currentFilterCat==='all'||p.category===currentFilterCat) && (!currentSearch||p.title.toLowerCase().includes(currentSearch)));
  $('places-count').textContent = filtered.length;
  const list = $('places-list'); list.innerHTML = '';
  filtered.forEach(p => {
    const li = el('li'); const btn = el('button');
    btn.innerHTML = `<div style="font-weight:500">${escapeHtml(p.title)}</div><div style="font-size:0.6rem;opacity:0.5">${escapeHtml(p.category||'inne')}</div>`;
    btn.onclick = () => { map.flyTo({center:[p.longitude,p.latitude],zoom:14}); openPlace(p); };
    li.appendChild(btn); list.appendChild(li);
  });
}
$('search-input').addEventListener('input', e => { currentSearch = e.target.value.toLowerCase(); renderSidebar(); });

async function openPlace(place) {
  currentPlace = place;
  $('place-title').textContent = place.title;
  $('place-meta').innerHTML = `<span>${escapeHtml(place.category||'inne')}</span><span>${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}</span>`;
  $('place-desc').textContent = place.description || '—';
  if (place.entry_info) { $('place-entry-wrap').style.display = 'block'; $('place-entry-info').textContent = place.entry_info; }
  else $('place-entry-wrap').style.display = 'none';
  
  const gal = $('place-gallery'); gal.innerHTML = ''; currentGallery = place.images || []; currentGalleryIdx = 0;
  if (!currentGallery.length) gal.innerHTML = '<div class="empty">Brak zdjęć</div>';
  else currentGallery.forEach((url, i) => {
    const b = el('button', 'photo-card'); b.innerHTML = `<img src="${escapeAttr(url)}" loading="lazy">`;
    b.onclick = () => { currentGalleryIdx=i; updateLightbox(); $('lightbox').setAttribute('data-open','true'); }; gal.appendChild(b);
  });

  await checkVisitedStatus(place.id);
  openModal('place-modal');
}
async function checkVisitedStatus(placeId) {
  const { data: { user } } = await sb.auth.getUser(); if (!user) return;
  const { data } = await sb.from('visits').select('id').eq('place_id', placeId).eq('user_id', user.id).maybeSingle();
  isVisited = !!data;
  $('btn-visited').textContent = isVisited ? '✓ Odwiedzone (kliknij by usunąć)' : 'Odwiedziłem to miejsce';
  $('btn-visited').className = isVisited ? 'btn btn--small btn--ghost' : 'btn btn--small';
}
$('btn-visited').addEventListener('click', async () => {
  if (!currentPlace) return;
  const { data: { user } } = await sb.auth.getUser(); if (!user) return;
  if (isVisited) await sb.from('visits').delete().eq('place_id', currentPlace.id).eq('user_id', user.id);
  else await sb.from('visits').insert({ place_id: currentPlace.id, user_id: user.id });
  checkVisitedStatus(currentPlace.id);
});

// lightbox
function updateLightbox() { $('lb-img').src = currentGallery[currentGalleryIdx]; $('lb-counter').textContent = `${currentGalleryIdx+1} / ${currentGallery.length}`; }
$('lb-close').onclick = () => $('lightbox').setAttribute('data-open','false');
$('lb-prev').onclick = () => { currentGalleryIdx = (currentGalleryIdx-1+currentGallery.length)%currentGallery.length; updateLightbox(); };
$('lb-next').onclick = () => { currentGalleryIdx = (currentGalleryIdx+1)%currentGallery.length; updateLightbox(); };

// profil
$('nav-profile-btn').addEventListener('click', () => openProfile(myProfile.id));
$('nav-map-btn').addEventListener('click', (e) => { e.preventDefault(); show('map'); if(map) map.resize(); });

async function openProfile(userId) {
  show('profile'); currentProfileId = userId;
  const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).single();
  if (!profile) return;

  $('profile-avatar-display').innerHTML = profile.avatar_url ? `<img src="${escapeAttr(profile.avatar_url)}">` : (profile.username||'?')[0].toUpperCase();
  $('profile-name-display').textContent = profile.username || 'User';

  const actions = $('profile-actions'); actions.innerHTML = '';
  
  if (userId === myProfile.id) {
    const btn = el('button', 'btn btn--small btn--ghost'); 
    btn.textContent = 'Edytuj profil'; 
    btn.onclick = openEditProfile; 
    actions.appendChild(btn);
  } else {
    const { data: f } = await sb.from('friendships').select('*').or(`and(user1_id.eq.${myProfile.id},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${myProfile.id})`).maybeSingle();
    
    if (f) {
      if (f.status === 'accepted') {
        const btn = el('button', 'btn btn--small btn--danger'); 
        btn.textContent = 'Usuń znajomego'; 
        btn.onclick = async () => { await sb.from('friendships').delete().eq('id', f.id); openProfile(userId); };
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
        btn.textContent = 'Akceptuj zaproszenie'; 
        btn.onclick = async () => { await sb.from('friendships').update({ status: 'accepted' }).eq('id', f.id); openProfile(userId); };
        
        const rej = el('button', 'btn btn--small btn--danger'); 
        rej.textContent = 'Odrzuć'; 
        rej.onclick = async () => { await sb.from('friendships').delete().eq('id', f.id); openProfile(userId); };
        
        actions.appendChild(btn); actions.appendChild(rej);
      }
    } else {
      const btn = el('button', 'btn btn--small'); 
      btn.textContent = 'Dodaj do znajomych'; 
      btn.onclick = async () => { await sb.from('friendships').insert({ user1_id: myProfile.id, user2_id: userId, status: 'pending' }); openProfile(userId); };
      actions.appendChild(btn);
    }
  }

  if (userId === myProfile.id) {
    const { data: reqs } = await sb.from('friendships')
      .select('*, sender:profiles!friendships_user1_id_fkey(id, username, avatar_url)')
      .eq('user2_id', myProfile.id)
      .eq('status', 'pending');
    
    const reqList = $('incoming-requests-list');
    reqList.innerHTML = '';
    $('incoming-requests-wrap').style.display = reqs?.length ? 'block' : 'none';
    
    if (reqs) {
      reqs.forEach(r => {
        const li = el('li');
        li.innerHTML = `<div class="sidebar-avatar">${r.sender.avatar_url ? `<img src="${r.sender.avatar_url}">` : (r.sender.username || '?')[0].toUpperCase()}</div><span style="flex:1; font-size:0.8rem;">${escapeHtml(r.sender.username)}</span>`;
        
        const acc = el('button', 'btn btn--small'); acc.textContent = '✓'; acc.title = 'Akceptuj';
        acc.onclick = async () => { await sb.from('friendships').update({ status: 'accepted' }).eq('id', r.id); openProfile(myProfile.id); };
        
        const rej = el('button', 'btn btn--small btn--danger'); rej.textContent = '✕'; rej.title = 'Odrzuć';
        rej.onclick = async () => { await sb.from('friendships').delete().eq('id', r.id); openProfile(myProfile.id); };
        
        li.appendChild(acc); li.appendChild(rej);
        reqList.appendChild(li);
      });
    }
  } else {
    $('incoming-requests-wrap').style.display = 'none';
  }

  const { data: friends } = await sb.from('friendships')
    .select(`*, user1:profiles!friendships_user1_id_fkey(id, username, avatar_url), user2:profiles!friendships_user2_id_fkey(id, username, avatar_url)`)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .eq('status', 'accepted');
    
  const fList = $('friends-list'); fList.innerHTML = ''; let fCount = 0;
  if (friends) {
    friends.forEach(f => {
      const fp = f.user1_id === userId ? f.user2 : f.user1; fCount++;
      const li = el('li');
      li.innerHTML = `<div class="sidebar-avatar">${fp.avatar_url?`<img src="${fp.avatar_url}">`:(fp.username||'?')[0].toUpperCase()}</div><span style="cursor:pointer" onclick="openProfile('${fp.id}')">${escapeHtml(fp.username||'User')}</span>`;
      fList.appendChild(li);
    });
  }
  $('profile-friends-count').textContent = `${fCount} znajomych`;

  const { data: visits } = await sb.from('visits').select('places(title)').eq('user_id', userId);
  const vList = $('visited-list'); vList.innerHTML = '';
  visits?.forEach(v => { if (v.places) { const li = el('li'); li.textContent = v.places.title; vList.appendChild(li); } });

  const { data: posts } = await sb.from('wall_posts').select('*, author:profiles!wall_posts_author_id_fkey(username, avatar_url)').eq('target_id', userId).order('created_at', { ascending: false });
  const feed = $('wall-feed'); feed.innerHTML = '';
  posts?.forEach(p => {
    const d = new Date(p.created_at).toLocaleString();
    const a = p.author.avatar_url ? `<img src="${p.author.avatar_url}">` : (p.author.username||'?')[0].toUpperCase();
    const div = el('div', 'wall-post');
    div.innerHTML = `<div class="wall-post__header"><div class="sidebar-avatar">${a}</div><div><div class="wall-post__author">${escapeHtml(p.author.username||'User')}</div><div class="wall-post__date">${d}</div></div></div><div class="wall-post__content">${escapeHtml(p.content)}</div>`;
    feed.appendChild(div);
  });
}

$('wall-submit').addEventListener('click', async () => {
  const content = $('wall-input').value.trim(); if (!content) return;
  $('wall-input').value = '';
  await sb.from('wall_posts').insert({ author_id: myProfile.id, target_id: currentProfileId, content });
  openProfile(currentProfileId);
});

// wyszukiwarka
$('global-search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (q.length < 2) return;
  const { data } = await sb.from('profiles').select('id').ilike('username', `%${q}%`).limit(1);
  if (data?.length) { openProfile(data[0].id); e.target.value = ''; } else alert('Nie znaleziono użytkownika');
});

// edycja profilu
function openEditProfile() {
  $('edit-username').value = myProfile.username || ''; $('edit-avatar').value = myProfile.avatar_url || '';
  openModal('profile-edit-modal');
}
$('edit-save').addEventListener('click', async () => {
  const username = $('edit-username').value.trim(), avatar_url = $('edit-avatar').value.trim();
  const { error } = await sb.from('profiles').update({ username, avatar_url }).eq('id', myProfile.id);
  if (error) { $('edit-msg').className='msg msg--error'; $('edit-msg').textContent=error.message; }
  else { myProfile.username=username; myProfile.avatar_url=avatar_url; closeModal('profile-edit-modal'); openProfile(myProfile.id); }
});

// admin
$('nav-admin').addEventListener('click', async (e) => { e.preventDefault(); openModal('admin-modal'); renderAdminUsers(); renderAdminPlaces(); });
$('admin-tabs').addEventListener('click', e => { const t=e.target.closest('.tab'); if(!t) return; document.querySelectorAll('#admin-tabs .tab').forEach(x=>x.classList.toggle('active',x===t)); $('tab-users').classList.toggle('hidden',t.dataset.tab!=='users'); $('tab-places').classList.toggle('hidden',t.dataset.tab!=='places'); });
async function renderAdminUsers() {
  const { data } = await sb.from('profiles').select('*').order('created_at');
  const pending = data.filter(u=>u.role==='pending_user'), approved = data.filter(u=>u.role!=='pending_user');
  $('pending-users').innerHTML = pending.length?'':'<li class="empty">Brak</li>';
  pending.forEach(u => {
    const li = el('li'); li.innerHTML = `<span class="email" style="flex:1">${u.email}</span>`;
    const a = el('button','btn btn--small'); a.textContent='Zatwierdź'; a.onclick=async()=>{ await sb.from('profiles').update({role:'approved_user'}).eq('id',u.id); renderAdminUsers(); };
    const r = el('button','btn btn--small btn--danger'); r.textContent='Odrzuć'; r.onclick=async()=>{ if(!confirm('Usunąć?'))return; await sb.from('profiles').delete().eq('id',u.id); renderAdminUsers(); };
    li.append(a,r); $('pending-users').appendChild(li);
  });
  $('approved-users').innerHTML = '';
  approved.forEach(u => {
    const li = el('li'); li.innerHTML = `<span class="email" style="flex:1">${u.email} (${u.role})</span>`;
    if (u.id !== myProfile.id) {
      const d = el('button','btn btn--small btn--ghost'); d.textContent = u.role==='admin'?'Zdegraduj':'Zablokuj';
      d.onclick=async()=>{ await sb.from('profiles').update({role:u.role==='admin'?'approved_user':'pending_user'}).eq('id',u.id); renderAdminUsers(); };
      li.appendChild(d);
    }
    $('approved-users').appendChild(li);
  });
}
function renderAdminPlaces() {
  const l = $('admin-places-list'); l.innerHTML = '';
  currentPlaces.forEach(p => { const li = el('li'); li.innerHTML = `<span style="flex:1">${p.title}</span>`; const e = el('button','btn btn--small btn--ghost'); e.textContent='Edytuj'; e.onclick=()=>openEditor(p); li.appendChild(e); l.appendChild(li); });
}
$('btn-new-place').addEventListener('click', () => openEditor(null));
function openEditor(place) {
  editingPlaceId = place ? place.id : null; $('editor-title').textContent = place ? 'Edytuj' : 'Nowe';
  $('editor-delete').classList.toggle('hidden', !place);
  const t = place ? { title:place.title, category:place.category, description:place.description, entry_info:place.entry_info, latitude:place.latitude, longitude:place.longitude, images:place.images } : { title:'Nowe', category:'inne', description:'', entry_info:'', latitude:50.06, longitude:19.94, images:[] };
  $('editor-json').value = JSON.stringify(t, null, 2); openModal('editor-modal');
}
$('editor-save').addEventListener('click', async () => {
  try { const d = JSON.parse($('editor-json').value);
    const p = { title:d.title, category:d.category||'inne', description:d.description||'', entry_info:d.entry_info||'', latitude:d.latitude, longitude:d.longitude, images:d.images||[] };
    const q = editingPlaceId ? sb.from('places').update(p).eq('id',editingPlaceId) : sb.from('places').insert(p);
    const { error } = await q; if (error) throw error;
    closeModal('editor-modal'); loadPlaces();
  } catch(e) { $('editor-msg').className='msg msg--error'; $('editor-msg').textContent=e.message; }
});
$('editor-delete').addEventListener('click', async () => { if(!editingPlaceId||!confirm('Usunąć?'))return; await sb.from('places').delete().eq('id',editingPlaceId); closeModal('editor-modal'); loadPlaces(); });
$('editor-upload').addEventListener('change', async e => {
  const files = [...e.target.files]; if(!files.length) return;
  let d; try { d = JSON.parse($('editor-json').value); } catch { return; }
  if(!d.images) d.images = [];
  for (const f of files) {
    const path = `places/${Date.now()}-${f.name.replace(/[^\w.\-]+/g,'_')}`;
    const { error } = await sb.storage.from('place-images').upload(path, f);
    if(!error) { const { data } = sb.storage.from('place-images').getPublicUrl(path); d.images.push(data.publicUrl); }
  }
  $('editor-json').value = JSON.stringify(d, null, 2); e.target.value='';
});

function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s='') { return escapeHtml(s); }

// start
(async function start() {
  await checkSession();
  sb.auth.onAuthStateChange((_e, s) => { if(!s) show('auth'); });
})();