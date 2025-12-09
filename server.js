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

// ==========================================
// RUTA 1: CONSULTAR RUC
// ==========================================
app.get('/consultar-ruc/:ruc', async (req, res) => {
    const { ruc } = req.params;
    const urlSRI = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumerosRuc?ruc=${ruc}`;

    try {
        console.log(`🔎 Consultando datos completos del RUC: ${ruc}...`);
        
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
        
        // VALIDACIÓN AGREGADA
        if (!data || !Array.isArray(data) || data.length === 0) {
            return res.status(404).json({ error: "RUC no encontrado o respuesta vacía del SRI." });
        }

        const contribuyente = data[0];

        if (!contribuyente) return res.status(404).json({ error: "RUC no encontrado." });

        console.log("✅ Datos encontrados:", contribuyente.razonSocial);

        res.json({
            ruc: contribuyente.numeroRuc,
            razonSocial: contribuyente.razonSocial, 
            nombreComercial: contribuyente.nombreComercial,
            estado: contribuyente.estadoPersona?.descripcion,
            clase: contribuyente.claseContribuyente?.descripcion,
            tipo: contribuyente.tipoContribuyente?.descripcion,
            obligadoContabilidad: contribuyente.obligado
        });

    } catch (error) {
        console.error("❌ Error consultando RUC:", error.message);
        res.status(500).json({ error: "Error interno de conexión con el SRI" });
    }
});

// ==========================================
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
    
    console.log("🔧 Generando XML...");
    let invoice, accessKey;
    try {
        const result = generateInvoice(datosFactura);
        invoice = result.invoice;
        accessKey = result.accessKey;
        console.log("✅ XML generado. Clave de acceso:", accessKey);
    } catch (error) {
        console.error("❌ Error generando invoice:", error);
        throw new Error(`Error al generar factura: ${error.message}`);
    }

    const xmlSinFirmar = generateInvoiceXml(invoice);

    // 3. FIRMADO INTELIGENTE (Try Original -> Catch -> Try Reparado)
    let xmlFirmado;
    
    try {
        console.log("🔒 Intentando firmar con archivo original...");
        xmlFirmado = await signXml(bufferOriginal, passwordFirma, xmlSinFirmar);
        console.log("✅ Firmado exitoso con archivo original.");
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
            throw new Error("No se pudo procesar la firma electrónica. Verifica el archivo.");
        }
    }

    // 4. ENVIAR SRI
    console.log(`📤 Enviando factura de ${datosFactura.infoTributaria.ruc} al SRI (${ambiente === "2" ? "PRODUCCIÓN" : "PRUEBAS"})...`);
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    console.log("📥 Respuesta recepción:", respuestaRecepcion.substring(0, 500));
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        return res.json({ 
            estado: "ERROR_RECEPCION", 
            respuestaSRI: respuestaRecepcion,
            claveAcceso: accessKey 
        });
    }

    // 5. AUTORIZAR
    console.log("⏳ Esperando 2.5s antes de consultar autorización...");
    await new Promise(r => setTimeout(r, 2500));
    
    console.log("🔍 Consultando autorización...");
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    const estadoFinal = respuestaAutorizacion.includes("AUTORIZADO") ? "AUTORIZADO" : 
                       respuestaAutorizacion.includes("PENDIENTE") ? "PENDIENTE" : "ERROR";

    console.log(`✅ Estado final: ${estadoFinal}`);

    res.json({
        estado: estadoFinal,
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("💥 ERROR SERVICIO:", error.message);
    console.error("Stack:", error.stack);
    res.status(500).json({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

app.listen(PORT, () => console.log(`🚀 API Multi-Cliente lista en puerto ${PORT}`));
