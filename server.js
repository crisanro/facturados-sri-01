import express from 'express';
import { 
  generateInvoice, 
  generateInvoiceXml, 
  signXml
  // Quitamos las URLs de aquí porque causaban el error
} from 'open-factura';

// --- HACK para que funcione fetch en Node.js ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
global.fetch = fetch;
// ----------------------------------------------

// --- DEFINIMOS LAS URLS DEL SRI MANUALMENTE (Para evitar el error) ---
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

// --- FUNCIONES DE AYUDA (SOAP) ---
async function recibirSRI(xmlFirmado, url) {
    const soapBody = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.recepcion">
       <soapenv:Header/>
       <soapenv:Body>
          <ec:validarComprobante>
             <xml>${Buffer.from(xmlFirmado).toString('base64')}</xml>
          </ec:validarComprobante>
       </soapenv:Body>
    </soapenv:Envelope>`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
        body: soapBody
    });
    return response.text();
}

async function autorizarSRI(claveAcceso, url) {
    const soapBody = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ec="http://ec.gob.sri.ws.autorizacion">
       <soapenv:Header/>
       <soapenv:Body>
          <ec:autorizacionComprobante>
             <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
          </ec:autorizacionComprobante>
       </soapenv:Body>
    </soapenv:Envelope>`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml;charset=UTF-8' },
        body: soapBody
    });
    return response.text();
}

const app = express();
// Aumentamos el limite para recibir la firma en base64
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

app.post('/emitir-factura', async (req, res) => {
  try {
    console.log("--- NUEVA SOLICITUD ---");
    
    // Extraemos los datos del JSON
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    if (!firmaP12 || !passwordFirma) {
        throw new Error("Faltan datos: Debes enviar 'firmaP12' (base64) y 'passwordFirma'");
    }

    // 0. Detectar Ambiente (1: Pruebas, 2: Producción)
    const ambiente = datosFactura.infoTributaria.ambiente; 
    
    // Seleccionamos la URL correcta usando nuestro objeto manual
    const URL_RECEPCION = ambiente === "2" ? SRI_URLS.production.recepcion : SRI_URLS.test.recepcion;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_URLS.production.autorizacion : SRI_URLS.test.autorizacion;

    // 1. Generar XML
    const { invoice, accessKey } = generateInvoice(datosFactura);
    const xmlSinFirmar = generateInvoiceXml(invoice);
    console.log("1. XML Generado. Clave:", accessKey);

// 2. Firmar XML
    // LIMPIEZA AUTOMÁTICA DE BASE64
    // Si el usuario mandó "data:application/...", lo quitamos para quedarnos solo con el código
    let firmaLimpia = firmaP12;
    if (firmaLimpia.includes(",")) {
        firmaLimpia = firmaLimpia.split(",")[1]; 
    }

    const bufferFirma = Buffer.from(firmaLimpia, 'base64');
    
    // Verificación de seguridad: Si el buffer está vacío o corrupto, avisar antes de crashear
    if (bufferFirma.length === 0) {
        throw new Error("La firma electrónica (Base64) parece estar vacía o mal formada.");
    }

    const xmlFirmado = await signXml(bufferFirma, passwordFirma, xmlSinFirmar);
    console.log("2. XML Firmado correctamente.");

    // 3. Enviar a Recepción SRI
    console.log("3. Enviando al SRI (" + (ambiente==="2"?"Producción":"Pruebas") + ")...");
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        console.log("Respuesta SRI (Recepción):", respuestaRecepcion);
        return res.json({ 
            estado: "ERROR_RECEPCION", 
            mensaje: "El SRI no recibió el comprobante.",
            respuestaSRI: respuestaRecepcion 
        });
    }

    // 4. Autorización
    console.log("4. Esperando autorización...");
    await new Promise(r => setTimeout(r, 3000)); // Esperamos 3 segundos
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    // Verificamos si fue autorizado
    const autorizado = respuestaAutorizacion.includes("AUTORIZADO");
    
    res.json({
        estado: autorizado ? "EXITO" : "RECHAZADO_O_PROCESANDO",
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("ERROR INTERNO:", error.message);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.listen(PORT, () => console.log(`🚀 API lista en puerto ${PORT}`));

