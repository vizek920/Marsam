(function () {
  // ---- Setup ------------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const roomId = (params.get('id') || '').toUpperCase();
  let username = sessionStorage.getItem('marsam_username');
  if (!username) {
    username = prompt('اسمك؟', 'ضيف') || 'ضيف';
    sessionStorage.setItem('marsam_username', username);
  }

  if (!roomId) {
    alert('كود الغرفة غير موجود');
    location.href = 'index.html';
    return;
  }

  let clientId = localStorage.getItem('marsam_client_id');
  if (!clientId) {
    clientId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('marsam_client_id', clientId);
  }

  const socket = io(window.MARSAM_BACKEND_URL, { transports: ['websocket', 'polling'] });

  const state = {
    me: null,
    isHost: false,
    users: {},         // socketId -> { username, color, canDraw, isHost }
    hiddenLayers: new Set(), // socketIds whose layer is hidden locally
    strokes: [],        // full stroke record list (fractional coords)
    kicked: {},          // clientId -> username, people the host has banned
    myGestureStack: [],  // my own gesture ids, for undo
    currentGestureId: null,
    tool: 'brush',
    color: '#EDEAE2',
    size: 6,
    drawing: false,
    lastPoint: null,
  };

  // ---- Canvas -------------------------------------------------------
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redrawAll();
  }
  window.addEventListener('resize', resizeCanvas);

  function toFrac(x, y) {
    const r = canvas.getBoundingClientRect();
    return { x: (x - r.left) / r.width, y: (y - r.top) / r.height };
  }
  function toPixels(fx, fy) {
    return { x: fx * canvas.clientWidth, y: fy * canvas.clientHeight };
  }

  function drawSegment(seg) {
    const a = toPixels(seg.x1, seg.y1);
    const b = toPixels(seg.x2, seg.y2);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = seg.size;
    if (seg.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = seg.color;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const seg of state.strokes) {
      if (state.hiddenLayers.has(seg.layerId)) continue;
      drawSegment(seg);
    }
  }

  // ---- Toolbar --------------------------------------------------------
  document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.tool = btn.dataset.tool;
    });
  });

  document.querySelectorAll('.swatch[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.swatch').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.color = btn.dataset.color;
    });
  });

  document.getElementById('custom-color').addEventListener('input', (e) => {
    document.querySelectorAll('.swatch').forEach((b) => b.classList.remove('active'));
    e.target.classList.add('active');
    state.color = e.target.value;
  });

  document.getElementById('brush-size').addEventListener('input', (e) => {
    state.size = Number(e.target.value);
  });

  // ---- Drawing input ----------------------------------------------------
  function canIDraw() { return !state.me || state.me.canDraw !== false; }

  function pointerDown(e) {
    if (!canIDraw()) return;
    state.drawing = true;
    state.movedDuringGesture = false;
    state.currentGestureId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.myGestureStack.push(state.currentGestureId);
    const p = e.touches ? e.touches[0] : e;
    state.lastPoint = toFrac(p.clientX, p.clientY);
  }

  function pointerMove(e) {
    const p = e.touches ? e.touches[0] : e;
    const frac = toFrac(p.clientX, p.clientY);
    broadcastCursor(frac);

    if (!state.drawing || !canIDraw()) return;
    e.preventDefault?.();
    state.movedDuringGesture = true;
    const seg = {
      id: state.currentGestureId,
      layerId: socket.id,
      tool: state.tool,
      color: state.color,
      size: state.size,
      x1: state.lastPoint.x, y1: state.lastPoint.y,
      x2: frac.x, y2: frac.y,
    };
    state.strokes.push(seg);
    if (!state.hiddenLayers.has(seg.layerId)) drawSegment(seg);
    socket.emit('stroke', seg);
    state.lastPoint = frac;
  }

  function pointerUp() {
    if (state.drawing && !state.movedDuringGesture && state.lastPoint && canIDraw()) {
      const seg = {
        id: state.currentGestureId,
        layerId: socket.id,
        tool: state.tool,
        color: state.color,
        size: state.size,
        x1: state.lastPoint.x, y1: state.lastPoint.y,
        x2: state.lastPoint.x, y2: state.lastPoint.y,
      };
      state.strokes.push(seg);
      if (!state.hiddenLayers.has(seg.layerId)) drawSegment(seg);
      socket.emit('stroke', seg);
    }
    state.drawing = false;
    state.lastPoint = null;
  }

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); pointerDown(e); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); pointerMove(e); }, { passive: false });
  canvas.addEventListener('touchend', pointerUp);

  // ---- Undo / clear -----------------------------------------------------
  document.getElementById('btn-undo').addEventListener('click', () => {
    const lastId = state.myGestureStack.pop();
    if (!lastId) return;
    state.strokes = state.strokes.filter((s) => s.id !== lastId);
    redrawAll();
    socket.emit('undo_stroke', { strokeId: lastId });
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('مسح كل رسمك من هذه الغرفة؟')) return;
    state.strokes = state.strokes.filter((s) => s.layerId !== socket.id);
    redrawAll();
    socket.emit('clear_layer', { layerId: socket.id });
  });

  socket.on('stroke_removed', ({ strokeId }) => {
    state.strokes = state.strokes.filter((s) => s.id !== strokeId);
    redrawAll();
  });
  socket.on('layer_cleared', ({ layerId }) => {
    state.strokes = state.strokes.filter((s) => s.layerId !== layerId);
    redrawAll();
  });

  // ---- Cursors ------------------------------------------------------
  let lastCursorEmit = 0;
  function broadcastCursor(frac) {
    const now = Date.now();
    if (now - lastCursorEmit < 40) return;
    lastCursorEmit = now;
    socket.emit('cursor_move', frac);
  }

  const cursorsLayer = document.getElementById('cursors-layer');
  const cursorEls = {};

  socket.on('cursor_move', ({ id, x, y }) => {
    const user = state.users[id];
    if (!user) return;
    let el = cursorEls[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = `<span class="dot" style="background:${user.color}"></span><span class="label" style="background:${user.color}">${escapeHtml(user.username)}</span>`;
      cursorsLayer.appendChild(el);
      cursorEls[id] = el;
    }
    const px = x * canvas.clientWidth;
    const py = y * canvas.clientHeight;
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
  });

  function removeCursor(id) {
    if (cursorEls[id]) { cursorEls[id].remove(); delete cursorEls[id]; }
  }

  // ---- Reactions ------------------------------------------------------
  const reactionsLayer = document.getElementById('reactions-layer');
  document.querySelectorAll('#reactions-picker button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const x = 0.5 + (Math.random() - 0.5) * 0.3;
      const y = 0.85;
      socket.emit('reaction', { emoji: btn.dataset.emoji, x, y });
    });
  });

  socket.on('reaction', ({ emoji, x, y }) => {
    const el = document.createElement('div');
    el.className = 'reaction-float';
    el.textContent = emoji;
    el.style.left = `${x * canvas.clientWidth}px`;
    el.style.top = `${y * canvas.clientHeight}px`;
    reactionsLayer.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  });

  // ---- Presence / people panel ------------------------------------------
  function renderPresence() {
    const stack = document.getElementById('presence-stack');
    const ids = Object.keys(state.users).slice(0, 5);
    stack.innerHTML = ids.map((id) => {
      const u = state.users[id];
      return `<span class="presence-avatar" style="background:${u.color}" title="${escapeHtml(u.username)}">${escapeHtml((u.username || '?')[0].toUpperCase())}</span>`;
    }).join('');
  }

  function renderPeoplePanel() {
    const body = document.getElementById('side-panel-body');
    const rows = Object.entries(state.users).map(([id, u]) => {
      const canManage = state.isHost && id !== socket.id;
      const controls = canManage ? `
          <span class="mini-toggle ${u.canDraw ? 'on' : ''}" data-action="toggle-draw" data-id="${id}" title="السماح/المنع من الرسم"><span class="dot"></span></span>
          <input type="number" class="mini-timer-input" min="5" max="600" value="30" data-id="${id}" title="ثواني الرسم" />
          <button class="mini-btn" data-action="timed-draw" data-id="${id}" title="أعطِه وقت رسم">⏱</button>
          <button class="mini-btn danger" data-action="kick" data-id="${id}" title="طرد">🚫</button>
        ` : `<span style="color:var(--text-muted);font-size:0.75rem;">${u.canDraw ? 'يرسم' : 'مشاهدة'}</span>`;

      return `
        <div class="panel-row" data-id="${id}">
          <span class="who">
            <span class="avatar-dot" style="background:${u.color}"></span>
            ${escapeHtml(u.username)} ${u.isHost ? '👑' : ''} ${id === socket.id ? '(أنت)' : ''}
          </span>
          <span class="row-controls">${controls}</span>
        </div>`;
    }).join('');

    const bannedRows = Object.entries(state.kicked || {}).map(([cid, uname]) => `
      <div class="panel-row" data-cid="${cid}">
        <span class="who">🚫 ${escapeHtml(uname)}</span>
        ${state.isHost ? `<button class="mini-btn" data-action="unban" data-cid="${cid}">السماح بالعودة</button>` : ''}
      </div>`).join('');

    const bannedSection = bannedRows ? `
      <div class="panel-section-title">مطرودون</div>
      ${bannedRows}` : '';

    body.innerHTML = (rows || '<p style="color:var(--text-muted)">لا يوجد أحد بعد</p>') + bannedSection;

    body.querySelectorAll('[data-action="toggle-draw"]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        socket.emit('set_permission', { targetId: id, canDraw: !state.users[id].canDraw });
      });
    });
    body.querySelectorAll('[data-action="timed-draw"]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        const input = body.querySelector(`.mini-timer-input[data-id="${id}"]`);
        const seconds = Math.max(5, Number(input.value) || 30);
        socket.emit('set_permission_timed', { targetId: id, seconds });
      });
    });
    body.querySelectorAll('[data-action="kick"]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (!confirm(`تأكيد طرد ${state.users[id]?.username || ''}؟`)) return;
        socket.emit('kick_user', { targetId: id });
      });
    });
    body.querySelectorAll('[data-action="unban"]').forEach((el) => {
      el.addEventListener('click', () => {
        socket.emit('unban_user', { clientId: el.dataset.cid });
      });
    });
  }

  function renderLayersPanel() {
    const body = document.getElementById('side-panel-body');
    const rows = Object.entries(state.users).map(([id, u]) => {
      const hidden = state.hiddenLayers.has(id);
      return `
        <div class="panel-row" data-id="${id}">
          <span class="who">
            <span class="avatar-dot" style="background:${u.color}"></span>
            طبقة ${escapeHtml(u.username)} ${id === socket.id ? '(أنت)' : ''}
          </span>
          <span class="mini-toggle ${!hidden ? 'on' : ''}" data-action="toggle-layer" data-id="${id}"><span class="dot"></span></span>
        </div>`;
    }).join('');
    body.innerHTML = rows || '<p style="color:var(--text-muted)">لا توجد طبقات بعد</p>';

    body.querySelectorAll('[data-action="toggle-layer"]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (state.hiddenLayers.has(id)) state.hiddenLayers.delete(id);
        else state.hiddenLayers.add(id);
        renderLayersPanel();
        redrawAll();
      });
    });
  }

  // ---- Side panel open/close ------------------------------------------
  const sidePanel = document.getElementById('side-panel');
  const sidePanelTitle = document.getElementById('side-panel-title');

  function openSidePanel(kind) {
    sidePanel.classList.remove('hidden');
    if (kind === 'people') { sidePanelTitle.textContent = 'المشاركون والصلاحيات'; renderPeoplePanel(); }
    else { sidePanelTitle.textContent = 'الطبقات'; renderLayersPanel(); }
  }
  document.getElementById('btn-people').addEventListener('click', () => openSidePanel('people'));
  document.getElementById('btn-layers').addEventListener('click', () => openSidePanel('layers'));
  document.getElementById('side-panel-close').addEventListener('click', () => sidePanel.classList.add('hidden'));

  // ---- Share modal --------------------------------------------------
  const shareModal = document.getElementById('share-modal');
  function openShareModal() {
    const link = `${location.origin}${location.pathname}?id=${roomId}`;
    document.getElementById('share-link-input').value = link;
    const holder = document.getElementById('qr-holder');
    holder.innerHTML = '';
    if (window.QRCode) new QRCode(holder, { text: link, width: 160, height: 160, colorDark: '#0B0C0E', colorLight: '#EDEAE2' });
    shareModal.classList.remove('hidden');
  }
  document.getElementById('btn-share').addEventListener('click', openShareModal);
  document.getElementById('room-code-btn').addEventListener('click', openShareModal);
  document.getElementById('close-share-modal').addEventListener('click', () => shareModal.classList.add('hidden'));
  document.getElementById('copy-link-btn').addEventListener('click', () => {
    const input = document.getElementById('share-link-input');
    input.select();
    navigator.clipboard?.writeText(input.value);
    const btn = document.getElementById('copy-link-btn');
    btn.textContent = 'تم!';
    setTimeout(() => { btn.textContent = 'نسخ'; }, 1500);
  });

  // ---- Replay modal ------------------------------------------------
  const replayModal = document.getElementById('replay-modal');
  document.getElementById('btn-replay').addEventListener('click', () => {
    replayModal.classList.remove('hidden');
    socket.emit('get_replay', (log) => { window.__replayLog = log; });
  });
  document.getElementById('close-replay-modal').addEventListener('click', () => replayModal.classList.add('hidden'));

  document.getElementById('replay-play-btn').addEventListener('click', () => {
    const log = window.__replayLog || [];
    const rc = document.getElementById('replay-canvas');
    const dpr = window.devicePixelRatio || 1;
    rc.width = rc.clientWidth * dpr;
    rc.height = rc.clientHeight * dpr;
    const rctx = rc.getContext('2d');
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.clearRect(0, 0, rc.clientWidth, rc.clientHeight);

    let i = 0;
    const totalDurationMs = 9000; // compress full history into ~9s
    const step = Math.max(1, Math.floor(log.length / (totalDurationMs / 16)));

    function drawFrame() {
      const end = Math.min(log.length, i + step);
      for (; i < end; i++) {
        const seg = log[i];
        const a = { x: seg.x1 * rc.clientWidth, y: seg.y1 * rc.clientHeight };
        const b = { x: seg.x2 * rc.clientWidth, y: seg.y2 * rc.clientHeight };
        rctx.save();
        rctx.lineCap = 'round'; rctx.lineJoin = 'round'; rctx.lineWidth = seg.size;
        if (seg.tool === 'eraser') { rctx.globalCompositeOperation = 'destination-out'; rctx.strokeStyle = 'rgba(0,0,0,1)'; }
        else { rctx.globalCompositeOperation = 'source-over'; rctx.strokeStyle = seg.color; }
        rctx.beginPath(); rctx.moveTo(a.x, a.y); rctx.lineTo(b.x, b.y); rctx.stroke(); rctx.restore();
      }
      if (i < log.length) requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);
  });

  // ---- Gallery publish ------------------------------------------------
  document.getElementById('btn-gallery').addEventListener('click', () => {
    if (!confirm('نشر لقطة من هذه اللوحة في المعرض العام؟ ستكون مرئية لأي زائر.')) return;
    const dataUrl = canvas.toDataURL('image/png');
    socket.emit('publish_to_gallery', { imageDataUrl: dataUrl });
    alert('تم النشر في المعرض 🎉');
  });

  // ---- Quick-draw challenge (host only control injected dynamically) ---
  const CHALLENGE_WORDS = ['قطة', 'شمس', 'جبل', 'سيارة', 'منزل', 'سمكة', 'قلعة', 'نجمة', 'شجرة', 'طائرة'];
  function injectChallengeButton() {
    if (document.getElementById('btn-challenge')) return;
    const btn = document.createElement('button');
    btn.id = 'btn-challenge';
    btn.className = 'icon-btn';
    btn.title = 'ابدأ تحدي رسم سريع';
    btn.textContent = '🎯';
    btn.addEventListener('click', () => {
      const word = CHALLENGE_WORDS[Math.floor(Math.random() * CHALLENGE_WORDS.length)];
      socket.emit('challenge_start', { word, seconds: 60 });
    });
    document.querySelector('.room-top-right').prepend(btn);
  }

  const challengeBanner = document.getElementById('challenge-banner');
  let challengeTimerInterval = null;
  socket.on('challenge_start', ({ word, seconds }) => {
    challengeBanner.classList.remove('hidden');
    document.getElementById('challenge-word').textContent = `ارسموا: ${word}`;
    let remaining = seconds;
    const timerEl = document.getElementById('challenge-timer');
    timerEl.textContent = `${remaining}s`;
    clearInterval(challengeTimerInterval);
    challengeTimerInterval = setInterval(() => {
      remaining--;
      timerEl.textContent = `${remaining}s`;
      if (remaining <= 0) {
        clearInterval(challengeTimerInterval);
        challengeBanner.classList.add('hidden');
      }
    }, 1000);
  });

  // ---- Permission changes -----------------------------------------------
  const viewOnlyBadge = document.getElementById('view-only-badge');
  const drawTimerBanner = document.getElementById('draw-timer-banner');
  const drawTimerName = document.getElementById('draw-timer-name');
  const drawTimerCountdown = document.getElementById('draw-timer-countdown');
  let permissionCountdownInterval = null;
  let drawBannerInterval = null;

  function showDrawTimerBanner(targetId, endsAt) {
    const uname = state.users[targetId]?.username || '—';
    drawTimerName.textContent = `🖌 ${uname} يرسم الآن`;
    drawTimerBanner.classList.remove('hidden');
    clearInterval(drawBannerInterval);
    drawBannerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      const mm = Math.floor(remaining / 60);
      const ss = String(remaining % 60).padStart(2, '0');
      drawTimerCountdown.textContent = `${mm}:${ss}`;
      if (remaining <= 0) {
        clearInterval(drawBannerInterval);
        drawTimerBanner.classList.add('hidden');
      }
    }, 250);
  }

  socket.on('permission_changed', ({ targetId, canDraw, endsAt }) => {
    if (state.users[targetId]) state.users[targetId].canDraw = canDraw;

    if (canDraw && endsAt) {
      showDrawTimerBanner(targetId, endsAt);
    } else if (!canDraw) {
      clearInterval(drawBannerInterval);
      drawTimerBanner.classList.add('hidden');
    }

    if (targetId === socket.id) {
      state.me.canDraw = canDraw;
      clearInterval(permissionCountdownInterval);
      if (canDraw) {
        viewOnlyBadge.classList.add('hidden');
      } else {
        viewOnlyBadge.textContent = '👁 وضع المشاهدة فقط';
        viewOnlyBadge.classList.remove('hidden');
      }
    }
    if (!sidePanel.classList.contains('hidden') && sidePanelTitle.textContent.includes('المشاركون')) renderPeoplePanel();
  });

  socket.on('host_changed', ({ newHostId }) => {
    Object.values(state.users).forEach((u) => { u.isHost = false; });
    if (state.users[newHostId]) state.users[newHostId].isHost = true;
    if (newHostId === socket.id) { state.isHost = true; injectChallengeButton(); }
    renderPresence();
  });

  // ---- Presence updates -----------------------------------------------
  socket.on('presence_update', ({ users }) => {
    state.users = users;
    renderPresence();
    if (!sidePanel.classList.contains('hidden')) {
      if (sidePanelTitle.textContent.includes('المشاركون')) renderPeoplePanel();
      else renderLayersPanel();
    }
  });

  socket.on('user_joined', (u) => {
    state.users[u.id] = u;
    renderPresence();
  });

  socket.on('user_left', ({ id }) => {
    delete state.users[id];
    removeCursor(id);
    renderPresence();
  });

  // ---- Incoming strokes from others -----------------------------------
  socket.on('stroke', (seg) => {
    state.strokes.push(seg);
    if (!state.hiddenLayers.has(seg.layerId)) drawSegment(seg);
  });

  // ---- Join room --------------------------------------------------------
  const waitingOverlay = document.getElementById('waiting-overlay');
  const joinRequestsEl = document.getElementById('join-requests');

  function applyJoinedState(res) {
    state.me = res.you;
    state.isHost = res.isHost;
    state.users = res.users;
    state.strokes = res.strokes || [];
    state.kicked = res.kicked || {};

    waitingOverlay.classList.add('hidden');
    document.getElementById('room-title').textContent = username ? `مرحبًا ${username}` : 'مرسم';
    document.getElementById('room-code-btn').textContent = roomId;

    resizeCanvas();
    renderPresence();
    if (state.isHost) injectChallengeButton();
    if (state.me.canDraw === false) viewOnlyBadge.classList.remove('hidden');
  }

  socket.on('connect', () => {
    socket.emit('join_room', { roomId, username, clientId }, (res) => {
      if (!res?.ok) {
        if (res?.error === 'kicked') {
          alert('تم طردك من هذه الغرفة من قبل المضيف. لا يمكنك الدخول حتى يسمح لك بالعودة.');
        } else {
          alert('ما قدرنا نلقى هذه الغرفة. تأكد من الكود.');
        }
        location.href = 'index.html';
        return;
      }
      if (res.pending) {
        waitingOverlay.classList.remove('hidden');
      }
      // Otherwise: full state arrives via the 'joined' event below.
    });
  });

  socket.on('joined', applyJoinedState);

  socket.on('join_rejected', () => {
    alert('المضيف ما وافق على انضمامك لهذه الغرفة.');
    location.href = 'index.html';
  });

  // ---- Host: incoming join requests (private rooms) ----
  const pendingRequestEls = {};
  socket.on('join_request', ({ requestId, username: reqName }) => {
    const card = document.createElement('div');
    card.className = 'join-request-card';
    card.innerHTML = `
      <span class="req-name">${escapeHtml(reqName)} يريد الانضمام</span>
      <span class="req-actions">
        <button class="req-btn accept" title="قبول">✓</button>
        <button class="req-btn reject" title="رفض">✕</button>
      </span>`;
    card.querySelector('.accept').addEventListener('click', () => {
      socket.emit('approve_join', { requestId });
      card.remove();
      delete pendingRequestEls[requestId];
    });
    card.querySelector('.reject').addEventListener('click', () => {
      socket.emit('reject_join', { requestId });
      card.remove();
      delete pendingRequestEls[requestId];
    });
    joinRequestsEl.appendChild(card);
    pendingRequestEls[requestId] = card;
  });

  socket.on('you_were_kicked', () => {
    alert('تم طردك من الغرفة من قبل المضيف.');
    location.href = 'index.html';
  });

  socket.on('ban_list_updated', ({ kicked }) => {
    state.kicked = kicked || {};
    if (!sidePanel.classList.contains('hidden') && sidePanelTitle.textContent.includes('المشاركون')) renderPeoplePanel();
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
