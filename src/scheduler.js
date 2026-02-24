import cron from 'node-cron';
import { getPendingFollowups, markFollowupSent } from './patientManager.js';
import { followupTemplates, followupDescriptions } from './messageTemplates.js';

let sendMessageFn = null;

/**
 * Registra a função de envio de mensagens do WhatsApp.
 * Deve ser chamado antes de iniciar o agendador.
 */
export function registerSendMessage(fn) {
  sendMessageFn = fn;
}

/**
 * Inicia o agendador de follow-ups.
 * Executa a cada 5 minutos verificando se há mensagens pendentes.
 */
export function startScheduler() {
  console.log('⏰ Agendador de follow-ups iniciado');

  // Verificar a cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    await checkAndSendFollowups();
  });

  // Executar imediatamente ao iniciar
  setTimeout(() => checkAndSendFollowups(), 3000);
}

/**
 * Verifica e envia todos os follow-ups pendentes.
 */
async function checkAndSendFollowups() {
  if (!sendMessageFn) {
    console.warn('⚠️ Função de envio não registrada no agendador');
    return;
  }

  const pendingFollowups = getPendingFollowups();

  if (pendingFollowups.length === 0) return;

  console.log(`📬 ${pendingFollowups.length} follow-up(s) pendente(s) para enviar`);

  for (const followup of pendingFollowups) {
    try {
      await sendFollowup(followup);
      // Pequena pausa entre mensagens para evitar flood
      await sleep(2000);
    } catch (error) {
      console.error(`❌ Erro ao enviar follow-up #${followup.id}:`, error.message);
    }
  }
}

/**
 * Envia um follow-up individual para o paciente.
 */
async function sendFollowup(followup) {
  const templateFn = followupTemplates[followup.type];

  if (!templateFn) {
    console.error(`❌ Template não encontrado para tipo: ${followup.type}`);
    return;
  }

  const message = templateFn(followup.name);
  const description = followupDescriptions[followup.type] || followup.type;

  console.log(`📨 Enviando "${description}" para ${followup.name} (${followup.phone})`);

  await sendMessageFn(followup.phone, message);
  markFollowupSent(followup.id);

  console.log(`✅ Follow-up enviado com sucesso para ${followup.name}`);
}

/**
 * Utilitário: aguarda N milissegundos.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

