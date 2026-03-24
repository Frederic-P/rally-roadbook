/**
 * svg-editor.js
 *
 * Bolletje-pijltje concept:
 * - The route-window rectangle on the map defines EXACTLY what is drawn
 * - Real route coordinates inside that rectangle are projected onto the SVG
 * - The entry (bolletje) is ALWAYS at the south edge (6 o'clock) of the illustration
 * - X and Y scales are independent — the full 300×300 is always filled
 * - Stencil paths (user-traced map roads) are drawn as dark-grey lines
 */

class SVGEditor {
  constructor(svgEl) {
    this.svg        = svgEl;
    this.baseLayer  = svgEl.querySelector('#svg-base-layer');
    this.drawLayer  = svgEl.querySelector('#svg-draw-layer');
    this.iconLayer  = svgEl.querySelector('#svg-icon-layer');

    this.currentTool        = 'select';
    this.currentColor       = '#222244';
    this.currentStrokeWidth = 2;

    this.isDrawing  = false;
    this.startPt    = null;
    this.tempEl     = null;

    this.undoStack = [];
    this.redoStack = [];

    this.selectedIcon   = null;
    this.draggingIcon   = false;
    this.iconDragOffset = { x: 0, y: 0 };

    this._bindEvents();
  }

  /* ======================================================
     EVENTS
     ====================================================== */
  _bindEvents() {
    this.svg.addEventListener('mousedown', e => this._onMouseDown(e));
    this.svg.addEventListener('mousemove', e => this._onMouseMove(e));
    this.svg.addEventListener('mouseup',   e => this._onMouseUp(e));
    this.svg.addEventListener('click',     e => this._onClick(e));
    document.addEventListener('mouseup', () => {
      this.isDrawing    = false;
      this.draggingIcon = false;
    });
  }

  _getSVGPoint(e) {
    const rect = this.svg.getBoundingClientRect();
    const vb   = this.svg.viewBox.baseVal;
    return {
      x: (e.clientX - rect.left) / rect.width  * vb.width,
      y: (e.clientY - rect.top)  / rect.height * vb.height
    };
  }

  /* ======================================================
     MOUSE HANDLERS
     ====================================================== */
  _onMouseDown(e) {
    if (e.button !== 0) return;
    const pt = this._getSVGPoint(e);

    if (this.currentTool === 'select') {
      const hit = this._hitTestIcon(pt);
      if (hit) {
        this.draggingIcon   = true;
        this.selectedIcon   = hit;
        this.iconDragOffset = {
          x: pt.x - parseFloat(hit.dataset.cx || 150),
          y: pt.y - parseFloat(hit.dataset.cy || 150)
        };
        this._onIconSelected(hit);
      }
      return;
    }
    if (this.currentTool === 'text') return;

    this.isDrawing = true;
    this.startPt = pt;
    if (this.currentTool === 'line') {
      this.tempEl = this._makePolyline(pt.x, pt.y);
      this.drawLayer.appendChild(this.tempEl);
    } else if (this.currentTool === 'arrow' || this.currentTool === 'straight-line') {
      this.tempEl = this._makeLine(pt.x, pt.y, pt.x, pt.y);
      this.drawLayer.appendChild(this.tempEl);
    } else if (this.currentTool === 'circle') {
      this.tempEl = this._makeCircle(pt.x, pt.y, 0);
      this.drawLayer.appendChild(this.tempEl);
    }
  }

  _onMouseMove(e) {
    const pt = this._getSVGPoint(e);
    if (this.draggingIcon && this.selectedIcon) {
      this._positionIcon(this.selectedIcon, pt.x - this.iconDragOffset.x, pt.y - this.iconDragOffset.y);
      return;
    }
    if (!this.isDrawing || !this.startPt || !this.tempEl) return;
    if (this.currentTool === 'line') {
      const pts = this.tempEl.getAttribute('points');
      this.tempEl.setAttribute('points', pts + ` ${pt.x},${pt.y}`);
    } else if (this.currentTool === 'arrow' || this.currentTool === 'straight-line') {
      this.tempEl.setAttribute('x2', pt.x);
      this.tempEl.setAttribute('y2', pt.y);
    } else if (this.currentTool === 'circle') {
      this.tempEl.setAttribute('r', Math.hypot(pt.x - this.startPt.x, pt.y - this.startPt.y));
    }
  }

  _onMouseUp() {
    if (!this.isDrawing) return;
    this.isDrawing = false;
    if (this.tempEl) { this._pushUndo(); this.tempEl = null; }
    this.startPt = null;
  }

  _onClick(e) {
    if (this.currentTool === 'text') {
      const pt   = this._getSVGPoint(e);
      const text = prompt('Enter text:');
      if (text) {
        this._pushUndo();
        const el = this._makeSVGEl('text', {
          x: pt.x, y: pt.y, fill: this.currentColor,
          'font-size': 10, 'font-family': 'Arial, sans-serif'
        });
        el.textContent = text;
        this.drawLayer.appendChild(el);
      }
    }
    if (this.currentTool === 'select') {
      if (!this._hitTestIcon(this._getSVGPoint(e))) this._deselectIcon();
    }
  }

  /* ======================================================
     DRAWING HELPERS
     ====================================================== */
  _makeLine(x1, y1, x2, y2) {
    const el = this._makeSVGEl('line', {
      x1, y1, x2, y2, stroke: this.currentColor,
      'stroke-width': this.currentStrokeWidth, 'stroke-linecap': 'round'
    });
    if (this.currentTool === 'arrow') {
      this._ensureArrowMarker(this.currentColor);
      el.setAttribute('marker-end', `url(#ah-${this.currentColor.replace('#', '')})`);
    }
    return el;
  }

  _makePolyline(x, y) {
    return this._makeSVGEl('polyline', {
      points: `${x},${y}`, stroke: this.currentColor,
      'stroke-width': this.currentStrokeWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      fill: 'none'
    });
  }

  _makeCircle(cx, cy, r) {
    return this._makeSVGEl('circle', {
      cx, cy, r, stroke: this.currentColor,
      'stroke-width': this.currentStrokeWidth, fill: 'none'
    });
  }

  _makeSVGEl(tag, attrs = {}) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  }

  _ensureArrowMarker(color) {
    const id = `ah-${color.replace('#', '')}`;
    if (this.svg.querySelector(`#${id}`)) return;
    let defs = this.svg.querySelector('defs');
    if (!defs) { defs = this._makeSVGEl('defs'); this.svg.prepend(defs); }
    const marker = this._makeSVGEl('marker', { id, markerWidth: 8, markerHeight: 6, refX: 6, refY: 3, orient: 'auto' });
    marker.appendChild(this._makeSVGEl('path', { d: 'M0,0 L0,6 L8,3 Z', fill: color }));
    defs.appendChild(marker);
  }

  _pushUndo() { this.undoStack.push(this.drawLayer.innerHTML); this.redoStack = []; }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.drawLayer.innerHTML);
    this.drawLayer.innerHTML = this.undoStack.pop();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.drawLayer.innerHTML);
    this.drawLayer.innerHTML = this.redoStack.pop();
  }
  clearDrawings() { this._pushUndo(); this.drawLayer.innerHTML = ''; }

  setTool(tool) { this.currentTool = tool; this.svg.style.cursor = tool === 'select' ? 'default' : 'crosshair'; }
  setColor(c)       { this.currentColor       = c; }
  setStrokeWidth(w) { this.currentStrokeWidth = parseInt(w); }

  /* ======================================================
     ICONS
     ====================================================== */
  addIcon(iconData, x = 150, y = 150) {
    const g = this._makeSVGEl('g');
    g.dataset.iconId   = iconData.id;
    g.dataset.cx       = x;
    g.dataset.cy       = y;
    g.dataset.scale    = 1;
    g.dataset.rotation = 0;
    g.innerHTML = `<svg x="-16" y="-16" width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">${iconData.svgContent}</svg>`;
    g.style.cursor = 'move';
    this._applyTransform(g, x, y, 1, 0);
    this.iconLayer.appendChild(g);
    this._selectIconEl(g);
    return g;
  }

  _positionIcon(g, cx, cy) {
    g.dataset.cx = cx; g.dataset.cy = cy;
    this._applyTransform(g, cx, cy, parseFloat(g.dataset.scale), parseFloat(g.dataset.rotation));
  }

  setIconScale(s) {
    if (!this.selectedIcon) return;
    this.selectedIcon.dataset.scale = s;
    this._applyTransform(this.selectedIcon,
      parseFloat(this.selectedIcon.dataset.cx), parseFloat(this.selectedIcon.dataset.cy),
      parseFloat(s), parseFloat(this.selectedIcon.dataset.rotation));
  }

  setIconRotation(deg) {
    if (!this.selectedIcon) return;
    this.selectedIcon.dataset.rotation = deg;
    this._applyTransform(this.selectedIcon,
      parseFloat(this.selectedIcon.dataset.cx), parseFloat(this.selectedIcon.dataset.cy),
      parseFloat(this.selectedIcon.dataset.scale), parseFloat(deg));
  }

  _applyTransform(g, cx, cy, scale, rotation) {
    g.setAttribute('transform', `translate(${cx},${cy}) rotate(${rotation}) scale(${scale})`);
  }

  deleteSelectedIcon() {
    if (this.selectedIcon) { this.selectedIcon.remove(); this.selectedIcon = null; window.app && window.app.hideIconProps(); }
  }

  _hitTestIcon(pt) {
    const icons = Array.from(this.iconLayer.querySelectorAll('g[data-icon-id]')).reverse();
    for (const g of icons) {
      const cx = parseFloat(g.dataset.cx || 150);
      const cy = parseFloat(g.dataset.cy || 150);
      if (Math.hypot(pt.x - cx, pt.y - cy) < 20 * parseFloat(g.dataset.scale || 1)) return g;
    }
    return null;
  }

  _selectIconEl(g) { this.selectedIcon = g; this._onIconSelected(g); }
  _deselectIcon()  { this.selectedIcon = null; window.app && window.app.hideIconProps(); }
  _onIconSelected(g) {
    window.app && window.app.showIconProps({
      scale:    parseFloat(g.dataset.scale    || 1),
      rotation: parseFloat(g.dataset.rotation || 0)
    });
  }

  /* ======================================================
     BASE ILLUSTRATION
     ====================================================== */

  /**
   * Build the shared projection from geo coords → SVG pixels.
   *
   * The entry direction (inBearing = compass bearing of travel on approach)
   * is rotated so the approach always comes from the SOUTH (bottom, 6 o'clock).
   *
   * "Approach comes from south" means: in the rotated frame, the FIRST point
   * of the route should be at the BOTTOM of the SVG (maximum SVG-y).
   * The route travels upward into the illustration from there.
   *
   * Rotation: we want the travel direction (inBearing) to point UP (north)
   * in the rotated frame, so the approach is from below.
   * → rotate by -inBearing (so inBearing→0 = up after rotation).
   *
   * X and Y scales are INDEPENDENT — the full draw area is always filled.
   *
   * @param {LatLng}   wpLL         waypoint latlng (origin of metric plane)
   * @param {Array}    allCoords    ordered LatLng array (before + wp + after)
   * @param {number}   inBearing    compass bearing of travel at entry (degrees)
   * @returns {{ toSVG, rxSpan, rySpan }} or null if degenerate
   */
  _buildTransform(wpLL, allCoords, inBearing, bounds) {
    const VW = 300, VH = 300, PAD = 18;
    const drawW = VW - PAD * 2, drawH = VH - PAD * 2;

    const latScale = 111320;
    const lngScale = 111320 * Math.cos(wpLL.lat * Math.PI / 180);

    const toMetric = (ll) => ({
      mx: (ll.lng - wpLL.lng) * lngScale,
      my: (ll.lat - wpLL.lat) * latScale
    });

    // Rotate so inBearing (travel direction at entry) → points UP (north in rotated frame)
    // entry arrives FROM south → bolletje appears at bottom of SVG
    const rotRad = (inBearing * Math.PI / 180);
    const cosR   = Math.cos(rotRad), sinR = Math.sin(rotRad);

    const rotateMetric = ({ mx, my }) => ({
      rx:  mx * cosR - my * sinR,
      ry:  mx * sinR + my * cosR    // ry positive = north after rotation
    });

    const rotated = allCoords.map(ll => rotateMetric(toMetric(ll)));

    let rxMin, rxMax, ryMin, ryMax;

    // If bounds are provided, use them to define the coordinate space.
    // This ensures that resizing the window changes the illustration scale.
    if (bounds) {
      let sw, ne;
      if (bounds.getSouthWest) { // It's a Leaflet instance
        sw = bounds.getSouthWest();
        ne = bounds.getNorthEast();
      } else if (bounds._southWest) { // It's a serialized Leaflet object
        sw = bounds._southWest;
        ne = bounds._northEast;
      }

      if (sw && ne) {
        const corners = [
          { lat: ne.lat, lng: sw.lng }, // NW
          { lat: ne.lat, lng: ne.lng }, // NE
          { lat: sw.lat, lng: sw.lng }, // SW
          { lat: sw.lat, lng: ne.lng }  // SE
        ];
        const rotatedCorners = corners.map(c => rotateMetric(toMetric(c)));
        const rcX = rotatedCorners.map(c => c.rx);
        const rcY = rotatedCorners.map(c => c.ry);
        rxMin = Math.min(...rcX);
        rxMax = Math.max(...rcX);
        ryMin = Math.min(...rcY);
        ryMax = Math.max(...rcY);
      }
    }

    // Fallback to old method if no bounds provided or bounds were invalid
    if (typeof rxMin === 'undefined') {
      const rxAll = rotated.map(r => r.rx);
      const ryAll = rotated.map(r => r.ry);
      rxMin = Math.min(...rxAll); rxMax = Math.max(...rxAll);
      ryMin = Math.min(...ryAll); ryMax = Math.max(...ryAll);
    }

    const rxSpan = rxMax - rxMin || 1;
    const rySpan = ryMax - ryMin || 1;

    // Independent X/Y scales → always fills the full draw area
    const scaleX = drawW / rxSpan;
    const scaleY = drawH / rySpan;

    const toSVG = ({ rx, ry }) => ({
      x: PAD + (rx - rxMin) * scaleX,
      y: PAD + (ryMax - ry) * scaleY   // flip Y: north = top, south = bottom
    });

    return { toSVG, rotateMetric, toMetric, rxSpan, rySpan };
  }

  /**
   * Render the base illustration.
   * wpData:
   *   nearCoords        { before: LatLng[], after: LatLng[] }
   *   latlng            LatLng
   *   routeWindowBounds L.LatLngBounds | null
   *   inBearing         number  (compass bearing of travel at entry)
   *   bearing           number  (compass bearing at exit)
   *   type              string
   *   stencilPaths      Array<{ coords: LatLng[] }>  optional
   */
  renderBaseIllustration(wpData) {
    this.baseLayer.innerHTML = '';

    const VW = 300, VH = 300, PAD = 18;
    const drawW = VW - PAD * 2, drawH = VH - PAD * 2;

    const near   = wpData.nearCoords;
    const wpLL   = wpData.latlng;

    const before = (near && near.before) ? near.before : [];
    const after  = (near && near.after)  ? near.after  : [];
    const allCoords = [...before, wpLL, ...after].filter(Boolean);

    if (allCoords.length < 2) { this._renderBearingFallback(wpData); return; }

    const inBearing = (wpData.inBearing != null) ? wpData.inBearing : 0;
    const xf = this._buildTransform(wpLL, allCoords, inBearing, wpData.routeWindowBounds);
    if (!xf) { this._renderBearingFallback(wpData); return; }

    const { toSVG, rotateMetric, toMetric } = xf;

    const routePts = allCoords.map(ll => toSVG(rotateMetric(toMetric(ll))));
    const wpPt     = toSVG(rotateMetric(toMetric(wpLL)));

    const mk = (tag, attrs) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      this.baseLayer.appendChild(el);
      return el;
    };

    /* ---- Background ---- */
    mk('rect', { width: VW, height: VH, fill: '#f0efea' });

    /* ---- Subtle grid ---- */
    for (let i = 0; i <= 4; i++) {
      const x = PAD + (drawW / 4) * i, y = PAD + (drawH / 4) * i;
      mk('line', { x1: x, y1: PAD, x2: x, y2: VH - PAD, stroke: '#e0ddd5', 'stroke-width': 0.5 });
      mk('line', { x1: PAD, y1: y, x2: VW - PAD, y2: y,  stroke: '#e0ddd5', 'stroke-width': 0.5 });
    }

    /* ---- Stencil paths (user-traced roads) — drawn FIRST, below route ---- */
    if (wpData.stencilPaths && wpData.stencilPaths.length) {
      wpData.stencilPaths.forEach(sp => {
        if (!sp.coords || sp.coords.length < 2) return;
        const spts = sp.coords.map(ll => toSVG(rotateMetric(toMetric(ll))));
        const ptStr = spts.map(p => `${p.x},${p.y}`).join(' ');

        // Roundabouts get a special ring treatment
        if (sp.isRoundabout) {
          // Draw as a closed ring — find centroid and radius in SVG space
          const cx = spts.reduce((s, p) => s + p.x, 0) / spts.length;
          const cy = spts.reduce((s, p) => s + p.y, 0) / spts.length;
          const r = spts.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / spts.length;
          mk('circle', {
            cx,
            cy,
            r: r + 4,
            fill: 'none',
            stroke: '#555',
            'stroke-width': 6,
            'stroke-linecap': 'round'
          });
          mk('circle', {
            cx,
            cy,
            r: r + 4,
            fill: 'none',
            stroke: '#333',
            'stroke-width': 3,
            'stroke-linecap': 'round'
          });
        } else if (sp.isRoute) {
          // Road casing + surface for normal roads
          mk('polyline', {
            points: ptStr,
            fill: 'none',
            stroke: '#666',
            'stroke-width': 8,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round'
          });
          mk('polyline', {
            points: ptStr,
            fill: 'none',
            stroke: '#333',
            'stroke-width': 4,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round'
          });
        } else {
          // Non-route roads
          mk('polyline', {
            points: ptStr,
            fill: 'none',
            stroke: '#000',
            'stroke-width': 2,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round'
          });
        }
      });
    }

    /* ---- Driven route: road casing + surface + centre dashes ---- */
    const pts = routePts.map(p => `${p.x},${p.y}`).join(' ');
    mk('polyline', { points: pts, fill: 'none', stroke: '#b0aa9a', 'stroke-width': 16, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    mk('polyline', { points: pts, fill: 'none', stroke: '#dedad0', 'stroke-width': 11, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    mk('polyline', { points: pts, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '8 10', opacity: 0.7 });

    /* ---- Route path (red driven line) ---- */
    mk('polyline', { points: pts, fill: 'none', stroke: '#e74c3c', 'stroke-width': 3.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.92 });

    /* ---- Roundabout overlay on waypoint ---- */
    if (wpData.type && wpData.type.startsWith('roundabout')) {
      mk('circle', { cx: wpPt.x, cy: wpPt.y, r: 22, stroke: '#b0aa9a', 'stroke-width': 8, fill: '#d8d5c8' });
      mk('circle', { cx: wpPt.x, cy: wpPt.y, r: 15, fill: '#c5c2b5' });
    }

    /* ---- BOLLETJE — always at south/bottom border (6 o'clock) ---- */
    // The first route point is already near the bottom because we rotated
    // so inBearing points up. We fix its y to the bottom border line.
    const entryX = routePts[0] ? routePts[0].x : VW / 2;
    mk('circle', { cx: entryX, cy: VH - PAD, r: 9, fill: '#000000', stroke: 'none' });

    /* ---- PIJLTJE — exit arrow at last route point ---- */
    const exitPt  = routePts[routePts.length - 1];
    const exitPt2 = routePts[routePts.length - 2];
    if (exitPt && exitPt2) {
      const ang = Math.atan2(exitPt.y - exitPt2.y, exitPt.x - exitPt2.x);
      const hl  = 11, hw = 0.42;
      mk('circle', { cx: exitPt.x, cy: exitPt.y, r: 11, fill: '#fff', stroke: '#000000', 'stroke-width': 3 });
      mk('polygon', {
        points: `${exitPt.x},${exitPt.y} ${exitPt.x - hl*Math.cos(ang-hw)},${exitPt.y - hl*Math.sin(ang-hw)} ${exitPt.x - hl*Math.cos(ang+hw)},${exitPt.y - hl*Math.sin(ang+hw)}`,
        fill: '#000000'
      });
    }

    /* ---- Waypoint centre dot ---- */
    mk('circle', { cx: wpPt.x, cy: wpPt.y, r: 7, fill: '#f5a623', stroke: '#fff', 'stroke-width': 2, opacity: 0.9 });
  }

  /* ======================================================
     BEARING-ONLY FALLBACK
     ====================================================== */
  _renderBearingFallback(wpData) {
    const VW = 300, VH = 300;
    const cx = 150, cy = 150, sqHalf = 105;
    const { inBearing = 180, bearing = 0 } = wpData;
    const d2r = d => d * Math.PI / 180;

    const mk = (tag, attrs) => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      this.baseLayer.appendChild(el);
      return el;
    };

    mk('rect', { width: VW, height: VH, fill: '#f0efea' });
    mk('rect', { x: cx - sqHalf, y: cy - sqHalf, width: sqHalf * 2, height: sqHalf * 2,
      fill: '#e8e7e0', stroke: '#bbb', 'stroke-width': 1.5, 'stroke-dasharray': '4 3', rx: 2 });

    const edgePt = (b) => {
      const dx = Math.sin(d2r(b)), dy = -Math.cos(d2r(b));
      let t = Infinity;
      if (dx > 0) t = Math.min(t, sqHalf / dx); if (dx < 0) t = Math.min(t, -sqHalf / dx);
      if (dy > 0) t = Math.min(t, sqHalf / dy); if (dy < 0) t = Math.min(t, -sqHalf / dy);
      return { x: cx + dx * t, y: cy + dy * t };
    };

    // In fallback: entry always from bottom (south = bearing 180° = coming from south)
    const entry = { x: cx, y: cy + sqHalf };
    const exit  = edgePt(bearing);

    const roadW = 18;
    const drawRoad = (x1, y1, x2, y2) => {
      const a = Math.atan2(y2-y1, x2-x1), p = a + Math.PI/2, hw = roadW/2;
      const px = Math.cos(p)*hw, py = Math.sin(p)*hw;
      mk('polygon', { points: `${x1+px},${y1+py} ${x1-px},${y1-py} ${x2-px},${y2-py} ${x2+px},${y2+py}`, fill: '#ccc9be' });
    };
    drawRoad(entry.x, entry.y, cx, cy);
    drawRoad(cx, cy, exit.x, exit.y);
    mk('circle', { cx, cy, r: roadW * 0.85, fill: '#ccc9be' });
    mk('path', { d: `M ${entry.x} ${entry.y} Q ${cx} ${cy} ${exit.x} ${exit.y}`, stroke: '#e74c3c', 'stroke-width': 3.5, fill: 'none', 'stroke-linecap': 'round' });
    mk('circle', { cx: entry.x, cy: entry.y, r: 9, fill: '#000000', stroke: 'none' });

    const ang = d2r(bearing), hl = 11, hw2 = 0.42;
    mk('circle', { cx: exit.x, cy: exit.y, r: 11, fill: '#fff', stroke: '#000000', 'stroke-width': 3 });
    mk('polygon', { points: `${exit.x},${exit.y} ${exit.x-hl*Math.cos(ang-hw2)},${exit.y-hl*Math.sin(ang-hw2)} ${exit.x-hl*Math.cos(ang+hw2)},${exit.y-hl*Math.sin(ang+hw2)}`, fill: '#000000' });
    mk('circle', { cx, cy, r: 6, fill: '#f5a623', opacity: 0.5 });
  }

  /* ======================================================
     SERIALIZATION
     ====================================================== */
  getState() {
    return { drawLayerHTML: this.drawLayer.innerHTML, iconLayerData: this._serializeIcons() };
  }

  _serializeIcons() {
    return Array.from(this.iconLayer.querySelectorAll('g[data-icon-id]')).map(g => ({
      iconId: g.dataset.iconId, cx: parseFloat(g.dataset.cx), cy: parseFloat(g.dataset.cy),
      scale: parseFloat(g.dataset.scale), rotation: parseFloat(g.dataset.rotation)
    }));
  }

  loadState(state) {
    if (state.drawLayerHTML !== undefined) this.drawLayer.innerHTML = state.drawLayerHTML;
    if (state.iconLayerData) {
      this.iconLayer.innerHTML = '';
      this.selectedIcon = null;
      state.iconLayerData.forEach(d => {
        const ic = window.iconManager && window.iconManager.getById(d.iconId);
        if (ic) {
          const g = this.addIcon(ic, d.cx, d.cy);
          g.dataset.scale    = d.scale;
          g.dataset.rotation = d.rotation;
          this._applyTransform(g, d.cx, d.cy, d.scale, d.rotation);
          this._deselectIcon();
        }
      });
    }
  }

  getSVGString() {
    const clone = this.svg.cloneNode(true);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', '300'); bg.setAttribute('height', '300'); bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);
    return new XMLSerializer().serializeToString(clone);
  }
}

window.SVGEditor = SVGEditor;