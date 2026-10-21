# Checa tus Líneas — Consulta OSIPTEL

Aplicación web minimalista en Node.js (cero dependencias externas) para consultar las líneas móviles y empresas operadoras registradas en **OSIPTEL (Checa tus líneas)** por **RUC**, **DNI**, **Carné de Extranjería** o **Pasaporte**.

## Características

- **Consulta individual y por lote:** Ingresa uno o varios RUCs/DNIs directamente en el buscador.
- **Carga directa de Excel (`.xlsx`), `.csv` o `.txt`:** Sube un archivo Excel con columna `RUC` y procesa automáticamente todas las filas respetando el límite de conexiones de OSIPTEL.
- **Razón Social Completa:** Muestra el nombre oficial registrado en OSIPTEL (`AMERICA MOVIL PERU S.A.C.`, `TELEFONICA DEL PERU S.A.A.`, `ENTEL PERU S.A.`, `VIETTEL PERU S.A.C.`, etc.) y el detalle de líneas por modalidad (`PREPAGO`, `POSTPAGO`, `CONTROL`).
- **Exportación a Excel (`.xlsx`) y CSV:** Genera un libro Excel de 2 hojas (`Resumen por Documento` y `Detalle de Lineas`) listo para abrir.

## Requisitos

- Node.js 18 o superior.

## Uso

```bash
npm start
```

Luego abre en el navegador:
`http://localhost:3000`
