import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process';
import { 
  generateInvoice, 
  generateInvoiceXml, 
  signXml
} from 'open-factura';

// --- HACK Fetch (Necesario para Node) ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
global.fetch = fetch;
// ---------------------------------------

const SRI_URLS = {
    test: {
        recepcion: "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl",
        autorizacion: "https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"
    },
    production: {
        recepcion: "https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl",
        autorizacion: "https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl"
    }
};

// --- FUNCIÓN DE REPARACIÓN (Solo se usa si la original falla) ---
async function repararFirma(bufferFirma, password) {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    const inputPath = `/tmp/in_${id}.p12`;
    const outputPath = `/tmp/out_${id}.p12`;

    try {
        fs.writeFileSync(inputPath, bufferFirma);
        
        await new Promise((resolve, reject) => {
            const p1 = spawn('openssl', ['pkcs12', '-in', inputPath, '-legacy', '-provider', 'default', '-nodes', '-passin', `pass:${password}`]);
            const p2 = spawn('openssl', ['pkcs12', '-export', '-out', outputPath, '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-passout', `pass:${password}`]);
            
            p1.stdout.pipe(p2.stdin);
            
            let errLog = "";
            p2.stderr.on('data', d => errLog += d);
            p2.on('close', (code) => { 
                if (code === 0) resolve(); 
                else reject(new Error(`OpenSSL error: ${errLog}`)); 
            });
        });
        
        return fs.readFileSync(outputPath);

    } catch (error) {
        console.error(`⚠️ Falló reparación (ID ${id}):`, error.message);
        return null; 
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
}

// --- FUNCIONES SOAP SRI ---
async function recibirSRI(xmlFirmado, url) {
    const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion"><soapenv:Header/><soapenv:Body><ec:validarComprobante><xml>${Buffer.from(xmlFirmado).toString('base64')}</xml></ec:validarComprobante></soapenv:Body></soapenv:Envelope>`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
    return response.text();
}

async function autorizarSRI(claveAcceso, url) {
    const soapBody = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion"><soapenv:Header/><soapenv:Body><ec:autorizacionComprobante><claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante></ec:autorizacionComprobante></soapenv:Body></soapenv:Envelope>`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
    return response.text();
}

const app = express();
app.use(express.json({ limit: '50mb' }));
const PORT = process.env.PORT || 3000;

//==============
// RUTA 2: EMITIR FACTURA (MODO SAAS MEJORADO)
// ==========================================
app.post('/emitir-factura', async (req, res) => {
  try {
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    // VALIDACIÓN 1: Credenciales
    if (!firmaP12 || !passwordFirma) {
        return res.status(400).json({ error: "Faltan credenciales: 'firmaP12' y 'passwordFirma'." });
    }

    // VALIDACIÓN 2: Estructura de datos
    if (!datosFactura.infoTributaria || !datosFactura.infoFactura || !datosFactura.detalles) {
        return res.status(400).json({ 
            error: "Estructura de datos incompleta. Se requiere: infoTributaria, infoFactura y detalles.",
            receivedKeys: Object.keys(datosFactura)
        });
    }

    // VALIDACIÓN 3: totalConImpuestos es OBLIGATORIO
    if (!datosFactura.infoFactura.totalConImpuestos) {
        return res.status(400).json({
            error: "Campo obligatorio faltante: infoFactura.totalConImpuestos",
            hint: "Debe incluir el array totalConImpuestos con la estructura correcta"
        });
    }

    console.log("📄 Datos recibidos:");
    console.log("- RUC:", datosFactura.infoTributaria?.ruc);
    console.log("- Ambiente:", datosFactura.infoTributaria?.ambiente);
    console.log("- Detalles:", datosFactura.detalles?.length, "items");

    // 1. LIMPIEZA
    let firmaLimpia = firmaP12.includes(",") ? firmaP12.split(",")[1] : firmaP12;
    firmaLimpia = firmaLimpia.replace(/\s/g, ''); 
    const bufferOriginal = Buffer.from(firmaLimpia, 'base64');

    // 2. GENERAR XML
    const ambiente = datosFactura.infoTributaria.ambiente; 
    const URL_RECEPCION = ambiente === "2" ? SRI_URLS.production.recepcion : SRI_URLS.test.recepcion;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_URLS.production.autorizacion : SRI_URLS.test.autorizacion;
    
    console.log("🔧 Generando factura...");
    let invoice, accessKey;
    
    try {
        const result = generateInvoice(datosFactura);
        invoice = result.invoice;
        accessKey = result.accessKey;
        console.log("✅ Factura generada. Clave:", accessKey);
    } catch (error) {
        console.error("❌ Error en generateInvoice:", error.message);
        console.error("Stack completo:", error.stack);
        return res.status(400).json({ 
            error: "Error generando factura", 
            detalle: error.message,
            sugerencia: "Verifique la estructura del JSON según la ficha técnica del SRI"
        });
    }

    const xmlSinFirmar = generateInvoiceXml(invoice);

    // 3. FIRMADO INTELIGENTE
    let xmlFirmado;
    
    try {
        console.log("🔒 Intentando firmar con archivo original...");
        xmlFirmado = await signXml(bufferOriginal, passwordFirma, xmlSinFirmar);
        console.log("✅ Firmado exitoso.");
    } catch (errorOriginal) {
        console.warn("⚠️ Falló firma original:", errorOriginal.message);
        
        if (errorOriginal.message.includes("Invalid password") || errorOriginal.message.includes("MAC")) {
            throw new Error("Contraseña de firma incorrecta.");
        }

        console.log("🔧 Intentando reparar firma...");
        const bufferReparado = await repararFirma(bufferOriginal, passwordFirma);
        
        if (bufferReparado) {
            xmlFirmado = await signXml(bufferReparado, passwordFirma, xmlSinFirmar);
            console.log("✅ Firmado exitoso con archivo reparado.");
        } else {
            throw new Error("No se pudo procesar la firma electrónica.");
        }
    }

    // 4. ENVIAR SRI
    console.log(`📤 Enviando al SRI (${ambiente === "2" ? "PRODUCCIÓN" : "PRUEBAS"})...`);
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        return res.json({ estado: "ERROR_RECEPCION", respuestaSRI: respuestaRecepcion });
    }

    // 5. AUTORIZAR
    await new Promise(r => setTimeout(r, 2500));
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    res.json({
        estado: respuestaAutorizacion.includes("AUTORIZADO") ? "AUTORIZADO" : "PENDIENTE",
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("💥 ERROR:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({ 
        error: error.message,
        tipo: error.name
    });
  }
});

// ==========================================
// RUTA 3: BUSCAR POR NOMBRE
// ==========================================
app.get('/buscar-contribuyente/:nombre', async (req, res) => {
    const { nombre } = req.params;
    const urlSRI = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNombre?nombre=${encodeURIComponent(nombre)}`;

    try {
        console.log(`🔎 Buscando contribuyentes con nombre: ${nombre}...`);
        
        const response = await fetch(urlSRI, {
            method: 'GET',
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://srienlinea.sri.gob.ec/sri-en-linea/",
                "Origin": "https://srienlinea.sri.gob.ec",
                "Accept": "application/json, text/plain, */*"
            }
        });
        
        if (!response.ok) return res.status(response.status).json({ error: "Error consultando al SRI." });

        const data = await response.json();
        
        if (!data || !Array.isArray(data) || data.length === 0) {
            return res.json({ 
                mensaje: "No se encontraron contribuyentes con ese nombre.",
                resultados: []
            });
        }

        const resultados = data.map(c => ({
            ruc: c.numeroRuc,
            razonSocial: c.razonSocial,
            nombreComercial: c.nombreComercial,
            estado: c.estadoPersona?.descripcion,
            provincia: c.provincia?.descripcion,
            canton: c.canton?.descripcion
        }));

        console.log(`✅ Se encontraron ${resultados.length} resultados`);
        res.json({ total: resultados.length, resultados });

    } catch (error) {
        console.error("❌ Error buscando contribuyente:", error.message);
        res.status(500).json({ error: "Error interno de conexión con el SRI" });
    }
});

// ==========================================
// RUTA 4: CONSULTAR ESTABLECIMIENTOS
// ==========================================
app.get('/establecimientos/:ruc', async (req, res) => {
    const { ruc } = req.params;
    const urlSRI = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumeroRuc?numeroRuc=${ruc}`;

    try {
        console.log(`🏢 Consultando establecimientos del RUC: ${ruc}...`);
        
        const response = await fetch(urlSRI, {
            method: 'GET',
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Referer": "https://srienlinea.sri.gob.ec/sri-en-linea/",
                "Origin": "https://srienlinea.sri.gob.ec",
                "Accept": "application/json, text/plain, */*"
            }
        });
        
        if (!response.ok) return res.status(response.status).json({ error: "Error consultando al SRI." });

        const data = await response.json();
        
        if (!data || !Array.isArray(data) || data.length === 0) {
            return res.status(404).json({ error: "RUC no encontrado." });
        }

        const contribuyente = data[0];
        const establecimientos = contribuyente.establecimientos || [];

        const establecimientosDetalle = establecimientos.map(e => ({
            numeroEstablecimiento: e.numeroEstablecimiento,
            direccion: e.direccionCompleta,
            provincia: e.provincia?.descripcion,
            canton: e.canton?.descripcion,
            estado: e.estadoEstablecimiento?.descripcion,
            actividadEconomica: e.actividadEconomica?.descripcion
        }));

        res.json({
            ruc: contribuyente.numeroRuc,
            razonSocial: contribuyente.razonSocial,
            totalEstablecimientos: establecimientosDetalle.length,
            establecimientos: establecimientosDetalle
        });

    } catch (error) {
        console.error("❌ Error consultando establecimientos:", error.message);
        res.status(500).json({ error: "Error interno de conexión con el SRI" });
    }
});

// ==========================================
// RUTA 5: VERIFICAR FACTURA AUTORIZADA
// ==========================================
app.get('/verificar-factura/:claveAcceso', async (req, res) => {
    const { claveAcceso } = req.params;
    
    // Validar que tenga 49 dígitos
    if (claveAcceso.length !== 49 || !/^\d+$/.test(claveAcceso)) {
        return res.status(400).json({ 
            error: "Clave de acceso inválida. Debe tener 49 dígitos numéricos." 
        });
    }

    try {
        console.log(`🧾 Verificando autorización de factura: ${claveAcceso}...`);
        
        const ambiente = claveAcceso[23] === "2" ? "production" : "test";
        const URL_AUTORIZACION = SRI_URLS[ambiente].autorizacion;

        const respuesta = await autorizarSRI(claveAcceso, URL_AUTORIZACION);
        
        // Extraer estado del XML
        const esAutorizada = respuesta.includes("<estado>AUTORIZADO</estado>");
        const esRechazada = respuesta.includes("<estado>NO AUTORIZADO</estado>");
        
        let estado = "PENDIENTE";
        if (esAutorizada) estado = "AUTORIZADO";
        if (esRechazada) estado = "NO AUTORIZADO";

        res.json({
            claveAcceso,
            estado,
            ambiente: ambiente === "production" ? "Producción" : "Pruebas",
            respuestaCompleta: respuesta
        });

    } catch (error) {
        console.error("❌ Error verificando factura:", error.message);
        res.status(500).json({ error: "Error consultando autorización" });
    }
});

// ==========================================
// RUTA 6: HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        endpoints: {
            consultarRuc: '/consultar-ruc/:ruc',
            buscarNombre: '/buscar-contribuyente/:nombre',
            establecimientos: '/establecimientos/:ruc',
            emitirFactura: '/emitir-factura',
            verificarFactura: '/verificar-factura/:claveAcceso'
        }
    });
});

app.listen(PORT, () => console.log(`🚀 API Multi-Cliente lista en puerto ${PORT}`));

