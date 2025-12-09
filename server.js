import express from 'express';
import fs from 'fs';
import { spawn } from 'child_process'; // Usamos spawn que es más seguro para contraseñas
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

// --- FUNCIÓN DE REPARACIÓN BLINDADA ---
async function repararFirma(bufferFirma, password) {
    const id = Date.now();
    const inputPath = `/tmp/firma_in_${id}.p12`;
    const outputPath = `/tmp/firma_out_${id}.p12`;

    try {
        fs.writeFileSync(inputPath, bufferFirma);

        // Usamos una promesa con SPAWN para manejar caracteres raros en la contraseña
        await new Promise((resolve, reject) => {
            // Comando: openssl pkcs12 -in IN -legacy -nodes -provider default -passin pass:PW | openssl pkcs12 -export -out OUT -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -passout pass:PW
            // Lo hacemos en dos pasos via pipe para máxima compatibilidad
            
            const p1 = spawn('openssl', [
                'pkcs12', '-in', inputPath,
                '-legacy', '-provider', 'default', // Forzamos lectura de formatos viejos y nuevos
                '-nodes', 
                '-passin', `pass:${password}`
            ]);

            const p2 = spawn('openssl', [
                'pkcs12', '-export', '-out', outputPath,
                '-keypbe', 'PBE-SHA1-3DES', // Encriptación antigua compatible con Node
                '-certpbe', 'PBE-SHA1-3DES',
                '-passout', `pass:${password}`
            ]);

            // Conectamos la salida del 1 a la entrada del 2
            p1.stdout.pipe(p2.stdin);

            // Capturamos errores
            let errorLog = '';
            p1.stderr.on('data', d => errorLog += d);
            p2.stderr.on('data', d => errorLog += d);

            p2.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`OpenSSL falló con código ${code}: ${errorLog}`));
            });
        });

        const bufferReparado = fs.readFileSync(outputPath);
        return bufferReparado;

    } catch (error) {
        console.error("⚠️ La reparación falló:", error.message);
        console.log("Intentando usar la firma original...");
        return bufferFirma; 
    } finally {
        // Limpieza
        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }
}

// ... (Funciones SRI iguales que antes) ...
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
app.use(express.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3000;

// ==========================================
// RUTA 1: CONSULTAR RUC (CORREGIDA - DATOS REALES)
// ==========================================
app.get('/consultar-ruc/:ruc', async (req, res) => {
    const { ruc } = req.params;
    
    // CORRECCIÓN: Usamos 'obtenerPorNumerosRuc' que sí devuelve la info completa
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
        
        if (!response.ok) {
            return res.status(response.status).json({ error: "Error consultando al SRI." });
        }

        const data = await response.json();
        
        // El SRI devuelve una LISTA, así que tomamos el primero
        const contribuyente = data[0];

        if (!contribuyente) {
             return res.status(404).json({ error: "RUC no encontrado." });
        }

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

app.post('/emitir-factura', async (req, res) => {
  try {
    console.log("--- NUEVA SOLICITUD ---");
    const { firmaP12, passwordFirma, ...datosFactura } = req.body;

    if (!firmaP12 || !passwordFirma) throw new Error("Faltan datos de firma.");

    // Limpieza
    let firmaLimpia = firmaP12.includes(",") ? firmaP12.split(",")[1] : firmaP12;
    firmaLimpia = firmaLimpia.replace(/\s/g, ''); 
    const bufferOriginal = Buffer.from(firmaLimpia, 'base64');
    
    // REPARACIÓN
    console.log("Reparando firma (Modo Seguro)...");
    const bufferFirma = await repararFirma(bufferOriginal, passwordFirma);
    console.log(`Tamaño firma final: ${bufferFirma.length} bytes`);

    // Proceso Normal
    const ambiente = datosFactura.infoTributaria.ambiente; 
    const URL_RECEPCION = ambiente === "2" ? SRI_URLS.production.recepcion : SRI_URLS.test.recepcion;
    const URL_AUTORIZACION = ambiente === "2" ? SRI_URLS.production.autorizacion : SRI_URLS.test.autorizacion;

    const { invoice, accessKey } = generateInvoice(datosFactura);
    const xmlSinFirmar = generateInvoiceXml(invoice);

    console.log("Firmando XML...");
    // AQUI ES DONDE SABREMOS SI FUNCIONÓ
    const xmlFirmado = await signXml(bufferFirma, passwordFirma, xmlSinFirmar);
    console.log("¡FIRMADO EXITOSO!");

    console.log("Enviando al SRI...");
    const respuestaRecepcion = await recibirSRI(xmlFirmado, URL_RECEPCION);
    
    if (!respuestaRecepcion.includes("RECIBIDA")) {
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
    console.error("💥 ERROR:", error.message);
    res.status(500).json({ error: error.message, hint: "Si dice 'mac verify error', la contraseña es incorrecta." });
  }
});

app.listen(PORT, () => console.log(`🚀 Listo en puerto ${PORT}`));

