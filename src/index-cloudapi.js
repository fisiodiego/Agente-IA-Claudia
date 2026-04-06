import 'dotenv/config';
import { startWhatsApp } from './whatsapp-cloudapi.js';
import { startScheduler, registerSendMessage } from './scheduler.js';

// ─── Validação de Variáveis de Ambiente ───────────────────────────────────────

const requiredEnvVars = ['ANTHROPIC_API_KEY', 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN'];
const missing = requiredEnvVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  console.error('❌ Variáveis de ambiente obrigatórias não definidas:');
  missing.forEach(v => console.error(`   - ${v}`));
  console.error('\n💡 Adicione ao arquivo .env');
  process.exit(1);
}

// ─── Inicialização ─────────────────────────────────────────────────────────────

console.log('');
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║   🏥  Cláudia IA — WhatsApp Cloud API (Oficial)           ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log('');

async function main() {
  try {
    // 1. Iniciar WhatsApp Cloud API (webhook server)
    const sendMessage = await startWhatsApp();

    // 2. Registrar função de envio no agendador
    registerSendMessage(sendMessage);

    // 3. Iniciar agendador de follow-ups
    startScheduler();

    console.log('');
    console.log('═'.repeat(60));
    console.log('✅ Sistema iniciado com sucesso! (Cloud API)');
    console.log('═'.repeat(60));
    console.log('');
    console.log('📋 Funcionalidades ativas:');
    console.log('   ✅ Resposta automática com IA (Claude)');
    console.log('   ✅ Webhook para mensagens recebidas');
    console.log('   ✅ Envio via Graph API oficial');
    console.log('   ✅ Pesquisa de satisfação pós-atendimento');
    console.log('   ✅ Follow-ups automáticos (1, 3, 6, 12 meses)');
    console.log('   ✅ Lembretes de agendamento (23h e 2h antes)');
    console.log('   ✅ Pausa manual via /pause/:phone');
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
