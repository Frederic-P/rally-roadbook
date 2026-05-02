class App {
  constructor() {
    this.appVersion = '0.0.0'; 
    this.FALLBACK = [43.7394, 7.4275];

    this.routeManager  = new RouteManager(document.getElementById('map'), this.FALLBACK);
    this.wpManager     = new WaypointManager();
    this.editorUI      = new WaypointEditorUI(this.wpManager);
    this.exportManager = new ExportManager(this.wpManager, this.routeManager);

    this._routeWindow = new RouteWindowManager(this.routeManager.map, () => {});
    this.editorUI.setRouteWindowManager(this._routeWindow);

    this._stencilMgr = new StencilManager(this.routeManager.map);
    this.editorUI.setStencilManager(this._stencilMgr);

    this.viaPoints    = [];
    this.viaEditor    = new ViaEditorPanel();
    this.liveRecalc   = true;
    this.startLabel = '';
    this.endLabel   = '';

    // Via section expand/collapse state
    this._viaExpanded = false;

    // Drag-to-reorder state
    this._dragSrcIdx = null;

    this._markerClickFn = (clickedWP) => {
      const idx = this.wpManager.waypoints.indexOf(clickedWP);
      if (idx !== -1) this._openWaypoint(idx);
    };

    this._markerRightClickFn = (clickedWP, event) => {
      this._showWaypointContextMenu(clickedWP, event.latlng);
    };

    this.routeManager.onRouteLineDblClick  = (latlng) => this._onRouteLineDblClick(latlng);
    this.routeManager.onRouteLineRightClick = (latlng) => this._onRouteLineDblClick(latlng);
    this.routeManager.onViaDragEnd         = (latlng) => this._onViaDragEnd(latlng);

    window.routeManager = this.routeManager;
    window.app = this;

    this._bindUI();
    this._loadFromStorage();
  }

  /* ============================================================
     UI BINDINGS
     ============================================================ */
  _bindUI() {
    // Start / End keyboard submit
    ['input-start', 'input-end'].forEach(id => {
      document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter') this._calcRoute();
      });
    });

    // Start / End map-pick
    document.getElementById('btn-pick-start').addEventListener('click', () => {
      this.routeManager.startPickMode('start', async (mode, latlng) => {
        const label = await this.routeManager.reverseGeocode(latlng);
        document.getElementById('input-start').value = label;
        this.routeManager.startPoint = latlng;
        this.startLabel = label;
      });
    });

    document.getElementById('btn-pick-end').addEventListener('click', () => {
      this.routeManager.startPickMode('end', async (mode, latlng) => {
        const label = await this.routeManager.reverseGeocode(latlng);
        document.getElementById('input-end').value = label;
        this.routeManager.endPoint = latlng;
        this.endLabel = label;
      });
    });

    document.getElementById('btn-calc-route').addEventListener('click', () => this._calcRoute());

    // Live-recalc toggle
    document.getElementById('live-recalc').addEventListener('change', (e) => {
      this.liveRecalc = e.target.checked;
    });

    // Via section expand/collapse
    document.getElementById('via-toggle').addEventListener('click', () => {
      this._viaExpanded = !this._viaExpanded;
      document.getElementById('via-body').classList.toggle('hidden', !this._viaExpanded);
      document.getElementById('via-toggle-arrow').textContent = this._viaExpanded ? '▼' : '▶';
    });

    // Add via by address — show input row
    document.getElementById('btn-add-via-address').addEventListener('click', () => {
      this._expandVia();
      document.getElementById('via-add-row').classList.remove('hidden');
      document.getElementById('via-address-input').focus();
    });

    // Add via by map pick — sticky mode, stays armed until Escape or Done
    document.getElementById('btn-add-via-map').addEventListener('click', () => {
      this._expandVia();
      this._startStickyViaPick();
    });

    // Confirm address via
    document.getElementById('btn-via-address-confirm').addEventListener('click', () => {
      this._commitViaAddress();
    });
    document.getElementById('via-address-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._commitViaAddress();
      if (e.key === 'Escape') this._cancelViaAddress();
    });
    document.getElementById('btn-via-address-cancel').addEventListener('click', () => {
      this._cancelViaAddress();
    });

    // Optimize via order
    document.getElementById('btn-optimize-via').addEventListener('click', async () => {
      if (this.viaPoints.length < 2) return;
      this._showLoading('Optimizing via order…');
      try {
        const start = this.routeManager.startPoint;
        if (!start || !this.routeManager.routeCoords) {
          await Modal.alert('Need route first.');
          return;
        }
        this.viaPoints.sort((a, b) => {
          const da = this.routeManager.map.distance(start, a.latlng);
          const db = this.routeManager.map.distance(start, b.latlng);
          return da - db;
        });
        this._renderViaList();
        await this._calcRoute();
      } finally {
        this._hideLoading();
      }
    });

    // New Route
    document.getElementById('btn-new-route').addEventListener('click', async () => {
      if (await Modal.confirm('Start a new route? All unsaved data will be cleared.')) this._clearAll();
    });

    // Export / Import
    document.getElementById('btn-save-zip').addEventListener('click', async () => {
      if (!this.wpManager.getAll().length) { await Modal.alert('No route yet.'); return; }
      this._showLoading('Generating ZIP…');
      this.exportManager.exportZIP().finally(() => this._hideLoading());
    });

    document.getElementById('btn-load-zip').addEventListener('click', () => {
      document.getElementById('input-load-zip').click();
    });
    document.getElementById('input-load-zip').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      this._showLoading('Loading roadbook…');
      this.exportManager.importZIP(file)
        .then(({ routeData, wpData }) => this._restoreFromData(routeData, wpData))
        .catch(err => Modal.alert('Error loading ZIP: ' + err.message))
        .finally(() => this._hideLoading());
      e.target.value = '';
    });

    document.getElementById('btn-export-pdf').addEventListener('click', async () => {
      if (!this.wpManager.getAll().length) { await Modal.alert('No waypoints yet.'); return; }
      this._showLoading('Generating PDF…');
      this.exportManager.exportPDF().finally(() => this._hideLoading());
    });

    document.getElementById('btn-export-gpx').addEventListener('click', async () => {
      if (!this.wpManager.getAll().length) { await Modal.alert('No waypoints yet.'); return; }
      this._showLoading('Generating GPX…');
      this.exportManager.exportGPX().finally(() => this._hideLoading());
    });

    // Delete button in editor
    document.getElementById('btn-delete-wp').addEventListener('click', async () => {
      if (this.wpManager.currentIndex === null) return;
      const wp = this.wpManager.waypoints[this.wpManager.currentIndex];
      if (await Modal.confirm('Permanently delete this waypoint?')) {
        this._deleteWaypoint(wp);
      }
    });
  }

  /* ============================================================
     VIA ADDRESS INPUT HELPERS
     ============================================================ */
  _startStickyViaPick() {
    // Update indicator text to show Done button
    const indicator = document.getElementById('map-mode-indicator');
    indicator.innerHTML = `
      Adding via points — click map to place &nbsp;
      <button id="btn-via-pick-done" style="
        background:#f5a623;color:#1a1a2e;border:none;border-radius:4px;
        padding:3px 10px;font-weight:700;font-size:12px;cursor:pointer;margin-left:4px;
      ">Done</button>
    `;
    indicator.classList.remove('hidden');

    document.getElementById('btn-via-pick-done').addEventListener('click', () => {
      this.routeManager.stopPickMode();
      indicator.innerHTML = 'Click on map to set point';
    });

    // Escape key also exits
    const onKey = (e) => {
      if (e.key === 'Escape') {
        this.routeManager.stopPickMode();
        indicator.innerHTML = 'Click on map to set point';
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    this.routeManager.startPickMode('via-sticky', async (mode, latlng) => {
      const label = await this.routeManager.reverseGeocode(latlng);
      await this._addViaPoint(latlng, label, false); // no auto-recalc per click
    });
  }

  _expandVia() {
    if (!this._viaExpanded) {
      this._viaExpanded = true;
      document.getElementById('via-body').classList.remove('hidden');
      document.getElementById('via-toggle-arrow').textContent = '▼';
    }
  }

  async _commitViaAddress() {
    const input = document.getElementById('via-address-input');
    const query = input.value.trim();
    if (!query) return;
    this._showLoading('Geocoding via point…');
    try {
      const latlng = await this.routeManager.geocode(query);
      await this._addViaPoint(latlng, query, this.liveRecalc);
      input.value = '';
      document.getElementById('via-add-row').classList.add('hidden');
    } catch (err) {
      await Modal.alert('Address not found: ' + (err.message || err));
    } finally {
      this._hideLoading();
    }
  }

  _cancelViaAddress() {
    document.getElementById('via-address-input').value = '';
    document.getElementById('via-add-row').classList.add('hidden');
  }

  /* ============================================================
     DOUBLE-CLICK ON ROUTE LINE -> add manual waypoint
     ============================================================ */
  async _onRouteLineDblClick(latlng) {
    const coords     = this.routeManager.routeCoords;
    const nearIdx    = this.routeManager._nearestCoordIdx(latlng);
    const snapLatlng = coords[nearIdx] || latlng;

    const prevIdx    = Math.max(0, nearIdx - 4);
    const nextIdx    = Math.min(coords.length - 1, nearIdx + 4);
    const inBearing  = this.routeManager._bearingBetween(coords[prevIdx], snapLatlng);
    const exitBearing = this.routeManager._bearingBetween(snapLatlng, coords[nextIdx]);

    const distToHere = this._estimateDistToCoord(nearIdx);
    let insertAt = this.wpManager.waypoints.findIndex(wp => wp.distTotal > distToHere);
    if (insertAt === -1) insertAt = this.wpManager.waypoints.length;

    const stepData = {
      latlng:       snapLatlng,
      type:         'straight',
      instruction:  'Added waypoint',
      bearing:      exitBearing,
      inBearing,
      distAB:       0,
      distFromPrev: 0,
      distTotal:    distToHere,
      nearCoords: {
        before: coords.slice(Math.max(0, nearIdx - 12), nearIdx),
        after:  coords.slice(nearIdx + 1, Math.min(coords.length, nearIdx + 13))
      }
    };

    const wp = this.wpManager.createFromStep(stepData, insertAt);
    this.wpManager.waypoints.splice(insertAt, 0, wp);
    this.wpManager._reindex();

    this.routeManager.placeWaypointMarker(wp, this._markerClickFn, this._markerRightClickFn);

    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
  }

  _estimateDistToCoord(coordIdx) {
    let d = 0;
    const coords = this.routeManager.routeCoords;
    for (let i = 1; i <= coordIdx && i < coords.length; i++) {
      d += this.routeManager.map.distance(coords[i - 1], coords[i]);
    }
    return d;
  }

  /* ============================================================
     VIA POINTS
     ============================================================ */
  async _onViaDragEnd(latlng) {
    // Route-line drag creates a temporary via — add with recalc
    const label = await this.routeManager.reverseGeocode(latlng);
    await this._addViaPoint(latlng, label, true);
  }

  /**
   * Add a via point.
   * @param {L.LatLng} latlng
   * @param {string}   label       — display label (address string)
   * @param {boolean}  doRecalc    — whether to immediately recalculate the route
   */
  async _addViaPoint(latlng, label, doRecalc = false) {
    // Determine insertion index by projected distance from start
    let projectedDist = Infinity;
    if (this.routeManager.routeCoords && this.routeManager.routeCoords.length > 1) {
      const nearIdx = this._nearestCoordIdxForLatLng(latlng);
      projectedDist = this._estimateDistToCoord(nearIdx);
    }

    const insertIdx = this.viaPoints.findIndex(v => {
      const nearIdx = this._nearestCoordIdxForLatLng(v.latlng);
      const vDist   = this._estimateDistToCoord(nearIdx);
      return projectedDist < vDist;
    });
    const idx = insertIdx === -1 ? this.viaPoints.length : insertIdx;

    const marker = this._createViaMarker(latlng, idx + 1);

    marker.on('dragend', async () => {
      const i = this.viaPoints.findIndex(v => v.marker === marker);
      if (i !== -1) {
        this.viaPoints[i].latlng = marker.getLatLng();
        this._renumberViaMarkers();
        this._renderViaList();
        if (this.liveRecalc) await this._calcRoute();
      }
    });

    marker.on('contextmenu', async () => {
      const i = this.viaPoints.findIndex(v => v.marker === marker);
      if (i !== -1) {
        this.routeManager.map.removeLayer(marker);
        this.viaPoints.splice(i, 1);
        this._renumberViaMarkers();
        this._renderViaList();
        this._updateViaBadge();
        if (this.liveRecalc) await this._calcRoute();
      }
    });

    this.viaPoints.splice(idx, 0, { latlng, label, marker, note: '', includeInPDF: false });
    this._renumberViaMarkers();
    this._renderViaList();
    this._updateViaBadge();

    if (doRecalc && this.liveRecalc) {
      await this._calcRoute();
    }
  }

  _nearestCoordIdxForLatLng(latlng) {
    if (!this.routeManager.routeCoords || !this.routeManager.routeCoords.length) return 0;
    const coords = this.routeManager.routeCoords;
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < coords.length; i++) {
      const d = this.routeManager.map.distance(latlng, coords[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /**
   * Create a numbered circle marker for a via point.
   */
  _createViaMarker(latlng, num) {
    const icon = this._viaIcon(num);
    const marker = L.marker(latlng, { icon, draggable: true, zIndexOffset: 300 })
      .addTo(this.routeManager.map);
    return marker;
  }

  _viaIcon(num) {
    return L.divIcon({
      className: 'via-number-icon',
      html: `<div style="width:22px;height:22px;border-radius:50%;background:#1e3a8a;color:#fff;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:12px;font-family:'Barlow Condensed',sans-serif;letter-spacing:0.5px;">${num}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11]
    });
  }

  /** Update all via markers' icons so their numbers stay in sync with array order */
  _renumberViaMarkers() {
    this.viaPoints.forEach((v, i) => {
      if (v.marker) {
        v.marker.setIcon(this._viaIcon(i + 1));
      }
    });
  }

  /** Update the count badge on the "Via Points" toggle button */
  _updateViaBadge() {
    const badge = document.getElementById('via-count-badge');
    const count = this.viaPoints.length;
    if (count > 0) {
      badge.textContent = count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  /* ============================================================
     RENDER VIA LIST (sortable by drag-handle)
     ============================================================ */
  _renderViaList() {
    const list = document.getElementById('via-points-list');
    list.innerHTML = '';
    this._updateViaBadge();

    this.viaPoints.forEach((v, i) => {
      const item = document.createElement('div');
      item.className = 'via-item';
      item.draggable = true;
      item.dataset.idx = i;

      // ── Numbered badge — click to pan map ──
      const badge = document.createElement('div');
      badge.className = 'via-num-badge';
      badge.textContent = i + 1;
      badge.title = 'Click to centre map here';
      badge.style.cursor = 'pointer';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        this.routeManager.map.setView(v.latlng, 16, { animate: true });
      });

      // ── Drag handle ──
      const handle = document.createElement('span');
      handle.className = 'via-drag-handle';
      handle.title = 'Drag to reorder';
      handle.innerHTML = '⠿';

      // ── Editable label ──
      const labelContainer = document.createElement('div');
      labelContainer.className = 'via-label-container';
      labelContainer.style.flex = '1';

      const span = document.createElement('span');
      span.contentEditable = true;
      const displayLabel = v.label.length > 30 ? v.label.substring(0, 30) + '…' : v.label;
      span.textContent = displayLabel;
      span.title = v.label;
      span.addEventListener('blur', () => {
        const newLabel = span.textContent.trim() || `Via ${i + 1}`;
        v.label = newLabel;
        span.title = newLabel;
        this._saveToStorage();
      });
      span.addEventListener('keydown', e => {
        if (e.key === 'Enter') { span.blur(); e.preventDefault(); }
      });
      labelContainer.appendChild(span);

      // ── PDF indicator dot (shown when includeInPDF is true) ──
      const pdfDot = document.createElement('span');
      pdfDot.title = 'Included in PDF';
      pdfDot.style.cssText = [
        'width:7px', 'height:7px', 'border-radius:50%',
        'background:var(--accent,#f5a623)', 'flex-shrink:0',
        'display:inline-block', 'margin-left:4px',
        v.includeInPDF ? '' : 'visibility:hidden'
      ].join(';');
      pdfDot.id = `via-pdf-dot-${i}`;

      // ── Edit button — opens ViaEditorPanel ──
      const editBtn = document.createElement('button');
      editBtn.className = 'via-edit-btn';
      editBtn.title = 'Edit note & PDF options';
      editBtn.innerHTML = '✎';
      editBtn.style.cssText = [
        'background:none', 'border:1px solid var(--border,#2a3048)',
        'color:var(--text-muted,#8888aa)', 'border-radius:4px',
        'padding:2px 6px', 'font-size:13px', 'cursor:pointer',
        'line-height:1.4', 'flex-shrink:0',
        'transition:color 0.15s, border-color 0.15s'
      ].join(';');
      editBtn.addEventListener('mouseenter', () => {
        editBtn.style.color = 'var(--accent,#f5a623)';
        editBtn.style.borderColor = 'var(--accent,#f5a623)';
      });
      editBtn.addEventListener('mouseleave', () => {
        editBtn.style.color = 'var(--text-muted,#8888aa)';
        editBtn.style.borderColor = 'var(--border,#2a3048)';
      });
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.viaEditor.open(v, i + 1, () => {
          // Update the PDF dot visibility whenever the panel saves
          const dot = document.getElementById(`via-pdf-dot-${i}`);
          if (dot) dot.style.visibility = v.includeInPDF ? 'visible' : 'hidden';
          this._saveToStorage();
        });
      });

      // ── Remove button ──
      const removeBtn = document.createElement('button');
      removeBtn.className = 'via-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', async () => {
        if (v.marker) this.routeManager.map.removeLayer(v.marker);
        this.viaPoints.splice(i, 1);
        this._renumberViaMarkers();
        this._renderViaList();
        if (this.liveRecalc) await this._calcRoute();
      });

      item.appendChild(badge);
      item.appendChild(handle);
      item.appendChild(labelContainer);
      item.appendChild(pdfDot);
      item.appendChild(editBtn);
      item.appendChild(removeBtn);

      // ── Drag-to-reorder events ──
      item.addEventListener('dragstart', e => {
        this._dragSrcIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('via-dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('via-dragging');
        list.querySelectorAll('.via-item').forEach(el => el.classList.remove('via-drag-over'));
      });
      item.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.via-item').forEach(el => el.classList.remove('via-drag-over'));
        item.classList.add('via-drag-over');
      });
      item.addEventListener('drop', async e => {
        e.preventDefault();
        item.classList.remove('via-drag-over');
        const srcIdx = this._dragSrcIdx;
        const dstIdx = parseInt(item.dataset.idx, 10);
        if (srcIdx === null || srcIdx === dstIdx) return;

        const [moved] = this.viaPoints.splice(srcIdx, 1);
        this.viaPoints.splice(dstIdx, 0, moved);
        this._dragSrcIdx = null;

        this._renumberViaMarkers();
        this._renderViaList();
        if (this.liveRecalc) await this._calcRoute();
        else this._saveToStorage();
      });

      list.appendChild(item);
    });
  }

  /* ============================================================
     OPEN WAYPOINT EDITOR
     ============================================================ */
  _openWaypoint(index) { this.editorUI.open(index); }

  /* ============================================================
     ROUTE CALCULATION
     ============================================================ */
  async _calcRoute() {
    let start      = this.routeManager.startPoint;
    let end        = this.routeManager.endPoint;
    const startInput = document.getElementById('input-start').value.trim();
    const endInput   = document.getElementById('input-end').value.trim();

    if (!start && !startInput) { await Modal.alert('Please set a start point.'); return; }
    if (!end   && !endInput)   { await Modal.alert('Please set an end point.');   return; }

    this._showLoading('Calculating route…');

    try {
      if (!start && startInput) {
        start = await this.routeManager.geocode(startInput);
        this.routeManager.startPoint = start;
        this.startLabel = startInput;
      }
      if (!end && endInput) {
        end = await this.routeManager.geocode(endInput);
        this.routeManager.endPoint = end;
        this.endLabel = endInput;
      }

      const viaLatLngs = this.viaPoints.map(v => v.latlng);

      const existingWPs = this.wpManager.serialize();
      this.wpManager.waypoints = [];

      const steps = await this.routeManager.calculateRoute(start, end, viaLatLngs);

      // Filter out trivial steps that sit on via-points (no nav action needed)
      const filteredSteps = steps.filter(s => !s.isViaPassthrough);

      filteredSteps.forEach((s, i) => {
        const wp    = this.wpManager.createFromStep(s, i);
        const match = existingWPs.find(e =>
          e.latlng && wp.latlng &&
          Math.abs(e.latlng.lat - wp.latlng.lat) < 0.0002 &&
          Math.abs(e.latlng.lng - wp.latlng.lng) < 0.0002 &&
          Math.abs((e.distTotal || 0) - (wp.distTotal || 0)) < 50
        );
        if (match) {
          wp.comment           = match.comment;
          wp.svgState          = match.svgState;
          wp.routeWindowBounds = match.routeWindowBounds || null;
        }
        this.wpManager.addWaypoint(wp);
      });

      this.routeManager.restoreWaypointMarkers(
        this.wpManager.getAll(),
        this._markerClickFn,
        this._markerRightClickFn
      );

      this.routeManager.fitRoute();
      this.refreshWaypointList();
      this._updateStats();
      this._saveToStorage();

    } catch (err) {
      console.error(err);
      await Modal.alert('Route error: ' + (err.message || err));
    } finally {
      this._hideLoading();
    }
  }

  /* ============================================================
     WAYPOINT LIST
     ============================================================ */
  refreshWaypointList() {
    const list  = document.getElementById('waypoints-list');
    const count = document.getElementById('wp-count');
    const wps   = this.wpManager.getAll();
    count.textContent = wps.length;
    list.innerHTML = '';

    wps.forEach((wp, i) => {
      const item = document.createElement('div');
      item.className = `wp-list-item${wp.comment || wp.svgState ? ' has-comment' : ''}`;
      item.innerHTML = `
        <div class="wp-dot-mini"></div>
        <span class="wp-list-label">${i + 1}. ${wp.instruction || wp.type}</span>
        <span class="wp-list-dist">${this.wpManager.formatDistance(wp.distTotal)}</span>
      `;
      item.addEventListener('click', () => this._openWaypoint(i));
      list.appendChild(item);
    });
  }

  _updateStats() {
    document.getElementById('stat-distance').textContent =
      this.wpManager.formatDistance(this.routeManager.totalDistance());
    document.getElementById('stat-wps').textContent = this.wpManager.getAll().length;
  }

  /* Icon gallery */
  showIconProps(props) { this.editorUI.showIconProps(props); }
  hideIconProps()      { this.editorUI.hideIconProps(); }

  /* ============================================================
     WAYPOINT CONTEXT MENU (right-click on marker)
     ============================================================ */
  _showWaypointContextMenu(wp, latlng) {
    const container = document.createElement('div');
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.cssText = 'background:#e74c3c;color:#fff;border:none;padding:6px 12px;cursor:pointer;width:100%;font-size:13px;border-radius:4px;';
    btn.textContent = 'Delete Waypoint';
    btn.onclick = async () => {
      this.routeManager.map.closePopup();
      if (await Modal.confirm('Delete this waypoint?')) this._deleteWaypoint(wp);
    };
    container.appendChild(btn);

    L.popup({ offset: [0, -4] })
      .setLatLng(latlng)
      .setContent(container)
      .openOn(this.routeManager.map);
  }

  _deleteWaypoint(wp) {
    if (this.editorUI._currentWp === wp) this.editorUI.close();
    this.wpManager.removeWaypoint(wp.id);
    this.routeManager.restoreWaypointMarkers(this.wpManager.getAll(), this._markerClickFn, this._markerRightClickFn);
    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
  }

  /* ============================================================
     CLEAR ALL
     ============================================================ */
  _clearAll() {
    this.viaPoints.forEach(v => { if (v.marker) this.routeManager.map.removeLayer(v.marker); });
    this.viaPoints = [];

    document.getElementById('live-recalc').checked = true;
    this.liveRecalc = true;

    this.wpManager.waypoints.forEach(wp => {
      (wp.stencilPaths || []).forEach(sp => {
        if (sp.mapLine) this.routeManager.map.removeLayer(sp.mapLine);
      });
    });

    this.routeManager.clearRoute();
    this.wpManager.waypoints = [];
    this.startLabel = '';
    this.endLabel   = '';
    document.getElementById('input-start').value = '';
    document.getElementById('input-end').value   = '';
    this._renderViaList();
    this.refreshWaypointList();
    this._updateStats();
    this._saveToStorage();
    if (this.editorUI) this.editorUI.close();
    this.wpManager.currentIndex = null;

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos  => this.routeManager.map.setView([pos.coords.latitude, pos.coords.longitude], 13, { animate: true }),
        _err => this.routeManager.map.setView(this.FALLBACK, 13, { animate: true }),
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    } else {
      this.routeManager.map.setView(this.FALLBACK, 13, { animate: true });
    }
  }

  /* ============================================================
     PERSISTENCE
     ============================================================ */
  _saveToStorage() {
    try {
      localStorage.setItem('rally-roadbook-save', JSON.stringify({
        route:      this.routeManager.serialize(),
        waypoints:  this.wpManager.serialize(),
        via:        this.viaPoints.map(v => ({ lat: v.latlng.lat, lng: v.latlng.lng, label: v.label, note: v.note || '', includeInPDF: v.includeInPDF || false })),
        startLabel: this.startLabel,
        endLabel:   this.endLabel
      }));
    } catch (e) { console.warn('localStorage save failed:', e); }
  }

  async _loadFromStorage() {
    try {
      const raw = localStorage.getItem('rally-roadbook-save');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.waypoints && data.waypoints.length > 0) {
        if (await Modal.confirm(`Restore saved route with ${data.waypoints.length} waypoints?`)) {
          this._restoreFromData(data.route, data.waypoints, data.via, data.startLabel, data.endLabel);
        }
      }
    } catch (e) { console.warn('localStorage load failed:', e); }
  }

  async _restoreFromData(routeData, wpData, via = [], startLabel = '', endLabel = '') {
    this._showLoading('Restoring route…');
    try {
      if (startLabel) { document.getElementById('input-start').value = startLabel; this.startLabel = startLabel; }
      if (endLabel)   { document.getElementById('input-end').value   = endLabel;   this.endLabel   = endLabel;   }

      // Remove existing via markers
      this.viaPoints.forEach(v => { if (v.marker) this.routeManager.map.removeLayer(v.marker); });
      this.viaPoints = [];

      // Restore via points with numbered markers
      for (let i = 0; i < (via || []).length; i++) {
        const v = via[i];
        const latlng = L.latLng(v.lat, v.lng);
        const marker = this._createViaMarker(latlng, i + 1);

        marker.on('dragend', async () => {
          const idx = this.viaPoints.findIndex(vp => vp.marker === marker);
          if (idx !== -1) {
            this.viaPoints[idx].latlng = marker.getLatLng();
            this._renumberViaMarkers();
            this._renderViaList();
            if (this.liveRecalc) await this._calcRoute();
          }
        });

        marker.on('contextmenu', async () => {
          const idx = this.viaPoints.findIndex(vp => vp.marker === marker);
          if (idx !== -1) {
            this.routeManager.map.removeLayer(marker);
            this.viaPoints.splice(idx, 1);
            this._renumberViaMarkers();
            this._renderViaList();
            this._updateViaBadge();
            if (this.liveRecalc) await this._calcRoute();
          }
        });

        this.viaPoints.push({ latlng, label: v.label || `Via ${i + 1}`, marker, note: v.note || '', includeInPDF: v.includeInPDF || false });
      }
      this._renderViaList();

      // Auto-expand via section if there are via points
      if (this.viaPoints.length > 0) {
        this._viaExpanded = true;
        document.getElementById('via-body').classList.remove('hidden');
        document.getElementById('via-toggle-arrow').textContent = '▼';
      }

      this.wpManager.deserialize(wpData);

      if (routeData && routeData.start && routeData.end) {
        this.routeManager.startPoint = L.latLng(routeData.start.lat, routeData.start.lng);
        this.routeManager.endPoint   = L.latLng(routeData.end.lat,   routeData.end.lng);
      }

      this.routeManager.restoreWaypointMarkers(
        this.wpManager.getAll(),
        this._markerClickFn,
        this._markerRightClickFn
      );

      if (this.routeManager.startPoint && this.routeManager.endPoint) {
        try {
          const viaLatLngs = this.viaPoints.map(v => v.latlng);
          await this.routeManager.calculateRoute(
            this.routeManager.startPoint,
            this.routeManager.endPoint,
            viaLatLngs
          );
          this.routeManager.fitRoute();
        } catch (e) { console.warn('Route recalc failed:', e); }
      }

      this.refreshWaypointList();
      this._updateStats();
    } finally {
      this._hideLoading();
    }
  }

  /* ============================================================
     LOADING OVERLAY
     ============================================================ */
  _showLoading(msg = 'Loading…') {
    let el = document.getElementById('loading-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'loading-overlay';
      el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
      el.innerHTML = `<div style="background:#1f2535;border:1px solid #2a3048;border-radius:10px;padding:22px 36px;color:#f5a623;font-family:'Barlow Condensed',sans-serif;font-size:17px;font-weight:700;letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;gap:14px;">
        <svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="9" stroke="#f5a623" stroke-width="2.5" fill="none" stroke-dasharray="28 8"><animateTransform attributeName="transform" type="rotate" from="0 11 11" to="360 11 11" dur="0.75s" repeatCount="indefinite"/></circle></svg>
        <span id="loading-msg">${msg}</span>
      </div>`;
      document.body.appendChild(el);
    } else {
      document.getElementById('loading-msg').textContent = msg;
      el.style.display = 'flex';
    }
  }

  _hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', () => { window.appInstance = new App(); });