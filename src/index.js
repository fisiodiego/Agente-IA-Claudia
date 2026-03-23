import 'dotenv/config';
import { startWhatsApp } from './whatsapp.js';
import { startScheduler, registerSendMessage } from './scheduler.js';

// ─── Validação de Variáveis de Ambiente ───────────────────────────────────────

const requiredEnvVars = ['ANTHROPIC_API_KEY'];
const missing = requiredEnvVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  console.error('❌ Variáveis de ambiente obrigatórias não definidas:');
  missing.forEach(v => console.error(`   - ${v}`));
  console.error('\n💡 Crie o arquivo .env baseado no .env.example');
  process.exit(1);
}

// ─── Inicialização ─────────────────────────────────────────────────────────────

console.log('');
console.log('╔════════════════════════════════════════════╗');
console.log('║   🏥  Agente WhatsApp - Gestão de Pacientes ║');
console.log('╚════════════════════════════════════════════╝');
console.log('');

async function main() {
  try {
    // 1. Iniciar WhatsApp e obter função de envio
    const sendMessage = await startWhatsApp();

    // 2. Registrar função de envio no agendador
    registerSendMessage(sendMessage);

    // 3. Iniciar agendador de follow-ups
    startScheduler();

    console.log('');
    console.log('═'.repeat(50));
    console.log('✅ Sistema iniciado com sucesso!');
    console.log('═'.repeat(50));
    console.log('');
    console.log('📋 Funcionalidades ativas:');
    console.log('   ✅ Resposta automática com IA (Claude)');
    console.log('   ✅ Pesquisa de satisfação pós-atendimento');
    console.log('   ✅ Follow-up 1 mês após alta');
    console.log('   ✅ Follow-up 3 meses após alta');
    console.log('   ✅ Follow-up 6 meses após alta');
    console.log('   ✅ Follow-up 12 meses após alta');
    console.log('   ✅ Verificação a cada 5 minutos');
    console.log('');


  } catch (error) {
    console.error('❌ Erro fatal ao iniciar sistema:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// ─── Tratamento de erros não capturados ───────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promessa rejeitada não tratada:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não capturada:', error.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n👋 Encerrando sistema...');
  process.exit(0);
});

main();
