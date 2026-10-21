const STORAGE_KEY = 'osiptel_consultas_historial_v1';

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

    try {
      const res = await fetch('/api/consultar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipoDoc: 'auto', numeroDocumento: doc })
      }).then(r => r.json());

      if (docs.length === 1 && res.totalLineas > 0) {
        expandedRows.add(res.numeroDocumento);
      }

      upsertResultado(res);
    } catch (err) {
      upsertResultado({
        ok: false,
        tipoDocNombre: 'DOC',
        numeroDocumento: doc,
        totalLineas: 0,
        error: err.message
      });
    }

    done += 1;
    progressFill.style.width = `${Math.round((done / docs.length) * 100)}%`;
  }

  isRunning = false;
  btnConsultar.disabled = false;
  progressSection.classList.add('hidden');
}

async function downloadExport(endpoint, payload, fallbackName) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Error al generar archivo');
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
  } catch (err) {
    alert(err.message);
  }
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
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('No se pudo leer el archivo'));
          reader.readAsDataURL(file);
        });
        const res = await fetch('/api/importar-excel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileBase64: base64 })
        }).then(r => r.json());

        if (!res.ok) throw new Error(res.error || 'Archivo Excel inválido');
        docs = res.documentos || [];
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

  // Clear list buttons (header + summary bar)
  document.getElementById('btnLimpiarTodo').addEventListener('click', limpiarListaCompleta);
  document.getElementById('btnLimpiarSecundario').addEventListener('click', limpiarListaCompleta);

  document.getElementById('inputFiltroTabla').addEventListener('input', renderAll);

  // Row click to expand/collapse or remove individual row
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
