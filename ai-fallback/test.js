import { askAI } from './index.js';

console.log('🧪 Probando motor de IA Fallback...');
askAI('Hola, confirma en una sola frase corta que estás operativo para FacilitaCR.')
  .then(res => {
    console.log(`\n✅ Respuesta exitosa:`);
    console.log(`• Proveedor: ${res.provider}`);
    console.log(`• Modelo: ${res.model}`);
    console.log(`• Mensaje: "${res.text.trim()}"`);
  })
  .catch(console.error);
