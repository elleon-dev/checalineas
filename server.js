const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = process.env.PORT || 3000;
const OSIPTEL_BASE_URL = 'https://checatuslineas.osiptel.gob.pe/';
const OSIPTEL_ENDPOINT = 'https://checatuslineas.osiptel.gob.pe/Consultas/GetAllCabeceraConsulta/';

const osiptelAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 1,
  keepAliveMsecs: 15000,
  rejectUnauthorized: false
});

let sessionCookies = '';
let lastRequestTime = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureSessionCookies() {
  if (sessionCookies) return Promise.resolve(sessionCookies);
  return new Promise((resolve) => {
    const urlObj = new URL(OSIPTEL_BASE_URL);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'GET',
        agent: osiptelAgent,
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Connection': 'keep-alive'
        }
      },
      (res) => {
        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length > 0) {
          sessionCookies = setCookie.map((c) => c.split(';')[0]).join('; ');
        }
        res.resume();
        res.on('end', () => resolve(sessionCookies));
      }
    );
    req.on('error', () => resolve(''));
    req.setTimeout(10000, () => {
      req.destroy();
      resolve('');
    });
    req.end();
  });
}

function rawPostOsiptel(urlStr, formBody) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const bodyBuf = Buffer.from(formBody, 'utf8');

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Content-Length': bodyBuf.length,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://checatuslineas.osiptel.gob.pe',
      'Referer': 'https://checatuslineas.osiptel.gob.pe/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Connection': 'keep-alive'
    };
    if (sessionCookies) {
      headers['Cookie'] = sessionCookies;
    }

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        agent: osiptelAgent,
        rejectUnauthorized: false,
        headers
      },
      (res) => {
        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length > 0) {
          const newCookies = setCookie.map((c) => c.split(';')[0]).join('; ');
          if (!sessionCookies) sessionCookies = newCookies;
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawBuf = Buffer.concat(chunks);
          const text = rawBuf.toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`OSIPTEL respondió con estado HTTP ${res.statusCode}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error('Respuesta inválida de OSIPTEL'));
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('Tiempo de espera agotado al conectar con OSIPTEL'));
    });
    req.write(bodyBuf);
    req.end();
  });
}

function postOsiptelRequest(urlStr, formBody) {
  const runTask = async () => {
    const elapsed = Date.now() - lastRequestTime;
    const minInterval = 1400;
    if (elapsed < minInterval) {
      await sleep(minInterval - elapsed);
    }

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await ensureSessionCookies();
        lastRequestTime = Date.now();
        return await rawPostOsiptel(urlStr, formBody);
      } catch (err) {
        lastErr = err;
        sessionCookies = '';
        await sleep(1800 * attempt);
      }
    }
    throw lastErr;
  };

  const queued = requestQueue.then(runTask, runTask);
  requestQueue = queued.catch(() => {});
  return queued;
}

const TIPO_DOC_LABELS = {
  '1': 'DNI',
  '2': 'RUC',
  '3': 'CARNÉ DE EXTRANJERÍA',
  '4': 'PASAPORTE',
  '5': 'DOC. LEGAL SNM'
};

/**
 * Maps OSIPTEL legal company names to commercial brand names and brand colors.
 */
function resolveOperadorComercial(razonSocial = '') {
  const upper = String(razonSocial).toUpperCase().trim();
  if (upper.includes('AMERICA MOVIL') || upper.includes('CLARO')) {
    return { marca: 'Claro', color: '#da291c', key: 'claro' };
  }
  if (upper.includes('TELEFONICA') || upper.includes('MOVISTAR') || upper.includes('INTEGRATEL')) {
    return { marca: 'Movistar', color: '#019df4', key: 'movistar' };
  }
  if (upper.includes('ENTEL')) {
    return { marca: 'Entel', color: '#ff5900', key: 'entel' };
  }
  if (upper.includes('VIETTEL') || upper.includes('BITEL')) {
    return { marca: 'Bitel', color: '#00a896', key: 'bitel' };
  }
  if (upper.includes('FLASH') || upper.includes('LOGISTICA')) {
    return { marca: 'Flash Mobile', color: '#7c3aed', key: 'otros' };
  }
  if (upper.includes('GUINEA') || upper.includes('CUY')) {
    return { marca: 'Cuy / Guinea Mobile', color: '#db2777', key: 'otros' };
  }
  if (upper.includes('SUMA MOVIL')) {
    return { marca: 'Suma Móvil', color: '#2563eb', key: 'otros' };
  }
  if (upper.includes('DOLPHIN')) {
    return { marca: 'Dolphin Mobile', color: '#0891b2', key: 'otros' };
  }
  return { marca: razonSocial || 'Desconocido', color: '#475569', key: 'otros' };
}

/**
 * Automatically detects OSIPTEL document type if 'auto' is passed.
 */
function normalizeDocumentInput(tipoDocInput, rawNumero) {
  const cleaned = String(rawNumero || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) {
    throw new Error('Debe ingresar un número de documento válido.');
  }

  let idTipoDoc = String(tipoDocInput || 'auto').trim();
  if (idTipoDoc === 'auto' || !['1', '2', '3', '4', '5'].includes(idTipoDoc)) {
    if (/^\d{8}$/.test(cleaned)) {
      idTipoDoc = '1'; // DNI
    } else if (/^\d{11}$/.test(cleaned)) {
      idTipoDoc = '2'; // RUC
    } else if (/^\d{9,12}$/.test(cleaned)) {
      idTipoDoc = '3'; // Carné de Extranjería
    } else {
      idTipoDoc = '4'; // Pasaporte / Alfanumérico
    }
  }

  return {
    idTipoDoc,
    tipoDocNombre: TIPO_DOC_LABELS[idTipoDoc] || 'DOCUMENTO',
    numeroDocumento: cleaned
  };
}

/**
 * Builds the URL-encoded DataTables payload required by OSIPTEL's endpoint.
 */
function buildOsiptelPayload({ idTipoDoc, numeroDocumento, start = 0, length = 100, draw = 1 }) {
  const params = new URLSearchParams();
  const cols = ['indice', 'modalidad', 'numeroServicio', 'operador'];

  params.set('draw', String(draw));
  cols.forEach((col, i) => {
    params.set(`columns[${i}][data]`, col);
    params.set(`columns[${i}][name]`, col);
    params.set(`columns[${i}][searchable]`, 'false');
    params.set(`columns[${i}][orderable]`, 'false');
    params.set(`columns[${i}][search][value]`, '');
    params.set(`columns[${i}][search][regex]`, 'false');
  });
  params.set('order[0][column]', '0');
  params.set('order[0][dir]', 'asc');
  params.set('start', String(start));
  params.set('length', String(length));
  params.set('search[value]', '');
  params.set('search[regex]', 'false');
  params.set('IdTipoDoc', String(idTipoDoc));
  params.set('NumeroDocumento', String(numeroDocumento));
  params.set('HCaptchaTokenCon', 'dummy');
  params.set('BoolConsulta', 'true');

  return params.toString();
}

/**
 * Queries OSIPTEL Checa Tus Líneas for a given document and paginates if needed.
 */
async function consultarOsiptel(tipoDocInput, rawNumero) {
  const { idTipoDoc, tipoDocNombre, numeroDocumento } = normalizeDocumentInput(tipoDocInput, rawNumero);

  const pageSize = 100;
  let start = 0;
  let draw = 1;
  let totalRecords = 0;
  const allRows = [];

  while (true) {
    const body = buildOsiptelPayload({
      idTipoDoc,
      numeroDocumento,
      start,
      length: pageSize,
      draw
    });

    const json = await postOsiptelRequest(OSIPTEL_ENDPOINT, body);

    if (json.estado === true) {
      throw new Error('OSIPTEL reportó un error al procesar la consulta. Intente nuevamente.');
    }

    totalRecords = Number(json.iTotalRecords || 0);
    const pageData = Array.isArray(json.data) ? json.data : [];

    for (const item of pageData) {
      const infoOp = resolveOperadorComercial(item.operador);
      allRows.push({
        indice: item.indice ?? allRows.length + 1,
        modalidad: String(item.modalidad || '').trim(),
        numeroServicio: String(item.numeroServicio || '').trim(),
        operador: String(item.operador || '').trim(),
        operadorComercial: infoOp.marca,
        operadorColor: infoOp.color,
        operadorKey: infoOp.key
      });
    }

    if (allRows.length >= totalRecords || pageData.length < pageSize || draw >= 25) {
      break;
    }

    start += pageSize;
    draw += 1;
  }

  // Summarize by operator and modality
  const porOperadorMap = new Map();
  const porModalidad = {
    PREPAGO: 0,
    POSTPAGO: 0,
    CONTROL: 0,
    OTROS: 0
  };
  const conteoMarcas = {
    claro: 0,
    movistar: 0,
    entel: 0,
    bitel: 0,
    otros: 0
  };

  for (const row of allRows) {
    const modUpper = row.modalidad.toUpperCase();
    if (modUpper in porModalidad) {
      porModalidad[modUpper] += 1;
    } else {
      porModalidad.OTROS += 1;
    }

    if (row.operadorKey in conteoMarcas) {
      conteoMarcas[row.operadorKey] += 1;
    } else {
      conteoMarcas.otros += 1;
    }

    const existing = porOperadorMap.get(row.operador) || {
      operador: row.operador,
      operadorComercial: row.operadorComercial,
      color: row.operadorColor,
      total: 0,
      prepago: 0,
      postpago: 0,
      control: 0
    };
    existing.total += 1;
    if (modUpper === 'PREPAGO') existing.prepago += 1;
    else if (modUpper === 'POSTPAGO') existing.postpago += 1;
    else if (modUpper === 'CONTROL') existing.control += 1;
    porOperadorMap.set(row.operador, existing);
  }

  const operadoresResumen = Array.from(porOperadorMap.values()).sort((a, b) => b.total - a.total);
  const resumenTexto = operadoresResumen.length > 0
    ? operadoresResumen.map(op => `${op.operador} (${op.total})`).join(', ')
    : 'Sin líneas registradas';

  const operadorPrincipal = operadoresResumen.length > 0 ? operadoresResumen[0].operador : 'Ninguno';

  return {
    ok: true,
    idTipoDoc,
    tipoDocNombre,
    numeroDocumento,
    totalLineas: totalRecords || allRows.length,
    operadorPrincipal,
    resumenTexto,
    conteoMarcas,
    porModalidad,
    operadoresResumen,
    lineas: allRows,
    consultadoEn: new Date().toISOString()
  };
}

/* ============================================================================
   NATIVE .XLSX (OpenXML ZIP) GENERATOR (Zero external dependencies)
============================================================================ */

function escapeXml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnLetter(colIndex) {
  let temp;
  let letter = '';
  let idx = colIndex + 1;
  while (idx > 0) {
    temp = (idx - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    idx = (idx - temp - 1) / 26;
  }
  return letter;
}

function buildWorksheetXml(headers, rows, colWidths = []) {
  const colsXml = headers.map((h, idx) => {
    const width = colWidths[idx] || Math.max(String(h).length + 5, 14);
    return `<col min="${idx + 1}" max="${idx + 1}" width="${width}" customWidth="1"/>`;
  }).join('');

  let sheetDataXml = '';

  // Header row (row 1, style s="1")
  const headerCells = headers.map((h, cIdx) => {
    const ref = `${columnLetter(cIdx)}1`;
    return `<c r="${ref}" s="1" t="inlineStr"><is><t>${escapeXml(h)}</t></is></c>`;
  }).join('');
  sheetDataXml += `<row r="1" ht="24" customHeight="1">${headerCells}</row>`;

  // Data rows
  rows.forEach((row, rIdx) => {
    const rowNum = rIdx + 2;
    const cells = headers.map((_, cIdx) => {
      const ref = `${columnLetter(cIdx)}${rowNum}`;
      const val = row[cIdx];
      if (typeof val === 'number' && Number.isFinite(val)) {
        return `<c r="${ref}" s="2"><v>${val}</v></c>`;
      }
      return `<c r="${ref}" s="2" t="inlineStr"><is><t>${escapeXml(val ?? '')}</t></is></c>`;
    }).join('');
    sheetDataXml += `<row r="${rowNum}" ht="19">${cells}</row>`;
  });

  const lastCol = columnLetter(Math.max(headers.length - 1, 0));
  const lastRow = rows.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastCol}${lastRow}"/>
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${colsXml}</cols>
  <sheetData>${sheetDataXml}</sheetData>
  <autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`;
}

/**
 * Packs an array of { name: 'path/in/zip', data: Buffer|string } into a valid ZIP Buffer.
 */
function createZipArchive(files) {
  const localFileParts = [];
  const centralDirParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedBuf = Buffer.isBuffer(file.data)
      ? file.data
      : Buffer.from(String(file.data), 'utf8');

    const crc = zlib.crc32(uncompressedBuf);
    const compressedBuf = zlib.deflateRawSync(uncompressedBuf);

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed
    localHeader.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    localHeader.writeUInt16LE(8, 8);          // compression method: deflate (8)
    localHeader.writeUInt16LE(0, 10);         // mod time
    localHeader.writeUInt16LE(0x554b, 12);    // mod date
    localHeader.writeUInt32LE(crc >>> 0, 14); // crc32
    localHeader.writeUInt32LE(compressedBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(uncompressedBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);         // extra field length

    localFileParts.push(localHeader, nameBuf, compressedBuf);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);         // version made by
    centralHeader.writeUInt16LE(20, 6);         // version needed
    centralHeader.writeUInt16LE(0x0800, 8);     // UTF-8 flag
    centralHeader.writeUInt16LE(8, 10);         // compression method: deflate
    centralHeader.writeUInt16LE(0, 12);         // mod time
    centralHeader.writeUInt16LE(0x554b, 14);    // mod date
    centralHeader.writeUInt32LE(crc >>> 0, 16); // crc32
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(uncompressedBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset

    centralDirParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralDirBuffer = Buffer.concat(centralDirParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localFileParts, centralDirBuffer, eocd]);
}

/**
 * Reads an .xlsx ZIP buffer and extracts all valid RUC / DNI / Document values.
 */
function parseXlsxDocuments(zipBuf) {
  const entries = new Map();

  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65557); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('El archivo no es un libro Excel (.xlsx) válido.');
  }

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  let cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < totalEntries && cdOffset + 46 <= zipBuf.length; i++) {
    const sig = zipBuf.readUInt32LE(cdOffset);
    if (sig !== 0x02014b50) break;

    const compressionMethod = zipBuf.readUInt16LE(cdOffset + 10);
    const compressedSize = zipBuf.readUInt32LE(cdOffset + 20);
    const fileNameLen = zipBuf.readUInt16LE(cdOffset + 28);
    const extraLen = zipBuf.readUInt16LE(cdOffset + 30);
    const commentLen = zipBuf.readUInt16LE(cdOffset + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(cdOffset + 42);

    const fileName = zipBuf.subarray(cdOffset + 46, cdOffset + 46 + fileNameLen).toString('utf8');

    if (
      (fileName === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(fileName)) &&
      localHeaderOffset + 30 <= zipBuf.length
    ) {
      const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const compressedSlice = zipBuf.subarray(dataStart, dataStart + compressedSize);

      let contentBuf;
      if (compressionMethod === 0) {
        contentBuf = compressedSlice;
      } else if (compressionMethod === 8) {
        contentBuf = zlib.inflateRawSync(compressedSlice);
      }

      if (contentBuf) {
        entries.set(fileName, contentBuf.toString('utf8'));
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

  // Parse sharedStrings.xml if present
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

  // Extract cell values from all worksheets
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
          const idx = parseInt(vMatch[1].trim(), 10);
          val = sharedStrings[idx] ?? '';
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

/**
 * Generates a complete 2-sheet Excel (.xlsx) workbook from an array of consultation results.
 * Column A starts with RUC / N° Documento to match PRUEBA BOT.xlsx format.
 */
function buildExcelFromResultados(resultados = []) {
  const resumenHeaders = [
    'RUC',
    'Tipo Documento',
    'Empresa Operadora (Completa)',
    'Empresa Operadora Principal',
    'Total Líneas',
    'AMERICA MOVIL PERU S.A.C. (Claro)',
    'TELEFONICA DEL PERU S.A.A. (Movistar)',
    'ENTEL PERU S.A. (Entel)',
    'VIETTEL PERU S.A.C. (Bitel)',
    'Otros Operadores',
    'Prepago',
    'Postpago',
    'Control',
    'Números Telefónicos',
    'Estado Consulta',
    'Fecha Consulta'
  ];

  const resumenColWidths = [16, 16, 46, 34, 14, 28, 30, 24, 24, 16, 11, 11, 11, 44, 16, 22];

  const resumenRows = resultados.map(item => {
    const opsFullText = Array.isArray(item.operadoresResumen) && item.operadoresResumen.length > 0
      ? item.operadoresResumen.map(op => `${op.operador} (${op.total})`).join(', ')
      : (item.resumenTexto || 'Sin líneas registradas');

    const opPrincipalFull = Array.isArray(item.operadoresResumen) && item.operadoresResumen.length > 0
      ? item.operadoresResumen[0].operador
      : (item.operadorPrincipal || 'Ninguno');

    const telefonosLista = Array.isArray(item.lineas) && item.lineas.length > 0
      ? item.lineas.map(l => `${l.numeroServicio} (${l.operador})`).join(', ')
      : '-';

    if (!item.ok) {
      return [
        item.numeroDocumento || '',
        item.tipoDocNombre || 'DOCUMENTO',
        item.error || 'Error en consulta',
        'Error',
        0,
        0, 0, 0, 0, 0,
        0, 0, 0,
        '-',
        'ERROR',
        item.consultadoEn ? new Date(item.consultadoEn).toLocaleString('es-PE') : ''
      ];
    }
    return [
      item.numeroDocumento,
      item.tipoDocNombre,
      opsFullText,
      opPrincipalFull,
      Number(item.totalLineas || 0),
      Number(item.conteoMarcas?.claro || 0),
      Number(item.conteoMarcas?.movistar || 0),
      Number(item.conteoMarcas?.entel || 0),
      Number(item.conteoMarcas?.bitel || 0),
      Number(item.conteoMarcas?.otros || 0),
      Number(item.porModalidad?.PREPAGO || 0),
      Number(item.porModalidad?.POSTPAGO || 0),
      Number(item.porModalidad?.CONTROL || 0),
      telefonosLista,
      item.totalLineas > 0 ? 'CON LÍNEAS' : 'SIN LÍNEAS',
      item.consultadoEn ? new Date(item.consultadoEn).toLocaleString('es-PE') : ''
    ];
  });

  const detalleHeaders = [
    'RUC',
    'Tipo Documento',
    'Item',
    'Número Telefónico',
    'Modalidad',
    'Operador Comercial',
    'Empresa Operadora (Razón Social)',
    'Fecha Consulta'
  ];

  const detalleColWidths = [16, 16, 10, 20, 16, 22, 36, 22];
  const detalleRows = [];

  for (const item of resultados) {
    const fechaStr = item.consultadoEn ? new Date(item.consultadoEn).toLocaleString('es-PE') : '';
    if (item.ok && Array.isArray(item.lineas) && item.lineas.length > 0) {
      for (const linea of item.lineas) {
        detalleRows.push([
          item.numeroDocumento,
          item.tipoDocNombre,
          Number(linea.indice || 1),
          linea.numeroServicio,
          linea.modalidad,
          linea.operadorComercial,
          linea.operador,
          fechaStr
        ]);
      }
    } else {
      detalleRows.push([
        item.numeroDocumento || '',
        item.tipoDocNombre || 'DOCUMENTO',
        0,
        '-',
        '-',
        item.ok ? 'Sin líneas' : 'Error',
        item.ok ? 'No se encontraron líneas registradas' : (item.error || 'Error en consulta'),
        fechaStr
      ]);
    }
  }

  const sheet1Xml = buildWorksheetXml(resumenHeaders, resumenRows, resumenColWidths);
  const sheet2Xml = buildWorksheetXml(detalleHeaders, detalleRows, detalleColWidths);

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Resumen por Documento" sheetId="1" r:id="rId1"/>
    <sheet name="Detalle de Lineas" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><color rgb="FF1E293B"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F2942"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center" horizontal="center"/>
    </xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment vertical="center"/>
    </xf>
  </cellXfs>
</styleSheet>`;

  return createZipArchive([
    { name: '[Content_Types].xml', data: contentTypesXml },
    { name: '_rels/.rels', data: relsXml },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
    { name: 'xl/styles.xml', data: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
    { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml }
  ]);
}

function buildCsvBuffer(resultados = [], modo = 'detalle') {
  const escapeCsvField = (val) => {
    const str = String(val ?? '');
    if (/[",\n\r;]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];

  if (modo === 'resumen') {
    const headers = [
      'Tipo Documento',
      'N° Documento',
      'Total Líneas',
      'Operador Principal',
      'Resumen de Operadores',
      'Claro',
      'Movistar',
      'Entel',
      'Bitel',
      'Otros Operadores',
      'Prepago',
      'Postpago',
      'Control',
      'Estado Consulta',
      'Fecha Consulta'
    ];
    lines.push(headers.map(escapeCsvField).join(','));

    for (const item of resultados) {
      const row = [
        item.tipoDocNombre || 'DOCUMENTO',
        item.numeroDocumento || '',
        item.totalLineas || 0,
        item.operadorPrincipal || 'Ninguno',
        item.resumenTexto || (item.error || 'Sin líneas'),
        item.conteoMarcas?.claro || 0,
        item.conteoMarcas?.movistar || 0,
        item.conteoMarcas?.entel || 0,
        item.conteoMarcas?.bitel || 0,
        item.conteoMarcas?.otros || 0,
        item.porModalidad?.PREPAGO || 0,
        item.porModalidad?.POSTPAGO || 0,
        item.porModalidad?.CONTROL || 0,
        item.ok ? (item.totalLineas > 0 ? 'CON LÍNEAS' : 'SIN LÍNEAS') : 'ERROR',
        item.consultadoEn ? new Date(item.consultadoEn).toLocaleString('es-PE') : ''
      ];
      lines.push(row.map(escapeCsvField).join(','));
    }
  } else {
    const headers = [
      'Tipo Documento',
      'N° Documento',
      'Item',
      'Número Telefónico',
      'Modalidad',
      'Operador Comercial',
      'Empresa Operadora (Razón Social)',
      'Fecha Consulta'
    ];
    lines.push(headers.map(escapeCsvField).join(','));

    for (const item of resultados) {
      const fechaStr = item.consultadoEn ? new Date(item.consultadoEn).toLocaleString('es-PE') : '';
      if (item.ok && Array.isArray(item.lineas) && item.lineas.length > 0) {
        for (const linea of item.lineas) {
          lines.push([
            item.tipoDocNombre,
            item.numeroDocumento,
            linea.indice,
            linea.numeroServicio,
            linea.modalidad,
            linea.operadorComercial,
            linea.operador,
            fechaStr
          ].map(escapeCsvField).join(','));
        }
      } else {
        lines.push([
          item.tipoDocNombre || 'DOCUMENTO',
          item.numeroDocumento || '',
          0,
          '-',
          '-',
          item.ok ? 'Sin líneas' : 'Error',
          item.ok ? 'No se encontraron líneas registradas' : (item.error || 'Error en consulta'),
          fechaStr
        ].map(escapeCsvField).join(','));
      }
    }
  }

  // Prepend UTF-8 BOM so Excel opens Spanish characters cleanly
  return Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
}

/* ============================================================================
   HTTP SERVER & ROUTES
============================================================================ */

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > 25 * 1024 * 1024) {
        reject(new Error('Payload demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // API: Single query
    if (req.method === 'POST' && pathname === '/api/consultar') {
      const body = await readJsonBody(req);
      const { tipoDoc = 'auto', numeroDocumento = '' } = body;

      try {
        const resultado = await consultarOsiptel(tipoDoc, numeroDocumento);
        return sendJson(res, 200, resultado);
      } catch (err) {
        const cleaned = String(numeroDocumento || '').trim();
        return sendJson(res, 200, {
          ok: false,
          idTipoDoc: tipoDoc,
          tipoDocNombre: TIPO_DOC_LABELS[tipoDoc] || 'DOCUMENTO',
          numeroDocumento: cleaned,
          totalLineas: 0,
          operadorPrincipal: 'Error',
          resumenTexto: err.message || 'Error en la consulta',
          error: err.message || 'Error al consultar OSIPTEL',
          lineas: [],
          consultadoEn: new Date().toISOString()
        });
      }
    }

    // API: Import RUCs / DNIs from an Excel (.xlsx) file
    if (req.method === 'POST' && pathname === '/api/importar-excel') {
      const body = await readJsonBody(req);
      const base64Data = String(body.fileBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!base64Data) {
        return sendJson(res, 400, { ok: false, error: 'No se recibió contenido de archivo.' });
      }
      const zipBuf = Buffer.from(base64Data, 'base64');
      const documentos = parseXlsxDocuments(zipBuf);
      return sendJson(res, 200, { ok: true, total: documentos.length, documentos });
    }

    // API: Export to Excel (.xlsx)
    if (req.method === 'POST' && pathname === '/api/exportar/xlsx') {
      const body = await readJsonBody(req);
      const resultados = Array.isArray(body.resultados) ? body.resultados : [];
      const xlsxBuffer = buildExcelFromResultados(resultados);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="reporte-osiptel-${timestamp}.xlsx"`,
        'Content-Length': xlsxBuffer.length
      });
      return res.end(xlsxBuffer);
    }

    // API: Export to CSV (.csv)
    if (req.method === 'POST' && pathname === '/api/exportar/csv') {
      const body = await readJsonBody(req);
      const resultados = Array.isArray(body.resultados) ? body.resultados : [];
      const modo = body.modo === 'resumen' ? 'resumen' : 'detalle';
      const csvBuffer = buildCsvBuffer(resultados, modo);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="reporte-osiptel-${modo}-${timestamp}.csv"`,
        'Content-Length': csvBuffer.length
      });
      return res.end(csvBuffer);
    }

    // Serve static frontend files from ./public
    if (req.method === 'GET' || req.method === 'HEAD') {
      const safePath = pathname === '/' ? '/index.html' : pathname;
      const filePath = path.join(__dirname, 'public', path.normalize(safePath));

      if (!filePath.startsWith(path.join(__dirname, 'public'))) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': content.length
        });
        return res.end(content);
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Ruta no encontrada');
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { ok: false, error: err.message || 'Error interno del servidor' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`==========================================================`);
    console.log(`🚀 Servidor Consulta OSIPTEL corriendo en: http://localhost:${PORT}`);
    console.log(`==========================================================`);
  });
}

module.exports = {
  consultarOsiptel,
  parseXlsxDocuments,
  buildExcelFromResultados,
  buildCsvBuffer,
  TIPO_DOC_LABELS
};

