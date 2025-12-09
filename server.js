import express from 'express';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
  generateInvoice, 
  generateInvoiceXml, 
  signXml
} from 'open-factura';

// --- HACK Fetch (Necesario para Node.js) ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
global.fetch = fetch;
// ------------------------------------------

const execAsync = promisify(exec);

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

// --- FUNCIÓN 1: REPARAR FIRMA ---
async function repararFirma(bufferFirma, password) {
    const id = Date.now();
    const inputPath = `/tmp/firma_in_${id}.p12`;
    const outputPath = `/tmp/firma_out_${id}.p12`;

    try {
        fs.writeFileSync(inputPath, bufferFirma);
        // Comando OpenSSL para convertir a formato Legacy (3DES) compatible
        const comando = `openssl pkcs12 -in ${inputPath} -export -out ${outputPath} -passin pass:"${password}" -passout pass:"${password}" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES`;
        await execAsync(comando);
        const bufferReparado = fs.readFileSync(outputPath);
        return bufferReparado;
    } catch (error) {
        console.error("Error reparando firma:", error.message);
        return bufferFirma; // Si falla, devolvemos la original
    } finally {
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
}

// --- FUNCIONES SOAP SRI ---
async function recibirSRI(xmlFirmado, url) {
    const soapBody = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">
       <soapenv:Header/>
       <soapenv:Body>
          <ec:validarComprobante><xml>${Buffer.from(xmlFirmado).toString('base64')}</xml></ec:validarComprobante>
       </soapenv:Body>
    </soapenv:Envelope>`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
    return response.text();
}

async function autorizarSRI(claveAcceso, url) {
    const soapBody = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
       <soapenv:Header/>
       <soapenv:Body>
          <ec:autorizacionComprobante><claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante></ec:autorizacionComprobante>
       </soapenv:Body>
    </soapenv:Envelope>`;
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
    return response.text();
}

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;

// ==========================================
// RUTA 1: CONSULTAR RUC (GET)
// ==========================================
app.get('/consultar-ruc/:ruc', async (req, res) => {
    const { ruc } = req.params;
    const urlSRI = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/existePorNumeroRuc?numeroRuc=${ruc}`;

    try {
        console.log(`Consultando RUC: ${ruc}...`);
        const response = await fetch(urlSRI);
        
        if (!response.ok) return res.status(404).json({ error: "RUC no encontrado" });

        const data = await response.json();
        res.json({
            ruc: data.numeroRuc,
            razonSocial: data.razonSocial,
            nombreComercial: data.nombreComercial,
            estado: data.estadoPersona?.descripcion
        });
    } catch (error) {
        console.error("Error consultando RUC:", error);
        res.status(500).json({ error: "Error de conexión con el SRI" });
    }
});

// ==========================================
// RUTA 2: EMITIR FACTURA (POST)
// ==========================================
app.post('/emitir-factura', async (req, res) => {
  try {
    console.log("--- NUEVA FACTURA ---");
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    if (!firmaP12 || !passwordFirma) throw new Error("Faltan datos de firma.");

    // 1. Limpieza y Reparación
    let firmaLimpia = firmaP12.includes(",") ? firmaP12.split(",")[1] : firmaP12;
    firmaLimpia = firmaLimpia.replace(/\s/g, ''); 
    const bufferOriginal = Buffer.from(firmaLimpia, 'base64');
    
    console.log("Reparando firma...");
    const bufferFirma = await repararFirma(bufferOriginal, passwordFirma);

    // 2. Generar XML
    const ambiente = datosFactura.infoTributaria.ambiente; 
    const URL_RECEPCION = ambiente === "2" ? SRI_URLS.production.recepcion : SRI_URLS.test.recepcion;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_URLS.production.autorizacion : SRI_URLS.test.autorizacion;

    const { invoice, accessKey } = generateInvoice(datosFactura);
    const xmlSinFirmar = generateInvoiceXml(invoice);

    // 3. Firmar
    console.log("Firmando...");
    const xmlFirmado = await signXml(bufferFirma, passwordFirma, xmlSinFirmar);

    // 4. Enviar
    console.log("Enviando al SRI...");
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        return res.json({ estado: "ERROR_RECEPCION", respuestaSRI: respuestaRecepcion });
    }

    // 5. Autorizar
    await new Promise(r => setTimeout(r, 3000));
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    res.json({
        estado: respuestaAutorizacion.includes("AUTORIZADO") ? "EXITO" : "PENDIENTE",
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("💥 ERROR:", error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 API Completa lista en puerto ${PORT}`));
