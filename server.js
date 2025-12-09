import express from 'express';
import { generateInvoice } from 'open-factura';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('¡El sistema de facturación está funcionando!');
});

app.post('/facturar', (req, res) => {
  try {
    const { invoice, accessKey } = generateInvoice(req.body);
    res.json({ exito: true, claveAcceso: accessKey, xml: invoice });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
