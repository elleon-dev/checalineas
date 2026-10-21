const STORAGE_KEY = 'osiptel_consultas_historial_v1';
const PERU_RELAY_URL = 'https://8d39a8d6e88f0d.lhr.life';
const LOCAL_BRIDGE_URL = 'http://localhost:3000';

let resultados = loadResultados();
let expandedRows = new Set();
let abortFlag = false;
let isRunning = false;

function loadResultados() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    const seen = new Set();
    return arr.filter(item => {
      if (!item || !item.numeroDocumento || seen.has(item.numeroDocumento)) return false;
      seen.add(item.numeroDocumento);
      return true;
    });
  } catch (_) {
    return [];
  }
}

function saveResultados() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(resultados));
  } catch (_) {}
}

function limpiarListaCompleta() {
  abortFlag = true;
  resultados = [];
  expandedRows.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  const filtro = document.getElementById('inputFiltroTabla');
  if (filtro) filtro.value = '';
  renderAll();
  const input = document.getElementById('inputDocumentos');
  if (input) input.focus();
}

function upsertResultado(res) {
  if (!res || !res.numeroDocumento) return;
  const idx = resultados.findIndex(r => r.numeroDocumento === res.numeroDocumento);
  if (idx >= 0) {
    resultados[idx] = res;
  } else {
    resultados.unshift(res);
  }
  saveResultados();
  renderAll();
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseInputDocuments(rawText = '') {
  const tokens = String(rawText)
    .split(/[\r\n,;|\t ]+/)
    .map(t => t.trim().toUpperCase())
    .filter(t => t.length >= 6 && /^[A-Z0-9]+$/.test(t) && !/^(RUC|DNI|DOCUMENTO|NUMERO|TIPO)$/.test(t));

  return Array.from(new Set(tokens));
}

/* ============================================================================
   CLIENT-SIDE .XLSX PARSER (Zero server roundtrip needed for Excel import)
============================================================================ */
async function parseXlsxInBrowser(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('El archivo no es un Excel (.xlsx) válido.');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries && cdOffset + 46 <= bytes.length; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const compressionMethod = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const fileNameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const fileName = decoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + fileNameLen));

    if (
      (fileName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(fileName)) &&
      localHeaderOffset + 30 <= bytes.length
    ) {
      const localNameLen = view.getUint16(localHeaderOffset + 26, true);
      const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedSlice = bytes.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        entries.set(fileName, decoder.decode(compressedSlice));
      } else if (compressionMethod === 8 && typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        writer.write(compressedSlice);
        writer.close();
        const decompressedBuf = await new Response(ds.readable).arrayBuffer();
        entries.set(fileName, decoder.decode(decompressedBuf));
      }
    }

    cdOffset += 46 + fileNameLen + extraLen + commentLen;
  }

  const decodeEntities = (str) =>
    String(str || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');

  const sharedStrings = [];
  const ssXml = entries.get('xl/sharedStrings.xml');
  if (ssXml) {
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(ssXml)) !== null) {
      const inner = siMatch[1];
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tMatch;
      let combined = '';
      while ((tMatch = tRegex.exec(inner)) !== null) {
        combined += decodeEntities(tMatch[1]);
      }
      sharedStrings.push(combined.trim());
    }
  }

  const rawValues = [];
  const sheetKeys = Array.from(entries.keys())
    .filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort();

  for (const key of sheetKeys) {
    const xml = entries.get(key);
    const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(xml)) !== null) {
      const attrs = cellMatch[1] || '';
      const inner = cellMatch[2] || '';
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : 'n';

      let val = '';
      if (cellType === 's') {
        const vMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (vMatch) {
          val = sharedStrings[parseInt(vMatch[1].trim(), 10)] ?? '';
        }
      } else if (cellType === 'inlineStr') {
        const tMatch = inner.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        if (tMatch) val = decodeEntities(tMatch[1]);
      } else {
        const vMatch = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (vMatch) {
          const rawV = decodeEntities(vMatch[1]).trim();
          if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(rawV)) {
            const num = Number(rawV);
            val = Number.isFinite(num) ? Math.round(num).toString() : rawV;
          } else if (/^\d+\.0+$/.test(rawV)) {
            val = rawV.replace(/\.0+$/, '');
          } else {
            val = rawV;
          }
        }
      }

      const cleaned = String(val || '').trim().toUpperCase().replace(/\s+/g, '');
      if (
        cleaned.length >= 8 &&
        cleaned.length <= 20 &&
        /^[A-Z0-9]+$/.test(cleaned) &&
        !/^(RUC|DNI|DOCUMENTO|DOCUMENTOS|NRO|NUMERO|TIPO)$/.test(cleaned)
      ) {
        rawValues.push(cleaned);
      }
    }
  }

  return Array.from(new Set(rawValues));
}

/* ============================================================================
   SMART API CLIENT (Peruvian Exit Relay + Netlify Edge + Localhost Bridge)
============================================================================ */
async function consultarDocumentoSmart(doc) {
  const isLocalhost =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  const savedRelay = (localStorage.getItem('osiptel_peru_relay_url') || PERU_RELAY_URL).replace(/\/+$/, '');

  const endpoints = isLocalhost
    ? ['/api/consultar', `${savedRelay}/api/consultar`]
    : ['/api/consultar', `${savedRelay}/api/consultar`, `${LOCAL_BRIDGE_URL}/api/consultar`];

  let lastResult = null;

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipoDoc: 'auto',
          numeroDocumento: doc,
          peruRelayUrl: savedRelay
        })
      });
      if (!response.ok) continue;
      const json = await response.json();
      if (json && json.ok) {
        return json;
      }
      lastResult = json;
    } catch (_) {
      // Try next endpoint in fallback chain
    }
  }

  if (lastResult) {
    return lastResult;
  }

  return {
    ok: false,
    tipoDocNombre: /^\d{11}$/.test(doc) ? 'RUC' : (/^\d{8}$/.test(doc) ? 'DNI' : 'DOC'),
    numeroDocumento: doc,
    totalLineas: 0,
    error: 'No se pudo conectar con el nodo Perú para consultar OSIPTEL.'
  };
}

function getOperatorClass(name = '') {
  const b = String(name).toUpperCase();
  if (b.includes('AMERICA MOVIL') || b.includes('CLARO')) return 'op-claro';
  if (b.includes('TELEFONICA') || b.includes('MOVISTAR') || b.includes('INTEGRATEL')) return 'op-movistar';
  if (b.includes('ENTEL')) return 'op-entel';
  if (b.includes('VIETTEL') || b.includes('BITEL')) return 'op-bitel';
  return 'op-otros';
}

function formatNumCell(val) {
  const n = Number(val || 0);
  return n === 0 ? `<span class="num-zero">0</span>` : `<strong>${n}</strong>`;
}

function renderAll() {
  const tbody = document.getElementById('tbodyResultados');
  const summaryStrip = document.getElementById('summaryStrip');
  const btnExportXlsx = document.getElementById('btnExportXlsx');
  const btnExportCsv = document.getElementById('btnExportCsv');
  const btnLimpiar = document.getElementById('btnLimpiarTodo');
  const filterText = (document.getElementById('inputFiltroTabla')?.value || '').trim().toLowerCase();

  const hasData = resultados.length > 0;
  summaryStrip.classList.toggle('hidden', !hasData);
  btnLimpiar.disabled = !hasData;
  btnExportXlsx.disabled = !hasData;
  btnExportCsv.disabled = !hasData;

  if (!hasData) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">
          Escribe un RUC/DNI arriba o sube tu archivo <strong>.xlsx</strong> para consultar sus empresas operadoras.
        </td>
      </tr>
    `;
    return;
  }

  let totalLines = 0;
  for (const r of resultados) {
    totalLines += Number(r.totalLineas || 0);
  }

  document.getElementById('statDocs').textContent = String(resultados.length);
  document.getElementById('statLines').textContent = String(totalLines);

  const filtered = resultados.filter(item => {
    if (!filterText) return true;
    const opsNames = Array.isArray(item.operadoresResumen)
      ? item.operadoresResumen.map(o => `${o.operador} ${o.operadorComercial}`).join(' ')
      : '';
    const hay = `${item.numeroDocumento} ${item.tipoDocNombre} ${opsNames} ${item.resumenTexto || ''}`.toLowerCase();
    return hay.includes(filterText);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="empty-state">Sin coincidencias para "${escapeHtml(filterText)}".</td>
      </tr>
    `;
    return;
  }

  const rowsHtml = [];

  for (const res of filtered) {
    const docId = res.numeroDocumento;
    const isExpanded = expandedRows.has(docId);
    const ops = Array.isArray(res.operadoresResumen) ? res.operadoresResumen : [];

    let opsHtml = '';
    if (!res.ok) {
      opsHtml = `<span style="color:#dc2626;font-size:0.8rem;">${escapeHtml(res.error || 'Error')}</span>`;
    } else if (ops.length === 0) {
      opsHtml = `<span style="color:#a1a1aa;font-size:0.8rem;">Sin líneas registradas</span>`;
    } else {
      opsHtml = `<div class="op-badges">` + ops.map(op => `
        <span class="op-badge ${getOperatorClass(op.operador)}">
          <span class="dot-sm"></span>
          <span>${escapeHtml(op.operador)}</span>
          <span class="op-badge-count">${op.total}</span>
        </span>
      `).join('') + `</div>`;
    }

    const lines = Array.isArray(res.lineas) ? res.lineas : [];

    rowsHtml.push(`
      <tr class="row-main" data-doc="${escapeHtml(docId)}">
        <td>
          <div class="doc-cell">
            <strong class="mono-text">${escapeHtml(docId)}</strong>
            <span class="doc-type-tag">${escapeHtml(res.tipoDocNombre || 'DOC')}</span>
          </div>
        </td>
        <td>${opsHtml}</td>
        <td class="num">${formatNumCell(res.totalLineas)}</td>
        <td class="num">
          <div class="row-actions">
            ${lines.length > 0 ? `
              <button type="button" class="btn-expand" data-toggle="${escapeHtml(docId)}">
                ${isExpanded ? 'Ocultar' : `Ver ${lines.length}`}
              </button>
            ` : ''}
            <button type="button" class="btn-remove-row" data-remove="${escapeHtml(docId)}" title="Quitar de la lista">×</button>
          </div>
        </td>
      </tr>
    `);

    if (isExpanded && lines.length > 0) {
      const chips = lines.map(l => `
        <div class="line-chip">
          <strong class="mono-text">${escapeHtml(l.numeroServicio)}</strong>
          <span class="line-chip-meta">${escapeHtml(l.operador)} · <strong>${escapeHtml(l.modalidad)}</strong></span>
        </div>
      `).join('');

      rowsHtml.push(`
        <tr class="row-detail">
          <td colspan="4">
            <div class="detail-box">
              <div class="lines-chips">${chips}</div>
            </div>
          </td>
        </tr>
      `);
    }
  }

  tbody.innerHTML = rowsHtml.join('');
}

async function consultarDocumentos(docs = []) {
  if (docs.length === 0 || isRunning) return;

  isRunning = true;
  abortFlag = false;

  const progressSection = document.getElementById('progressSection');
  const progressLabel = document.getElementById('progressLabel');
  const progressCounter = document.getElementById('progressCounter');
  const progressFill = document.getElementById('progressFill');
  const btnConsultar = document.getElementById('btnConsultar');

  progressSection.classList.remove('hidden');
  btnConsultar.disabled = true;

  let done = 0;

  for (const doc of docs) {
    if (abortFlag) break;

    progressLabel.textContent = `Consultando ${doc}...`;
    progressCounter.textContent = `${done + 1} / ${docs.length}`;
    progressFill.style.width = `${Math.round((done / docs.length) * 100)}%`;

    const res = await consultarDocumentoSmart(doc);
    if (docs.length === 1 && res.totalLineas > 0) {
      expandedRows.add(res.numeroDocumento);
    }
    upsertResultado(res);

    done += 1;
    progressFill.style.width = `${Math.round((done / docs.length) * 100)}%`;
  }

  isRunning = false;
  btnConsultar.disabled = false;
  progressSection.classList.add('hidden');
}

async function downloadExport(endpoint, payload, fallbackName) {
  const isLocalhost =
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const savedRelay = (localStorage.getItem('osiptel_peru_relay_url') || PERU_RELAY_URL).replace(/\/+$/, '');
  const urls = isLocalhost
    ? [endpoint, `${savedRelay}${endpoint}`]
    : [`${savedRelay}${endpoint}`, endpoint, `${LOCAL_BRIDGE_URL}${endpoint}`];

  for (const urlStr of urls) {
    try {
      const res = await fetch(urlStr, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) continue;
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : fallbackName;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      return;
    } catch (_) {}
  }

  alert('No se pudo generar el archivo de exportación.');
}

document.addEventListener('DOMContentLoaded', () => {
  renderAll();

  const form = document.getElementById('formConsulta');
  const input = document.getElementById('inputDocumentos');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const docs = parseInputDocuments(input.value);
    if (docs.length === 0) {
      input.focus();
      return;
    }
    input.value = '';
    consultarDocumentos(docs);
  });

  document.getElementById('fileExcelInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const name = file.name.toLowerCase();

    try {
      let docs = [];
      if (name.endsWith('.xlsx')) {
        const arrayBuf = await file.arrayBuffer();
        docs = await parseXlsxInBrowser(arrayBuf);
      } else {
        const text = await file.text();
        docs = parseInputDocuments(text);
      }

      if (docs.length === 0) {
        alert('No se encontraron RUCs o DNIs válidos en el archivo.');
        return;
      }

      consultarDocumentos(docs);
    } catch (err) {
      alert('Error al leer archivo: ' + err.message);
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('btnDetener').addEventListener('click', () => {
    abortFlag = true;
  });

  document.getElementById('btnLimpiarTodo').addEventListener('click', limpiarListaCompleta);
  document.getElementById('btnLimpiarSecundario').addEventListener('click', limpiarListaCompleta);

  document.getElementById('inputFiltroTabla').addEventListener('input', renderAll);

  document.getElementById('tbodyResultados').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      e.stopPropagation();
      const docToRemove = removeBtn.dataset.remove;
      resultados = resultados.filter(r => r.numeroDocumento !== docToRemove);
      expandedRows.delete(docToRemove);
      saveResultados();
      renderAll();
      return;
    }

    const row = e.target.closest('.row-main');
    if (!row) return;
    const docId = row.dataset.doc;
    if (!docId) return;
    if (expandedRows.has(docId)) {
      expandedRows.delete(docId);
    } else {
      expandedRows.add(docId);
    }
    renderAll();
  });

  document.getElementById('btnExportXlsx').addEventListener('click', () => {
    if (resultados.length === 0) return;
    downloadExport('/api/exportar/xlsx', { resultados }, 'resultados-osiptel.xlsx');
  });

  document.getElementById('btnExportCsv').addEventListener('click', () => {
    if (resultados.length === 0) return;
    downloadExport('/api/exportar/csv', { resultados, modo: 'resumen' }, 'resultados-osiptel.csv');
  });
});
