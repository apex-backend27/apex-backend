const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Servidor funcionando correctamente');
});

app.get('/test', (req, res) => {
  res.json({ mensaje: 'Backend funcionando' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor corriendo en puerto ${port}`);
});