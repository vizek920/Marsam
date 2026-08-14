(function () {
  const socket = io(window.MARSAM_BACKEND_URL, { transports: ['websocket', 'polling'] });

  // ---- Tabs ----
  const tabs = document.querySelectorAll('.tab');
  const panels = { create: document.getElementById('panel-create'), join: document.getElementById('panel-join') };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      Object.entries(panels).forEach(([key, el]) => el.classList.toggle('hidden', key !== tab.dataset.tab));
    });
  });

  // ---- Create room ----
  document.getElementById('btn-create').addEventListener('click', () => {
    const username = document.getElementById('create-name').value.trim() || 'ضيف';
    const roomName = document.getElementById('room-name').value.trim();
    const isPublic = document.getElementById('is-public').checked;
    const btn = document.getElementById('btn-create');

    btn.disabled = true;
    btn.textContent = 'جاري الإنشاء...';

    socket.emit('create_room', { name: roomName, isPublic, username }, (res) => {
      btn.disabled = false;
      btn.textContent = 'أنشئ الغرفة';
      if (!res?.ok) return;
      sessionStorage.setItem('marsam_username', username);
      window.location.href = `room.html?id=${res.roomId}`;
    });
  });

  // ---- Join room ----
  document.getElementById('btn-join').addEventListener('click', () => {
    const username = document.getElementById('join-name').value.trim() || 'ضيف';
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const errorEl = document.getElementById('join-error');
    errorEl.textContent = '';

    if (!code) {
      errorEl.textContent = 'أدخل كود الغرفة أولاً';
      return;
    }
    sessionStorage.setItem('marsam_username', username);
    window.location.href = `room.html?id=${code}`;
  });

  document.getElementById('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  // ---- Public rooms list ----
  function renderRooms(rooms) {
    const grid = document.getElementById('public-room-grid');
    if (!rooms || rooms.length === 0) {
      grid.innerHTML = '<p class="empty-note">ما فيه غرف عامة مفتوحة حاليًا — كن أول من يفتح واحدة.</p>';
      return;
    }
    grid.innerHTML = rooms.map((r) => `
      <div class="room-card" data-id="${r.id}">
        <h3>${escapeHtml(r.name)}</h3>
        <p>${r.userCount} ${r.userCount === 1 ? 'شخص' : 'أشخاص'} يرسمون الآن</p>
      </div>
    `).join('');

    grid.querySelectorAll('.room-card').forEach((card) => {
      card.addEventListener('click', () => {
        window.location.href = `room.html?id=${card.dataset.id}`;
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  socket.on('public_rooms', renderRooms);
  socket.on('connect', () => {
    fetch(`${window.MARSAM_BACKEND_URL}/api/rooms/public`).then((r) => r.json()).then(renderRooms).catch(() => {});
  });
})();
