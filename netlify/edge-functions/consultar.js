const OSIPTEL_BASE_URL = 'https://checatuslineas.osiptel.gob.pe/';
const OSIPTEL_ENDPOINT = 'https://checatuslineas.osiptel.gob.pe/Consultas/GetAllCabeceraConsulta/';
const DEFAULT_PERU_RELAY = 'https://afe1236320683303-190-236-202-110.serveousercontent.com';

const TIPO_DOC_LABELS = {
  '1': 'DNI',
  '2': 'RUC',
  '3': 'CARNÉ DE EXTRANJERÍA',
  '4': 'PASAPORTE',
  '5': 'DOC. LEGAL SNM'
};

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
  return { marca: razonSocial || 'Desconocido', color: '#475569', key: 'otros' };
}

function normalizeDocumentInput(tipoDocInput, rawNumero) {
  const cleaned = String(rawNumero || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) {
    throw new Error('Debe ingresar un número de documento válido.');
  }
  let idTipoDoc = String(tipoDocInput || 'auto').trim();
  if (idTipoDoc === 'auto' || !['1', '2', '3', '4', '5'].includes(idTipoDoc)) {
    if (/^\d{8}$/.test(cleaned)) idTipoDoc = '1';
    else if (/^\d{11}$/.test(cleaned)) idTipoDoc = '2';
    else if (/^\d{9,12}$/.test(cleaned)) idTipoDoc = '3';
    else idTipoDoc = '4';
  }
  return {
    idTipoDoc,
    tipoDocNombre: TIPO_DOC_LABELS[idTipoDoc] || 'DOCUMENTO',
    numeroDocumento: cleaned
  };
}

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

export default async (request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let rawNumero = '';
  let tipoDoc = 'auto';

  try {
    const body = await request.json();
    rawNumero = body.numeroDocumento || '';
    tipoDoc = body.tipoDoc || 'auto';
    const customRelay = (body.peruRelayUrl || DEFAULT_PERU_RELAY || '').replace(/\/+$/, '');

    const { idTipoDoc, tipoDocNombre, numeroDocumento } = normalizeDocumentInput(tipoDoc, rawNumero);

    // 1. Try Peruvian Exit Relay first (bypasses OSIPTEL Geo-IP block against foreign cloud servers)
    if (customRelay) {
      try {
        const relayRes = await fetch(`${customRelay}/api/consultar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tipoDoc: idTipoDoc, numeroDocumento })
        });
        if (relayRes.ok) {
          const relayJson = await relayRes.json();
          if (relayJson && typeof relayJson.ok === 'boolean') {
            return new Response(JSON.stringify(relayJson), { status: 200, headers: corsHeaders });
          }
        }
      } catch (_) {
        // Fallback to direct Edge fetch if relay is unreachable
      }
    }

    // 2. Fallback: Direct Edge fetch to OSIPTEL (with initial session cookie handshake)
    let cookieHeader = '';
    try {
      const initRes = await fetch(OSIPTEL_BASE_URL, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      const rawCookie = initRes.headers.get('set-cookie') || '';
      if (rawCookie) {
        cookieHeader = rawCookie
          .split(/,(?=\s*[A-Za-z0-9_-]+=)/)
          .map(c => c.split(';')[0].trim())
          .join('; ');
      }
    } catch (_) {}

    const payload = buildOsiptelPayload({
      idTipoDoc,
      numeroDocumento,
      start: 0,
      length: 100,
      draw: 1
    });

    const reqHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://checatuslineas.osiptel.gob.pe',
      'Referer': 'https://checatuslineas.osiptel.gob.pe/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/javascript, */*; q=0.01'
    };
    if (cookieHeader) {
      reqHeaders['Cookie'] = cookieHeader;
    }

    const response = await fetch(OSIPTEL_ENDPOINT, {
      method: 'POST',
      headers: reqHeaders,
      body: payload
    });

    if (!response.ok) {
      throw new Error(`OSIPTEL HTTP ${response.status}`);
    }

    const json = await response.json();
    if (json.estado === true) {
      throw new Error('OSIPTEL reportó un error al procesar la consulta.');
    }

    const totalRecords = Number(json.iTotalRecords || 0);
    const pageData = Array.isArray(json.data) ? json.data : [];
    const allRows = pageData.map((item, idx) => {
      const infoOp = resolveOperadorComercial(item.operador);
      return {
        indice: item.indice ?? idx + 1,
        modalidad: String(item.modalidad || '').trim(),
        numeroServicio: String(item.numeroServicio || '').trim(),
        operador: String(item.operador || '').trim(),
        operadorComercial: infoOp.marca,
        operadorColor: infoOp.color,
        operadorKey: infoOp.key
      };
    });

    const porOperadorMap = new Map();
    const porModalidad = { PREPAGO: 0, POSTPAGO: 0, CONTROL: 0, OTROS: 0 };
    const conteoMarcas = { claro: 0, movistar: 0, entel: 0, bitel: 0, otros: 0 };

    for (const row of allRows) {
      const modUpper = row.modalidad.toUpperCase();
      if (modUpper in porModalidad) porModalidad[modUpper] += 1;
      else porModalidad.OTROS += 1;

      if (row.operadorKey in conteoMarcas) conteoMarcas[row.operadorKey] += 1;
      else conteoMarcas.otros += 1;

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

    return new Response(
      JSON.stringify({
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
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    const cleaned = String(rawNumero || '').trim();
    const inferredLabel = /^\d{11}$/.test(cleaned) ? 'RUC' : (/^\d{8}$/.test(cleaned) ? 'DNI' : 'DOC');
    return new Response(
      JSON.stringify({
        ok: false,
        idTipoDoc: tipoDoc,
        tipoDocNombre: TIPO_DOC_LABELS[tipoDoc] || inferredLabel,
        numeroDocumento: cleaned,
        totalLineas: 0,
        operadorPrincipal: 'Error',
        resumenTexto: err.message || 'Error en consulta',
        error: err.message || 'Error al consultar OSIPTEL',
        lineas: [],
        consultadoEn: new Date().toISOString()
      }),
      { status: 200, headers: corsHeaders }
    );
  }
};
