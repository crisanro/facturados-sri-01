import express from 'express';
import { 
  generateInvoice, 
  generateInvoiceXml, 
  signXml, 
  SRI_RECEPTION_URL, 
  SRI_AUTHORIZATION_URL 
} from 'open-factura';

// --- HACK para node-fetch ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
global.fetch = fetch;
// ----------------------------

// --- FUNCIONES SRI (Mismas de antes) ---
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
// ---------------------------------------

const app = express();
// Aumentamos el limite porque el base64 de la firma puede ser largo
app.use(express.json({ limit: '10mb' })); 

const PORT = process.env.PORT || 3000;

app.post('/emitir-factura', async (req, res) => {
  try {
    console.log("--- NUEVA SOLICITUD ---");
    
    // Extraemos la firma y contraseña del cuerpo de la petición
    // firmaP12 debe ser el string en Base64 (sin encabezados tipo "data:application...")
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    if (!firmaP12 || !passwordFirma) {
        throw new Error("Faltan datos: Debes enviar 'firmaP12' (base64) y 'passwordFirma'");
    }

    // 0. Detectar Ambiente (Pruebas o Producción) desde el JSON
    const ambiente = datosFactura.infoTributaria.ambiente; 
    const URL_RECEPCION = ambiente === "2" ? SRI_RECEPTION_URL.production : SRI_RECEPTION_URL.test;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_AUTHORIZATION_URL.production : SRI_AUTHORIZATION_URL.test;

    // 1. Generar XML
    const { invoice, accessKey } = generateInvoice(datosFactura);
    const xmlSinFirmar = generateInvoiceXml(invoice);
    console.log("1. XML Generado. Clave:", accessKey);

    // 2. Firmar XML (Usando la variable recibida)
    // Convertimos el string Base64 a Buffer
    const bufferFirma = Buffer.from(firmaP12, 'base64');
    const xmlFirmado = await signXml(bufferFirma, passwordFirma, xmlSinFirmar);
    console.log("2. XML Firmado correctamente.");

    // 3. Enviar a Recepción SRI
    console.log("3. Enviando al SRI (" + (ambiente==="2"?"Producción":"Pruebas") + ")...");
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        console.log("Rechazo SRI:", respuestaRecepcion);
        return res.json({ estado: "ERROR_RECEPCION", respuestaSRI: respuestaRecepcion });
    }

    // 4. Autorización
    console.log("4. Esperando autorización...");
    await new Promise(r => setTimeout(r, 3000)); // Espera prudencial
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    res.json({
        estado: respuestaAutorizacion.includes("AUTORIZADO") ? "EXITO" : "RECHAZADO",
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("ERROR:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 API lista en puerto ${PORT}`));
