// Vercel Serverless Handler
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir archivos estaticos
app.use(express.static(path.join(__dirname, '..', 'public')));

// ============================================
// BASE DE DATOS EN MEMORIA (Vercel serverless no tiene FS persistente)
// ============================================
let consultas = [];
let contador = 0;

function generarFolio() {
  const fecha = new Date();
  const anio = fecha.getFullYear();
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  contador++;
  return `GIV-${anio}${mes}-${String(contador).padStart(5, '0')}`;
}

// ============================================
// REPUVE SCRAPER
// ============================================
async function consultarRepuve(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const http = require('http');

  try {
    const postBody = `placa=${placaLimpia}&pageSource=index.jsp`;

    const html = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'www2.repuve.gob.mx',
        port: 8080,
        path: '/ciudadania/servletconsulta',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-MX,es;q=0.9',
          'Referer': 'http://www2.repuve.gob.mx:8080/ciudadania/index.jsp'
        },
        rejectUnauthorized: false,
        timeout: 15000
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postBody);
      req.end();
    });

    if (html.includes('Error 503') || html.includes('Service Unavailable')) {
      return {
        placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
        estatusRobo: 'SERVICIO_DISPONIBLE',
        error: 'REPUVE no disponible desde este servidor. Se realizara manualmente al procesar tu servicio.',
        datos: null
      };
    }

    const tieneRobo = html.includes('REPORTE DE ROBO') || html.includes('reporte de robo');
    const sinRobo = html.includes('SIN REPORTE DE ROBO') || html.includes('Sin reporte de robo');
    const datos = extraerDatosRepuve(html);

    return {
      placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
      estatusRobo: sinRobo ? 'SIN REPORTE' : (tieneRobo ? 'CON REPORTE DE ROBO' : 'NO VERIFICABLE'),
      datos: datos
    };
  } catch (error) {
    return {
      placa: placaLimpia, fuente: 'REPUVE', fechaConsulta: new Date().toISOString(),
      estatusRobo: 'ERROR', error: error.message, datos: null
    };
  }
}

function extraerDatosRepuve(html) {
  const datos = {};
  
  if (html.includes('SIN REPORTE DE ROBO')) datos.estatusRobo = 'SIN REPORTE';
  else if (html.includes('REPORTE DE ROBO')) datos.estatusRobo = 'CON REPORTE DE ROBO';
  else datos.estatusRobo = 'NO VERIFICABLE';

  function extraer(etiquetas) {
    for (const etiqueta of etiquetas) {
      const regex1 = new RegExp(etiqueta + '[^<]*</td>\\s*<td[^>]*>([^<]+)', 'i');
      const m1 = html.match(regex1);
      if (m1) return m1[1].trim();
      const regex2 = new RegExp(etiqueta + '[:\\s]+([A-Za-z0-9\\s\\-\\./\\(\\)#,]+)', 'i');
      const m2 = html.match(regex2);
      if (m2 && m2[1].trim().length > 1) return m2[1].trim();
    }
    return null;
  }

  const campos = [
    ['marca', ['Marca']], ['modelo', ['Modelo']], ['anio', ['Año Modelo', 'ANO MODELO']],
    ['niv', ['NIV', 'Numero de Identificacion Vehicular']], ['clase', ['Clase']],
    ['tipo', ['Tipo']], ['placa', ['Placa']], ['entidad', ['Entidad que emplaco', 'Entidad']],
    ['puertas', ['Numero de puertas']], ['pais_origen', ['Pais de origen']],
    ['version', ['Version']], ['cilindros', ['Numero de cilindros']],
    ['planta_ensamble', ['Planta de ensamble']], ['institucion', ['Institucion que lo inscribio']],
    ['fecha_inscripcion', ['Fecha de inscripcion']], ['fecha_emplacado', ['Fecha de emplacado']],
    ['folio_constancia', ['Folio de Constancia']], ['observaciones', ['Observaciones']]
  ];

  for (const [key, etiquetas] of campos) {
    const val = extraer(etiquetas);
    if (val) datos[key] = val;
  }

  return Object.keys(datos).length > 1 ? datos : { estatusRobo: datos.estatusRobo };
}

// ============================================
// ADEUDOS CDMX
// ============================================
async function consultarAdeudosCDMX(placa) {
  const placaLimpia = placa.toUpperCase().replace(/[^A-Z0-9]/g, '');
  try {
    const https = require('https');
    const postData = `placa=${placaLimpia}`;

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'data.finanzas.cdmx.gob.mx', port: 443, path: '/consulta_adeudos',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
        rejectUnauthorized: false, timeout: 15000
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postData);
      req.end();
    });

    return {
      placa: placaLimpia, fuente: 'Finanzas CDMX', fechaConsulta: new Date().toISOString(),
      adeudos: { infracciones: [], tenencia: [], total: 0, filas: [] },
      tieneAdeudos: false, totalAdeudos: 0
    };
  } catch (error) {
    return {
      placa: placaLimpia, fuente: 'Finanzas CDMX', fechaConsulta: new Date().toISOString(),
      error: error.message, adeudos: null, tieneAdeudos: false, totalAdeudos: 0
    };
  }
}

// ============================================
// COTIZACION
// ============================================
function cotizarServicio(repuve, adeudos) {
  const PRECIO = 700;
  let adeudosTotal = 0;
  if (adeudos.tieneAdeudos && adeudos.adeudos) adeudosTotal = adeudos.adeudos.total || 0;

  if (repuve.estatusRobo === 'CON REPORTE DE ROBO') {
    return { verificable: false, mensaje: 'Vehiculo con reporte de robo activo.', cotizacion_servicio: null };
  }

  const bloqueado = repuve.estatusRobo === 'SERVICIO_DISPONIBLE';
  const total = PRECIO + adeudosTotal;

  return {
    verificable: true,
    repuve_bloqueado: bloqueado,
    mensaje: adeudosTotal > 0 ? `Verificable. $${adeudosTotal.toFixed(2)} MXN en adeudos.` : 'Verificable. Sin adeudos.',
    cotizacion_servicio: {
      disponible: true,
      desglose: { servicio_verificacion: PRECIO, adeudos_a_pagar: adeudosTotal, total: total },
      resumen: adeudosTotal > 0 ? `Verificacion + adeudos: $${total.toFixed(2)} MXN` : `Verificacion: $${PRECIO.toFixed(2)} MXN`,
      nota: bloqueado ? 'El servicio incluye consulta REPUVE completa.' : null
    }
  };
}

// ============================================
// ENDPOINTS
// ============================================

app.post('/api/verificacion-completa', async (req, res) => {
  const { placa } = req.body;
  if (!placa || placa.length < 3) return res.status(400).json({ error: 'Placa invalida' });

  const [repuve, adeudos] = await Promise.all([
    consultarRepuve(placa),
    consultarAdeudosCDMX(placa)
  ]);

  const cotizacion = cotizarServicio(repuve, adeudos);
  const folio = generarFolio();

  const resultado = {
    success: true, placa: placa.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    repuve, adeudos, cotizacion, folio,
    timestamp: new Date().toISOString()
  };

  consultas.unshift({ folio, fecha: new Date().toISOString(), placa: resultado.placa, cotizacion: cotizacion.cotizacion_servicio?.total || 0 });
  if (consultas.length > 1000) consultas = consultas.slice(0, 1000);

  res.json(resultado);
});

app.get('/api/repuve/:placa', async (req, res) => {
  const resultado = await consultarRepuve(req.params.placa);
  res.json(resultado);
});

app.get('/api/adeudos/:placa', async (req, res) => {
  const resultado = await consultarAdeudosCDMX(req.params.placa);
  res.json(resultado);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/estadisticas', (req, res) => {
  res.json({ total_consultas: consultas.length, consultas_hoy: consultas.filter(c => c.fecha.startsWith(new Date().toISOString().split('T')[0])).length });
});

// Ruta por defecto - servir index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

module.exports = app;
