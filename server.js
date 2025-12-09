import express from 'express';
import { 
  generateInvoice, 
  generateInvoiceXml, 
  signXml
} from 'open-factura';

// --- HACK Fetch ---
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fetch = require('node-fetch');
global.fetch = fetch;
// ------------------

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
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
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
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml;charset=UTF-8' }, body: soapBody });
    return response.text();
}

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;

// --- NUEVA RUTA PARA BUSCAR DATOS DE RUC ---
app.get('/consultar-ruc/:ruc', async (req, res) => {
    const { ruc } = req.params;
    
    // Esta es la URL que usa la página del SRI internamente
    const urlSRI = `https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/existePorNumeroRuc?numeroRuc=${ruc}`;

    try {
        const response = await fetch(urlSRI);
        
        // Si el SRI dice que no existe o da error
        if (!response.ok) {
            return res.status(404).json({ error: "RUC no encontrado o SRI caído" });
        }

        const data = await response.json();
        
        // El SRI devuelve algo como: { "numeroRuc": "...", "razonSocial": "..." }
        res.json({
            ruc: data.numeroRuc,
            razonSocial: data.razonSocial, // <--- AQUÍ ESTÁ EL NOMBRE QUE BUSCAS
            nombreComercial: data.nombreComercial,
            estado: data.estadoPersona?.descripcion
        });

    } catch (error) {
        res.status(500).json({ error: "Error consultando al SRI" });
    }
});


app.post('/emitir-factura', async (req, res) => {
  try {
    console.log("--- NUEVA SOLICITUD ---");
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    if (!firmaP12 || !passwordFirma) throw new Error("Faltan datos de firma.");

    // --- DIAGNÓSTICO DE LA FIRMA ---
    console.log(`Password recibido: [${passwordFirma}] (Longitud: ${passwordFirma.length})`);
    
    // 1. LIMPIEZA TOTAL DEL BASE64
    let firmaLimpia = firmaP12;
    // Si tiene encabezado data:..., lo quitamos
    if (firmaLimpia.includes(",")) firmaLimpia = firmaLimpia.split(",")[1];
    // Quitamos espacios en blanco y saltos de línea (CRÍTICO)
    firmaLimpia = firmaLimpia.replace(/\s/g, ''); 
    
    console.log(`Firma Base64 limpia (Primeros 20 chars): ${firmaLimpia.substring(0, 20)}...`);
    console.log(`Longitud Base64: ${firmaLimpia.length}`);

    // 2. CONVERTIR A BUFFER
    const bufferFirma = Buffer.from(firmaLimpia, 'base64');
    console.log(`Buffer creado. Tamaño en bytes: ${bufferFirma.length}`);
    
    if (bufferFirma.length === 0) throw new Error("El Buffer de la firma está vacío.");

    // 3. GENERAR XML
    const ambiente = datosFactura.infoTributaria.ambiente; 
    const URL_RECEPCION = ambiente === "2" ? SRI_URLS.production.recepcion : SRI_URLS.test.recepcion;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_URLS.production.autorizacion : SRI_URLS.test.autorizacion;

    const { invoice, accessKey } = generateInvoice(datosFactura);
    const xmlSinFirmar = generateInvoiceXml(invoice);
    console.log("XML Generado OK.");

    // 4. FIRMAR (Aquí es donde fallaba)
    console.log("Intentando firmar...");
    const xmlFirmado = await signXml(bufferFirma, passwordFirma, xmlSinFirmar);
    console.log("¡FIRMADO EXITOSO! 🎉");

    // 5. ENVIAR SRI
    console.log("Enviando al SRI...");
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
        console.log("SRI Rechazo:", respuestaRecepcion);
        return res.json({ estado: "ERROR_RECEPCION", respuestaSRI: respuestaRecepcion });
    }

    await new Promise(r => setTimeout(r, 3000));
    const respuestaAutorizacion = await autorizarSRI(accessKey, URL_AUTORIZACION);

    res.json({
        estado: respuestaAutorizacion.includes("AUTORIZADO") ? "EXITO" : "PENDIENTE",
        claveAcceso: accessKey,
        xmlFirmado: xmlFirmado,
        respuestaSRI: respuestaAutorizacion
    });

  } catch (error) {
    console.error("💥 ERROR FATAL:", error);
    // Devolvemos el error detallado para que lo veas en Postman
    res.status(500).json({ 
        error: error.message, 
        detalle: "Revisa los logs de Easypanel para ver si la contraseña o el archivo están mal."
    });
  }
});

app.listen(PORT, () => console.log(`🚀 Debugger listo en puerto ${PORT}`));

