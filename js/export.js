/**
 * export.js — PDF and ZIP export/import
 *
 * PDF fix: SVG is rendered to a hidden <canvas> via a blob URL image,
 * then that canvas is added to jsPDF as PNG data. This avoids the
 * "white illustration" problem caused by cross-origin or CSP issues
 * with XMLSerializer + btoa directly in jsPDF.addImage.
 */

class ExportManager {
  constructor(wpManager, routeManager) {
    this.wpManager    = wpManager;
    this.routeManager = routeManager;
  }

  /* ============================================================
     PDF EXPORT
     ============================================================ */
  async exportPDF() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();   // 210
    const pageH = doc.internal.pageSize.getHeight();  // 297

    const drawHeader = (pageNum) => {
      doc.setFillColor(15, 17, 23);
      doc.rect(0, 0, pageW, 16, 'F');
      doc.setTextColor(245, 166, 35);
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('RALLY ROADBOOK', 10, 11);
      doc.setFontSize(8);
      doc.setTextColor(160, 160, 180);
      doc.text(`Generated: ${new Date().toLocaleString()}  |  Page ${pageNum}`, pageW - 10, 11, { align: 'right' });
    };

    const drawFooter = () => {
      const year = new Date().getFullYear();
      const notice = `© ${year} - domain.org/rallyroadbookcreator`;
      doc.setFontSize(8);
      doc.setTextColor(128, 128, 128);
      doc.text(notice, pageW / 2, pageH - 8, { align: 'center' });
    };

    // Column definitions [label, width mm]
    const cols = [
      { label: '#',               w: 10 },
      { label: 'Illustration',    w: 55 },
      { label: 'A -> B',          w: 26 },
      { label: 'Total',           w: 26 },
      { label: 'Comment / Notes', w: 78 },
    ];
    const totalW = cols.reduce((a, c) => a + c.w, 0);
    const rowH   = 46;
    const tableLeft = (pageW - totalW) / 2;
    const tableTop  = 20;
    const headerH   = 8;

    const drawTableHeader = (y) => {
      doc.setFillColor(31, 37, 53);
      doc.rect(tableLeft, y, totalW, headerH, 'F');
      doc.setTextColor(245, 166, 35);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');
      let x = tableLeft;
      cols.forEach(col => {
        if (col.label) doc.text(col.label, x + 2, y + 5.5);
        x += col.w;
      });
    };

    let pageNum = 1;
    drawHeader(pageNum);
    drawFooter();
    drawTableHeader(tableTop);
    let y = tableTop + headerH;

    const wps = this.wpManager.getAll();

    for (let i = 0; i < wps.length; i++) {
      const wp = wps[i];

      if (y + rowH > pageH - 12) {
        doc.addPage();
        pageNum++;
        drawHeader(pageNum);
        drawFooter();
        drawTableHeader(tableTop);
        y = tableTop + headerH;
      }

      // Row background (alternating)
      const bgR = i % 2 === 0 ? 250 : 242;
      doc.setFillColor(bgR, bgR, bgR - 6);
      doc.rect(tableLeft, y, totalW, rowH, 'F');

      // Column borders
      doc.setDrawColor(200, 200, 200);
      let x = tableLeft;
      cols.forEach(col => {
        doc.rect(x, y, col.w, rowH);
        x += col.w;
      });

      // Build column x positions
      const colX = [];
      x = tableLeft;
      cols.forEach(col => { colX.push(x); x += col.w; });

      // 1. Row number
      doc.setTextColor(80, 80, 100);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text(`${i + 1}`, colX[0] + cols[0].w / 2, y + rowH / 2 + 2, { align: 'center' });

      // 2. Illustration — render SVG to canvas then to PDF
      try {
        const pngData = await this._renderWaypointToPNG(wp, 260, 260);
        if (pngData) {
          const imgPad = 3;
          const imgW = cols[1].w - imgPad * 2;
          const imgH = rowH - imgPad * 2;
          doc.addImage(pngData, 'PNG', colX[1] + imgPad, y + imgPad, imgW, imgH);
        }
      } catch (err) {
        console.warn('SVG render error for wp', i, err);
        doc.setFontSize(7);
        doc.setTextColor(130, 130, 130);
        doc.text(wp.type || '—', colX[1] + 2, y + rowH / 2);
      }

      // 3. Distances
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(40, 40, 60);
      const fmt = v => this.wpManager.formatDistance(v);
      const distCols = [
        { idx: 2, val: fmt(wp.distAB) },
        { idx: 3, val: fmt(wp.distTotal) }
      ];
      distCols.forEach(d => {
        doc.text(d.val, colX[d.idx] + cols[d.idx].w / 2, y + rowH / 2 + 2, { align: 'center' });
      });

      // 4. Comment
      if (wp.comment) {
        doc.setFontSize(8);
        doc.setTextColor(40, 40, 60);
        const lines = doc.splitTextToSize(wp.comment, cols[4].w - 4);
        doc.text(lines.slice(0, 5), colX[4] + 2, y + 8);
      }

      y += rowH;
    }

    doc.save('rally-roadbook.pdf');
  }

  /* ============================================================
     GPX EXPORT
     ============================================================ */
  async exportGPX() {
    const waypoints = this.wpManager.getAll();
    const routeCoords = this.routeManager.routeCoords;
    const routeName = 'Rally Roadbook Route';

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rally Roadbook Creator" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${routeName}</name>
    <desc>Generated by Rally Roadbook Creator</desc>
    <link href="https://domain.org/rallyroadbookcreator"></link>
    <time>${new Date().toISOString()}</time>
  </metadata>
`;

    // Waypoints
    waypoints.forEach(wp => {
      gpx += `  <wpt lat="${wp.latlng.lat}" lon="${wp.latlng.lng}">
    <time>${new Date().toISOString()}</time>
    <name>WP ${wp.listIndex + 1}: ${wp.instruction.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</name>
    <desc>${(wp.comment || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</desc>
  </wpt>
`;
    });

    // Track
    gpx += `  <trk>
    <name>${routeName}</name>
    <trkseg>
`;
    if (routeCoords) {
      routeCoords.forEach(coord => {
        gpx += `      <trkpt lat="${coord.lat}" lon="${coord.lng}"></trkpt>
`;
      });
    }

    gpx += `    </trkseg>
  </trk>
</gpx>`;

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rally-roadbook-${Date.now()}.gpx`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ============================================================
     SVG -> PNG via offscreen canvas
     ============================================================ */
  async _renderWaypointToPNG(wp, w = 260, h = 260) {
    // 1. Build a standalone SVG string for this waypoint
    const svgStr = this._buildWaypointSVG(wp);

    // 2. Convert SVG string to a Blob URL
    const blob    = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const blobURL = URL.createObjectURL(blob);

    // 3. Draw on an offscreen canvas
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(blobURL);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = err => { URL.revokeObjectURL(blobURL); reject(err); };
      img.src = blobURL;
    });
  }

  /**
   * Build a complete, self-contained SVG string for a waypoint.
   * We create a temporary SVG element, render the illustration into it,
   * then serialize it.
   */
  _buildWaypointSVG(wp) {
    // Create a detached SVG
    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 300 300');
    svg.setAttribute('width',   '300');
    svg.setAttribute('height',  '300');
    svg.setAttribute('xmlns',   ns);

    // White background
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', '300'); bg.setAttribute('height', '300'); bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    // Layers
    const baseLayer = document.createElementNS(ns, 'g');
    const drawLayer = document.createElementNS(ns, 'g');
    const iconLayer = document.createElementNS(ns, 'g');
    svg.appendChild(baseLayer);
    svg.appendChild(drawLayer);
    svg.appendChild(iconLayer);

    // We need the SVGEditor to render into this element.
    // Temporarily patch the element IDs so SVGEditor can find them.
    baseLayer.id = '_exp_base';
    drawLayer.id = '_exp_draw';
    iconLayer.id = '_exp_icon';

    // Render the base illustration directly using SVGEditor's logic
    const editor = new SVGEditor(svg);
    editor.baseLayer = baseLayer;
    editor.drawLayer = drawLayer;
    editor.iconLayer = iconLayer;

    editor.renderBaseIllustration(wp);

    // Restore saved drawing and icons
    if (wp.svgState) {
      if (wp.svgState.drawLayerHTML) drawLayer.innerHTML = wp.svgState.drawLayerHTML;
      if (wp.svgState.iconLayerData) {
        wp.svgState.iconLayerData.forEach(d => {
          const ic = window.iconManager.getById(d.iconId);
          if (!ic) return;
          const g = document.createElementNS(ns, 'g');
          g.dataset.iconId   = d.iconId;
          g.dataset.cx       = d.cx;
          g.dataset.cy       = d.cy;
          g.dataset.scale    = d.scale;
          g.dataset.rotation = d.rotation;
          g.innerHTML = `<svg x="-16" y="-16" width="32" height="32" viewBox="0 0 32 32" xmlns="${ns}">${ic.svgContent}</svg>`;
          g.setAttribute('transform', `translate(${d.cx},${d.cy}) rotate(${d.rotation}) scale(${d.scale})`);
          iconLayer.appendChild(g);
        });
      }
    }

    return new XMLSerializer().serializeToString(svg);
  }

  /*  Custom import/export logic: users can export their route to a zipfile which
  contains all the instructions to rebuild the route in its exported state. 

  */
  async exportZIP() {
    const zip = new JSZip();

    zip.file('route.json',    JSON.stringify(this.routeManager.serialize(), null, 2));
    zip.file('waypoints.json', JSON.stringify(this.wpManager.serialize(), null, 2));
    zip.file('meta.json', JSON.stringify({
      version:       '1.1',
      created:       new Date().toISOString(),
      totalWaypoints: this.wpManager.getAll().length,
      totalDistance:  this.routeManager.totalDistance()
    }, null, 2));

    // SVG previews as PNG
    const previews = zip.folder('previews');
    for (const wp of this.wpManager.serialize()) {
      try {
        const png = await this._renderWaypointToPNG(wp, 300, 300);
        previews.file(`wp-${wp.listIndex}.png`, png.split(',')[1], { base64: true });
      } catch (e) { /* skip */ }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rally-roadbook-${Date.now()}.zip`;
    a.click();
  }
  async importZIP(file) {
    const zip = await JSZip.loadAsync(file);

    const routeFile = zip.file('route.json');
    const wpFile    = zip.file('waypoints.json');
    if (!routeFile || !wpFile) throw new Error('Invalid ZIP: missing route.json or waypoints.json');

    const routeData = JSON.parse(await routeFile.async('string'));
    const wpData    = JSON.parse(await wpFile.async('string'));
    return { routeData, wpData };
  }
}

window.ExportManager = ExportManager;