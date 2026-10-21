const {
  consultarOsiptel,
  parseXlsxDocuments,
  buildExcelFromResultados,
  buildCsvBuffer,
  TIPO_DOC_LABELS
} = require('../../server');

exports.handler = async (event) => {
  try {
    const path = event.path || '';
    const method = event.httpMethod || 'GET';

    if (method !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ ok: false, error: 'Método no permitido' })
      };
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '{}');
    const body = rawBody ? JSON.parse(rawBody) : {};

    // POST /api/consultar
    if (path.endsWith('/consultar')) {
      const { tipoDoc = 'auto', numeroDocumento = '' } = body;
      try {
        const resultado = await consultarOsiptel(tipoDoc, numeroDocumento);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(resultado)
        };
      } catch (err) {
        const cleaned = String(numeroDocumento || '').trim();
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
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
          })
        };
      }
    }

    // POST /api/importar-excel
    if (path.endsWith('/importar-excel')) {
      const base64Data = String(body.fileBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!base64Data) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ ok: false, error: 'No se recibió contenido de archivo.' })
        };
      }
      const zipBuf = Buffer.from(base64Data, 'base64');
      const documentos = parseXlsxDocuments(zipBuf);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ ok: true, total: documentos.length, documentos })
      };
    }

    // POST /api/exportar/xlsx
    if (path.endsWith('/exportar/xlsx')) {
      const resultados = Array.isArray(body.resultados) ? body.resultados : [];
      const xlsxBuffer = buildExcelFromResultados(resultados);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="reporte-osiptel-${timestamp}.xlsx"`
        },
        body: xlsxBuffer.toString('base64')
      };
    }

    // POST /api/exportar/csv
    if (path.endsWith('/exportar/csv')) {
      const resultados = Array.isArray(body.resultados) ? body.resultados : [];
      const modo = body.modo === 'resumen' ? 'resumen' : 'detalle';
      const csvBuffer = buildCsvBuffer(resultados, modo);
      const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return {
        statusCode: 200,
        isBase64Encoded: true,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="reporte-osiptel-${modo}-${timestamp}.csv"`
        },
        body: csvBuffer.toString('base64')
      };
    }

    return {
      statusCode: 404,
      body: JSON.stringify({ ok: false, error: 'Ruta de API no encontrada' })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: false, error: err.message || 'Error interno' })
    };
  }
};
