import cron from 'node-cron';
import { getPendingFollowups, markFollowupSent, getPatientByPhone, confirmDischarge, saveMessage } from './patientManager.js';
import { followupTemplates, followupDescriptions, appointmentReminder24h, getGreeting, packageReminderLevel1, packageReminderLevel2, packageReminderLevel3, noShowRescheduling, waitlistNotification, postConsultationCheckIn, birthdayMessage, reactivationMessage, weeklyReportMessage, packageCompletedMessage, referralMessage, sameDayReminder } from './messageTemplates.js';
import { getUpcomingAppointments, getRecentDischarges, getStalePackages, getRecentNoShows, getWaitlistMatches, removeFromWaitlist, getCompletedAppointments, getBirthdays, getInactivePatients, getWeeklyReport, getCompletedPackages, logClaudiaActivity, getFollowUpsByPhone } from './crmApi.js';
import db from './database.js';
import { recentReminderPhones, recentReminderNames } from './agent.js';

let sendMessageFn = null;
let sendTemplateFn = null;

/**
 * Valida formato de telefone BR (10-13 dígitos, com/sem DDI 55).
 * Bloqueia wa_ids/LIDs do WhatsApp (tipicamente 14-15+ dígitos).
 */
function isValidBRPhone(p) {
  if (!p) return false;
  const d = String(p).replace(/\D/g, '');
  return (d.length === 10 || d.length === 11) ||
         ((d.length === 12 || d.length === 13) && d.startsWith('55'));
}

/**
 * Resolve o telefone de um paciente priorizando contact_phone quando phone inválido.
 * Fix do bug: pacientes LID tinham phone=wa_id (14+ dígitos), causando falha no envio
 * de follow-ups agendados. contact_phone guarda o telefone BR real resolvido pelo agent.
 */
function resolvePatientPhone(patient) {
  const phone = patient.phone || patient.Phone;
  const contactPhone = patient.contact_phone || patient.contactPhone;
  if (isValidBRPhone(phone)) return phone;
  if (isValidBRPhone(contactPhone)) return contactPhone;
  return phone; // devolve o original mesmo inválido (função chamadora decide o que fazer)
}

// Controle para não enviar lembrete duplicado
const sentReminders = new Set();

// ── Criar registro de follow-up no CRM Kanban ──
async function createFollowUpInCRM(followup) {
  try {
    const typeMap = {
      lembrete_1mes: 'retorno_1m',
      lembrete_3meses: 'retorno_3m',
      lembrete_6meses: 'retorno_6m',
      lembrete_12meses: 'retorno_12m',
      pesquisa_satisfacao: 'retorno_1m',
    };

    // Buscar patient_id E patient_name do CRM pelo telefone.
    // O followup.name vem do banco local da Claudia, que pode estar como "Novo Paciente"
    // se a paciente nunca conversou com a Claudia (ex: paciente cadastrado direto no CRM
    // com alta, recebe retorno_1m sem ter trocado msg antes). Caso Alana Castro 29/abr/2026.
    let crmPatientId = null;
    let crmPatientName = null;
    if (followup.phone) {
      try {
        const { searchPatientByPhone } = await import('./crmApi.js');
        const result = await searchPatientByPhone(followup.phone);
        if (result?.found && result.patient?.id) {
          crmPatientId = result.patient.id;
          crmPatientName = result.patient.name;
        }
      } catch (e) { console.warn('⚠️ Erro ao buscar patient_id CRM:', e.message); }
    }

    // Prioriza nome do CRM (real) sobre o do banco local da Claudia (pode ser "Novo Paciente")
    const finalName = crmPatientName || followup.name;

    const id = 'fu-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const body = {
      id,
      patientId: crmPatientId,
      patientName: finalName,
      phone: followup.phone,
      type: typeMap[followup.type] || 'retorno_1m',
      status: 'enviado',
      source: 'claudia',
      lastAppointmentDate: null,
      dueDate: new Date().toISOString().split('T')[0],
      messageSentAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const CRM_URL = process.env.CRM_API_URL || 'https://crm.holiz.com.br/api/integration';
    const API_KEY = process.env.CRM_API_KEY || '';

    const res = await fetch(CRM_URL + '/follow-ups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      console.log('[Scheduler] Follow-up criado no CRM:', finalName, '(' + (typeMap[followup.type] || 'retorno_1m') + ')');
    } else {
      console.warn('[Scheduler] Follow-up CRM respondeu', res.status);
    }
  } catch (err) {
    console.error('[Scheduler] Erro ao criar follow-up no CRM:', err.message);
  }
}


// Helper: check if reminder was already sent (persisted in DB)
function wasReminderSent(db, appointmentId, type, date) {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS sent_reminders_log (appointment_id TEXT, type TEXT, date TEXT, sent_at TEXT, PRIMARY KEY(appointment_id, type, date))').run();
    const row = db.prepare('SELECT 1 FROM sent_reminders_log WHERE appointment_id = ? AND type = ? AND date = ?').get(appointmentId, type, date);
    return !!row;
  } catch { return false; }
}
function markReminderSent(db, appointmentId, type, date) {
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS sent_reminders_log (appointment_id TEXT, type TEXT, date TEXT, sent_at TEXT, PRIMARY KEY(appointment_id, type, date))').run();
    db.prepare('INSERT OR IGNORE INTO sent_reminders_log (appointment_id, type, date, sent_at) VALUES (?, ?, ?, ?)').run(appointmentId, type, date, new Date().toISOString());
  } catch (e) { console.warn('⚠️ Erro ao marcar lembrete:', e.message); }
}

/**
 * Registra a função de envio de mensagens do WhatsApp.
 */
export function registerSendMessage(fn, templateFn) {
  sendMessageFn = fn;
  sendTemplateFn = templateFn || null;
}
/**
 * Envia mensagem com fallback para template se fora da janela de 24h.
 * @param {string} phone
 * @param {string} text - texto normal
 * @param {string} templateName - nome do template de fallback
 * @param {Array} templateParams - parametros do template
 * @returns {boolean} true se enviou com sucesso
 */
async function smartSend(phone, text, templateName, templateParams = []) {
  // Estrategia: TEMPLATE-FIRST para mensagens proativas
  // Motivo: Cloud API retorna 200 OK para texto mesmo fora da janela 24h,
  // mas o erro 131047 so chega async via webhook — nunca cai no catch.

  let sentOk = false;
  let sentVia = null; // 'template' ou 'texto'

  if (sendTemplateFn && templateName) {
    try {
      console.log(`📋 Enviando template ${templateName} para ${phone}...`);
      const ok = await sendTemplateFn(phone, templateName, templateParams);
      if (ok) {
        console.log(`✅ Template ${templateName} enviado com sucesso para ${phone}`);
        sentOk = true;
        sentVia = 'template';
      } else {
        console.warn(`⚠️ Template ${templateName} retornou falso para ${phone}, tentando texto...`);
      }
    } catch (err) {
      console.warn(`⚠️ Template ${templateName} falhou para ${phone}: ${err.message}. Tentando texto...`);
    }
  }

  // Fallback: texto normal (funciona se paciente mandou msg nas ultimas 24h)
  if (!sentOk) {
    try {
      await sendMessageFn(phone, text);
      console.log(`📝 Texto enviado para ${phone} (fallback)`);
      sentOk = true;
      sentVia = 'texto';
    } catch (err) {
      console.error(`❌ Falha total ao enviar para ${phone}: ${err.message}`);
      return false;
    }
  }

  // Persistir em conversations para preservar contexto da Claudia.
  // Caso real (Priscila, 30/abr/2026): cron envia template lembrete_pacote,
  // paciente responde "Oi!" 50min depois e Claudia se reapresenta porque
  // o template não estava no histórico de conversas. Agora qualquer envio
  // proativo do scheduler fica registrado, e o LLM monta resposta com contexto.
  // Falha silenciosa: se não conseguir salvar (paciente não existe no banco
  // local, telefone inválido, etc.), apenas loga e continua — envio já ocorreu.
  if (sentOk && text) {
    try {
      const localPatient = getPatientByPhone(phone);
      if (localPatient?.id) {
        saveMessage(localPatient.id, 'assistant', text);
        console.log(`💾 Mensagem (via ${sentVia}) salva em conversations para paciente #${localPatient.id}`);
      }
    } catch (err) {
      console.warn(`⚠️ Falha ao salvar conversation (não-bloqueante): ${err.message}`);
    }
  }

  return true;
}



/**
 * Inicia o agendador de follow-ups e lembretes.
 */
export function startScheduler() {
  console.log('⏰ Agendador de follow-ups e lembretes iniciado');

  // Follow-ups: verificar a cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    await checkAndSendFollowups();
  });

  // Lembrete noturno: 20h BRT (23h UTC) — envia para todos os agendamentos do dia seguinte
  cron.schedule('0 23 * * *', async () => {
    await checkAndSendReminders();
  });

  // Limpar cache de lembretes enviados à meia-noite
  cron.schedule('0 3 * * *', () => {
    sentReminders.clear();
    console.log('🧹 Cache de lembretes limpo');
  });

  // Executar follow-ups imediatamente ao iniciar
  setTimeout(() => checkAndSendFollowups(), 3000);

  // Executar checagem de lembretes 10s após iniciar (APENAS se horario BRT entre 19:30-23:59)
  setTimeout(() => {
    const nowBRT = new Date(Date.now() - 3 * 3600000);
    const hourBRT = nowBRT.getUTCHours();
    const minBRT = nowBRT.getUTCMinutes();
    if (hourBRT >= 20 || (hourBRT === 19 && minBRT >= 30)) {
      console.log("⏰ Horario BRT (" + hourBRT + ":" + String(minBRT).padStart(2, "0") + ") dentro da janela — executando lembretes noturno");
      checkAndSendReminders();
    } else {
      console.log("⏰ Horario BRT (" + hourBRT + ":" + String(minBRT).padStart(2, "0") + ") fora da janela de lembretes (19:30-23:59) — pulando");
    }
  }, 10000);

  // Altas do CRM: verificar a cada 10 minutos
  cron.schedule('*/10 * * * *', async () => {
    await checkCrmDischarges();
  });

  // Executar checagem de altas 15s após iniciar
  setTimeout(() => checkCrmDischarges(), 15000);

  // ── Feature 1: Lembretes de pacote — diário às 14h BRT (17h UTC) ──
  cron.schedule('0 17 * * *', async () => {
    await checkStalePackages();
  });

  // ── Feature 2: Reagendamento de faltantes — a cada 15 min ──
  cron.schedule('*/15 * * * *', async () => {
    await checkNoShows();
  });

  // Executar checagem de faltantes 20s após iniciar
  setTimeout(() => checkNoShows(), 20000);

  // ── Relatório semanal: segunda às 8h BRT (11h UTC) ──
  cron.schedule('0 11 * * 1', async () => {
    await sendWeeklyReport();
  });

  // ── Pacotes concluídos: diário às 15h BRT (18h UTC) ──
  cron.schedule('0 18 * * *', async () => {
    await checkCompletedPackages();
  });

  // ── Campanha de indicação: 3 dias após pós-consulta, às 11h BRT (14h UTC) ──
  cron.schedule('0 14 * * *', async () => {
    await sendReferralCampaign();
  });

  // ── Aniversário: enviar parabéns às 9h BRT (12h UTC) ──
  cron.schedule('0 12 * * *', async () => {
    await sendBirthdayMessages();
  });

  // ── Reativação: semanal às terças 11h BRT (14h UTC) ──
  cron.schedule('0 14 * * 2', async () => {
    await sendReactivationMessages();
  });

  // ── Pós-consulta: enviar check-in no dia seguinte às 10h BRT (13h UTC) ──
  cron.schedule('0 13 * * *', async () => {
    await sendPostConsultationMessages();
  });

  // ── Feature 3: Notificação de vagas (waitlist) — a cada 10 min ──
  cron.schedule('*/10 * * * *', async () => {
    await checkWaitlistVacancies();
  });

  // ── Lembrete no dia da consulta: 8h BRT (11h UTC) ──
  cron.schedule('0 11 * * *', async () => {
    await sendSameDayReminders();
  });
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

  // Resolver telefone válido (fallback para contact_phone se phone=wa_id/LID inválido)
  const targetPhone = resolvePatientPhone(followup);
  if (!isValidBRPhone(targetPhone)) {
    console.error(`⛔ Follow-up #${followup.id} ${description} para ${followup.name}: telefone inválido (phone=${followup.phone}, contact_phone=${followup.contact_phone || 'n/a'}). Pulando e marcando como enviado para não reagendar.`);
    markFollowupSent(followup.id);
    return;
  }
  if (targetPhone !== followup.phone) {
    console.log(`🔧 Follow-up ${description} para ${followup.name}: phone=${followup.phone} inválido, usando contact_phone=${targetPhone}`);
  }

  // Skip: não enviar retorno se paciente já tem consulta agendada/confirmada
  if (followup.type.startsWith('lembrete_') && followup.type !== 'lembrete_consulta') {
    try {
      const { getPatientAppointments } = await import('./crmApi.js');
      const aptsResult = await getPatientAppointments(targetPhone);
      if (aptsResult.ok && aptsResult.data?.length) {
        const hasUpcoming = aptsResult.data.some(a =>
          (a.status === 'agendado' || a.status === 'confirmado')
        );
        if (hasUpcoming) {
          console.log(`⏭️ Skip follow-up ${description} para ${followup.name} — já tem consulta agendada`);
          markFollowupSent(followup.id);
          return;
        }
      }
    } catch (e) { console.warn('⚠️ Erro ao verificar agendamentos:', e.message); }
  }

  console.log(`📨 Enviando ${description} para ${followup.name} (${targetPhone})`);

  const firstName = followup.name.split(' ')[0];

  // Mapeamento de follow-up type -> template dedicado do Chakra WABA
  const followupTemplateMap = {
    pesquisa_satisfacao: { name: 'followup_satisfacao', params: [firstName, 'https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao'] },
    lembrete_1mes:      { name: 'retorno_1mes_a',      params: [firstName] },
    lembrete_3meses:    { name: 'retorno_3meses_a',    params: [firstName] },
    lembrete_6meses:    { name: 'retorno_6meses_a',    params: [firstName] },
    lembrete_12meses:   { name: 'retorno_12meses_a',   params: [firstName] },
  };

  // Fallback para followup_satisfacao se tipo nao mapeado (ex: pos_confirmacao_d1)
  const tmpl = followupTemplateMap[followup.type] || { name: 'followup_satisfacao', params: [firstName, 'https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao'] };
  const templateName = tmpl.name;
  const templateParams = tmpl.params;

  const ok = await smartSend(targetPhone, message, templateName, templateParams);
  if (!ok) {
    console.error(`❌ Falha ao enviar follow-up "${description}" para ${followup.name}`);
    return;
  }
  markFollowupSent(followup.id);

  // Criar registro no Kanban do CRM (exceto pesquisa de satisfação e pos-confirmação)
  if (followup.type !== "pesquisa_satisfacao" && followup.type !== "pos_confirmacao_d1") {
    await createFollowUpInCRM({ ...followup, phone: targetPhone });
  }

  await logClaudiaActivity('follow_up', {
    patientName: followup.name,
    phone: targetPhone,
    details: { type: followup.type, followupId: followup.id }
  });

  console.log(`✅ Follow-up enviado com sucesso para ${followup.name}`);
}

/**
 * Verifica agendamentos do dia seguinte e envia lembretes via WhatsApp.
 */
async function checkAndSendReminders() {
  if (!sendMessageFn) {
    console.warn('⚠️ Função de envio não registrada para lembretes');
    return;
  }

  try {
    // Calcular data de amanhã em BRT (UTC-3)
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const tomorrow = new Date(brt);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDate = tomorrow.toISOString().slice(0, 10);

    const [y, m, d] = targetDate.split('-');
    const dateBR = `${d}/${m}/${y}`;

    console.log(`🌙 Lembrete noturno (20h) — buscando agendamentos de ${dateBR}...`);

    const result = await getUpcomingAppointments(targetDate);
    if (!result.ok) {
      console.error('❌ Erro ao buscar agendamentos para lembretes:', result.error);
      return;
    }

    const appointments = result.ok ? (result.data || []) : [];

    if (!appointments || appointments.length === 0) {
      console.log(`📭 Nenhum agendamento para ${dateBR}`);
      return;
    }

    console.log(`📋 ${appointments.length} agendamento(s) para amanhã`);

    let enviados = 0;
    for (const apt of appointments) {
      // Ignorar cancelados
      if (apt.status === 'cancelado' || apt.status === 'cancelled') {
        continue;
      }

      // Chave única para evitar duplicatas
      const reminderKey = `${apt.id}-${apt.date}`;
      if (sentReminders.has(reminderKey) || wasReminderSent(db, apt.id, 'reminder_24h', apt.date)) {
        continue;
      }

      if (!apt.patientPhone) {
        console.warn(`⚠️ Paciente ${apt.patientName} sem telefone, lembrete não enviado`);
        continue;
      }

      // ⏸️ Pular lembrete_consulta (véspera) se há reagendamento pendente no Kanban
      try {
        const fuResult = await getFollowUpsByPhone(apt.patientPhone);
        const fuArr = Array.isArray(fuResult?.data) ? fuResult.data : [];
        const hasPendingReschedule = fuArr.some(f =>
          f.source === 'reagendar_pendente' &&
          f.status !== 'agendou' &&
          f.status !== 'perdido' &&
          typeof f.notes === 'string' &&
          f.notes.includes(`[apt_id:${apt.id}]`)
        );
        if (hasPendingReschedule) {
          console.log(`⏸️ Lembrete_consulta pulado — reagendamento pendente para ${apt.patientName} (apt ${apt.id})`);
          continue;
        }
      } catch (err) {
        console.warn(`⚠️ Erro ao verificar reagendamento pendente para ${apt.patientName}:`, err.message);
      }

      try {
        const message = appointmentReminder24h(
          apt.patientName,
          dateBR,
          apt.time,
          apt.professionalName,
          apt.specialty
        );

        console.log(`🔔 Enviando lembrete para ${apt.patientName} (${apt.patientPhone}) — amanhã ${apt.time}`);

        const firstName = apt.patientName.split(' ')[0];
        await smartSend(apt.patientPhone, message, 'lembrete_consulta', [firstName, dateBR, apt.time, apt.professionalName]);
        sentReminders.add(reminderKey);
        markReminderSent(db, apt.id, 'reminder_24h', apt.date);

        await logClaudiaActivity('reminder_24h', {
          patientName: apt.patientName,
          phone: apt.patientPhone,
          details: { appointmentId: apt.id, time: apt.time, date: apt.date }
        });

        console.log(`✅ Lembrete enviado para ${apt.patientName}`);
        const reminderPhone = String(apt.patientPhone).replace(/\D/g, '');
        recentReminderPhones.set(reminderPhone, Date.now());
        recentReminderNames.set(reminderPhone, apt.patientName);

        enviados++;
        await sleep(3000);
      } catch (error) {
        console.error(`❌ Erro ao enviar lembrete para ${apt.patientName}:`, error.message);
      }
    }

    console.log(`📊 Lembretes noturno: ${enviados} enviado(s) para ${dateBR}`);
  } catch (error) {
    console.error('❌ Erro geral no sistema de lembretes:', error.message);
  }
}

/**
 * Utilitário: aguarda N milissegundos.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ── Polling de altas do CRM ────────────────────────────────────────────────

/**
 * Verifica no CRM se há pacientes com alta recente e agenda follow-ups.
 */
async function checkCrmDischarges() {
  try {
    // Buscar última verificação (ou padrão 48h atrás)
    const lastCheckRow = db.prepare("SELECT value FROM config WHERE key = 'lastDischargeCheck'").get();
    const lastCheck = lastCheckRow?.value || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const result = await getRecentDischarges(lastCheck);

    if (!result.ok) {
      console.error('❌ Erro ao buscar altas do CRM:', result.error);
      return;
    }

    const discharges = result.data;

    if (!discharges || discharges.length === 0) return;

    console.log(`🏥 ${discharges.length} alta(s) recente(s) encontrada(s) no CRM`);

    for (const discharge of discharges) {
      try {
        // Verificar se já foi processada (usa phone como chave)
        const already = db.prepare(
          'SELECT 1 FROM processed_discharges WHERE patient_id = ? AND discharge_date = ?'
        ).get(discharge.phone, discharge.dischargeDate);

        if (already) {
          continue;
        }

        // Verificar se a alta foi dada HOJE — se sim, adiar pos_consulta para amanha
        const nowBRT = new Date(Date.now() - 3 * 3600000);
        const todayBRT = nowBRT.toISOString().slice(0, 10);
        const dischargeDay = (discharge.dischargeDate || '').slice(0, 10);
        if (dischargeDay === todayBRT) {
          console.log('⏳ Alta de ' + discharge.name + ' foi HOJE — pos_consulta sera enviado amanha pelo cron das 10h');
          // Marcar como processada para nao reprocessar, mas NAO envia pos_consulta agora
          // O cron sendPostConsultationMessages (10h BRT) enviara amanha
          db.prepare(
            'INSERT OR IGNORE INTO processed_discharges (patient_id, discharge_date, processed_at) VALUES (?, ?, ?)'
          ).run(discharge.phone, discharge.dischargeDate, new Date().toISOString());
          // Agendar follow-ups (retornos) normalmente — so adia o pos_consulta
          const claudiaPatientToday = getPatientByPhone(discharge.phone);
          if (claudiaPatientToday) {
            confirmDischarge(claudiaPatientToday.id, discharge.dischargeDate.split('T')[0]);
          }
          continue;
        }

        // Buscar paciente na Claudia pelo telefone
        const claudiaPatient = getPatientByPhone(discharge.phone);

        if (!claudiaPatient) {
          console.log(`⚠️ Paciente ${discharge.name} (${discharge.phone}) não encontrado na Claudia, pulando`);
          continue;
        }

        // Agendar follow-ups (retornos 1m, 3m, 6m, 12m)
        confirmDischarge(claudiaPatient.id, discharge.dischargeDate.split('T')[0]);

        // Marcar como processado
        db.prepare(
          'INSERT OR IGNORE INTO processed_discharges (patient_id, discharge_date, processed_at) VALUES (?, ?, ?)'
        ).run(discharge.phone, discharge.dischargeDate, new Date().toISOString());

        // Enviar pesquisa de satisfacao na alta
        // Se pos_consulta ja foi enviado nas ultimas 24h → envia texto direto (janela aberta)
        // Se nao → envia template pos_consulta primeiro, espera 3min, depois texto
        try {
          const dischargeFirstName = discharge.name.split(' ')[0];
          const doctoraliaUrl = 'https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao';
          const surveyMsg = 'Ola, ' + dischargeFirstName + '! Sua opiniao e muito importante para nos.\n\nPoderia dedicar 2 minutinhos para avaliar seu atendimento no Instituto Holiz?\n\n' + doctoraliaUrl + '\n\nSeu feedback nos ajuda a continuar melhorando. Agradecemos de coracao!';

          // Verificar se pos_consulta ja foi enviado para esse telefone nas ultimas 24h
          const hasSentRecently = db.prepare(
            "SELECT 1 FROM pos_consulta_log WHERE phone = ? AND sent_at > datetime('now', '-24 hours')"
          ).get(discharge.phone);

          if (hasSentRecently) {
            // Janela 24h ja aberta pelo pos_consulta anterior → envia texto direto
            console.log('📨 Janela 24h aberta para ' + discharge.name + ' — enviando pesquisa como texto');
            await sendMessageFn(discharge.phone, surveyMsg);
            console.log('✅ Pesquisa de satisfacao enviada para ' + discharge.name + ' (janela pos_consulta)');
          } else {
            // Sem janela aberta → envia template pos_consulta primeiro
            const { sendTemplateMessage } = await import('./whatsapp-cloudapi.js');
            const tmplOk = await sendTemplateMessage(discharge.phone, 'pos_consulta', [dischargeFirstName]);
            if (tmplOk) {
              console.log('✅ Template pos_consulta enviado para ' + discharge.name + ' (alta)');
              // Registrar envio para anti-duplicata
              db.prepare(
                "INSERT INTO pos_consulta_log (phone, sent_at) VALUES (?, datetime('now','localtime'))"
              ).run(discharge.phone);
              // Aguardar 3 minutos e enviar pesquisa como texto
              setTimeout(async () => {
                try {
                  await sendMessageFn(discharge.phone, surveyMsg);
                  console.log('✅ Pesquisa de satisfacao enviada para ' + discharge.name + ' (pos-alta)');
                } catch (e) {
                  console.warn('⚠️ Erro ao enviar pesquisa para ' + discharge.name + ':', e.message);
                }
              }, 3 * 60 * 1000);
            } else {
              // Template falhou → tenta texto direto como fallback
              console.warn('⚠️ Template pos_consulta falhou, tentando texto direto...');
              await sendMessageFn(discharge.phone, surveyMsg);
            }
          }
          await logClaudiaActivity('satisfaction_survey', {
            patientName: discharge.name,
            phone: discharge.phone,
            details: { trigger: 'discharge' }
          });
        } catch (e) {
          console.warn('⚠️ Erro ao enviar pesquisa de satisfacao para ' + discharge.name + ':', e.message);
        }

        console.log(`\u2705 Follow-ups agendados para ${discharge.name} (alta: ${discharge.dischargeDate})`);
      } catch (err) {
        console.error(`❌ Erro ao processar alta de ${discharge.name}:`, err.message);
      }
    }

    // Atualizar timestamp da última verificação
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lastDischargeCheck', ?)").run(new Date().toISOString());
  } catch (err) {
    console.error('❌ Erro geral na verificação de altas:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Feature 1: Lembretes de retorno de pacote
// ═══════════════════════════════════════════════════════════════════════════════

async function checkStalePackages() {
  if (!sendMessageFn) return;

  try {
    const result = await getStalePackages();

    if (!result.ok) {
      console.error('❌ Erro ao buscar pacotes inativos:', result.error);
      return;
    }

    const packages = result.data;
    if (!packages || packages.length === 0) return;

    console.log(`📦 ${packages.length} pacote(s) sem agendamento encontrado(s)`);

    for (const pkg of packages) {
      try {
        const days = pkg.daysSinceLastActivity;

        // Determinar nível de urgência.
        // Limites diferentes para pacote intensivo vs manutenção:
        // - Intensivo (1x/semana esperado): 7/14/21 dias
        // - Manutenção (1x/mês esperado): 30/45/60 dias
        // Detecção pelo nome do produto (mesma regra do deadline em integration.ts).
        const isManutencao = /manuten[çc][ãa]o/i.test(pkg.productName || '');
        const T1 = isManutencao ? 30 : 7;
        const T2 = isManutencao ? 45 : 14;
        const T3 = isManutencao ? 60 : 21;

        let level = 0;
        const deadlineDate = new Date(pkg.deadlineDate + 'T23:59:59');
        const now = new Date();
        const daysToDeadline = Math.floor((deadlineDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (days >= T3 || daysToDeadline <= 14) {
          level = 3;
        } else if (days >= T2) {
          level = 2;
        } else if (days >= T1) {
          level = 1;
        } else {
          continue; // Ainda dentro do ritmo esperado do pacote
        }

        // Verificar se já enviou este nível
        const already = db.prepare(
          'SELECT 1 FROM package_reminders WHERE package_id = ? AND level = ?'
        ).get(pkg.packageId, level);

        if (already) continue;

        // Formatar data do deadline em BR
        const [y, m, d] = pkg.deadlineDate.split('-');
        const deadlineBR = `${d}/${m}/${y}`;

        // Selecionar template
        let message;
        if (level === 1) {
          message = packageReminderLevel1(pkg.patientName, pkg.freeSessions, pkg.productName, deadlineBR);
        } else if (level === 2) {
          message = packageReminderLevel2(pkg.patientName, pkg.freeSessions, pkg.productName, deadlineBR);
        } else {
          message = packageReminderLevel3(pkg.patientName, pkg.freeSessions, pkg.productName, deadlineBR);
        }

        console.log(`📦 Enviando lembrete nível ${level} para ${pkg.patientName} (pacote: ${pkg.productName})`);

        const pkgFirstName = pkg.patientName.split(' ')[0];
        await smartSend(pkg.phone, message, 'lembrete_pacote', [pkgFirstName, String(pkg.freeSessions), pkg.productName, deadlineBR]);

        // Registrar envio
        db.prepare(
          'INSERT OR IGNORE INTO package_reminders (package_id, level, sent_at) VALUES (?, ?, ?)'
        ).run(pkg.packageId, level, new Date().toISOString());

        await logClaudiaActivity('package_reminder', {
          patientName: pkg.patientName,
          phone: pkg.phone,
          details: { packageId: pkg.packageId, level, productName: pkg.productName }
        });

        console.log(`✅ Lembrete de pacote enviado para ${pkg.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao enviar lembrete de pacote para ${pkg.patientName}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de lembretes de pacote:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Feature 2: Reagendamento de faltantes
// ═══════════════════════════════════════════════════════════════════════════════

async function checkNoShows() {
  if (!sendMessageFn) return;

  try {
    // Buscar última verificação (ou 2 dias atrás)
    const lastCheckRow = db.prepare("SELECT value FROM config WHERE key = 'lastNoShowCheck'").get();
    const lastCheck = lastCheckRow?.value || new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await getRecentNoShows(lastCheck);

    if (!result.ok) {
      console.error('❌ Erro ao buscar faltantes:', result.error);
      return;
    }

    const noShows = result.data;
    if (!noShows || noShows.length === 0) {
      // Atualizar timestamp mesmo sem faltas
      db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lastNoShowCheck', ?)").run(new Date().toISOString().slice(0, 10));
      return;
    }

    console.log(`🚫 ${noShows.length} falta(s) encontrada(s)`);

    for (const ns of noShows) {
      try {
        // Verificar se já processou
        const already = db.prepare(
          'SELECT 1 FROM processed_noshows WHERE appointment_id = ?'
        ).get(ns.appointmentId);

        if (already) continue;

        const message = noShowRescheduling(
          ns.patientName,
          ns.date,
          ns.time,
          ns.professionalName
        );

        console.log(`🚫 Enviando reagendamento para ${ns.patientName} (faltou ${ns.date} ${ns.time})`);

        const nsFirstName = ns.patientName.split(' ')[0];
        const [ny, nm, nd] = ns.date.split('-');
        const nsDateBR = `${nd}/${nm}/${ny}`;
        await smartSend(ns.patientPhone, message, 'falta_reagendamento_a', [nsFirstName, nsDateBR, ns.time, ns.professionalName]);

        // Marcar como processado
        db.prepare(
          'INSERT OR IGNORE INTO processed_noshows (appointment_id, processed_at) VALUES (?, ?)'
        ).run(ns.appointmentId, new Date().toISOString());

        await logClaudiaActivity('noshow_contact', {
          patientName: ns.patientName,
          phone: ns.patientPhone,
          details: { appointmentId: ns.appointmentId, date: ns.date, time: ns.time }
        });

        console.log(`✅ Reagendamento enviado para ${ns.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao processar falta de ${ns.patientName}:`, err.message);
      }
    }

    // Atualizar timestamp
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('lastNoShowCheck', ?)").run(new Date().toISOString().slice(0, 10));
  } catch (err) {
    console.error('❌ Erro geral no sistema de faltantes:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Feature 3: Notificação de vagas da lista de espera
// ═══════════════════════════════════════════════════════════════════════════════

async function checkWaitlistVacancies() {
  if (!sendMessageFn) return;

  try {
    // Buscar todas as datas/profissionais com waitlist ativa
    // Precisamos verificar se surgiram vagas nos próximos 7 dias
    const today = new Date();
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Buscar entries de waitlist ativas
    // Como não temos uma lista local, vamos pedir ao CRM para cada data
    // que tem waitlist entries. Mas para otimizar, verificamos apenas
    // entradas que o CRM retorna como matches.

    // Abordagem: buscar profissionais conhecidos e verificar cada data
    // Simplificação: profissional principal = mmgby4te4p8dp4ew9ci
    const professionalId = 'mmgby4te4p8dp4ew9ci';

    for (const date of dates) {
      try {
        const result = await getWaitlistMatches(professionalId, date);

        if (!result.ok || !result.data || result.data.length === 0) continue;

        // Há pacientes na fila para esta data — verificar se tem vaga
        // (O fato de o CRM retornar matches significa que os pacientes estão esperando,
        //  mas precisamos verificar se há horários livres agora)

        // Importar checkAvailability indiretamente
        const { checkAvailability } = await import('./crmApi.js');
        const availResult = await checkAvailability(professionalId, date, 60);

        if (!availResult.ok || !availResult.data || !availResult.data.slots || availResult.data.slots.length === 0) {
          continue; // Sem vagas
        }

        // Filtrar slots pelo preferred_period do PRIMEIRO da fila.
        // Caso Maria pediu manhã, só abriu vaga 14h → não notificar.
        // Períodos: manha (00:00-11:59), tarde (12:00-17:59), noite (18:00+).
        // 'qualquer' aceita todos os slots.
        const match = result.data[0];
        const period = match.preferredPeriod || 'qualquer';
        const slotsAll = availResult.data.slots;
        const slotsInPeriod = slotsAll.filter((slot) => {
          const hour = parseInt(slot.split(':')[0], 10);
          if (period === 'manha')   return hour < 12;
          if (period === 'tarde')   return hour >= 12 && hour < 18;
          if (period === 'noite')   return hour >= 18;
          return true; // qualquer
        });

        if (slotsInPeriod.length === 0) {
          console.log(`⏭️ ${match.patientName}: tem vagas em ${date} mas nenhuma no período '${period}' (queria), pulando.`);
          continue;
        }

        const profName = availResult.data.professionalName || 'Dr. Diego Matos';

        const message = waitlistNotification(match.patientName, date, profName);

        console.log(`🎉 Vaga encontrada para ${match.patientName} em ${date}! Notificando...`);

        await sendMessageFn(match.patientPhone, message);

        // Remover da waitlist
        await removeFromWaitlist(match.waitlistId);

        await logClaudiaActivity('waitlist_notification', {
          patientName: match.patientName,
          phone: match.patientPhone,
          details: { date, waitlistId: match.waitlistId }
        });

        console.log(`✅ Notificação de vaga enviada para ${match.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao verificar waitlist para ${date}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de lista de espera:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Pós-consulta: check-in no dia seguinte
// ═══════════════════════════════════════════════════════════════════════════════

async function sendPostConsultationMessages() {
  if (!sendMessageFn) return;

  try {
    // Buscar consultas concluídas nos últimos 3 dias
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const since = threeDaysAgo.toISOString().slice(0, 10);

    const result = await getCompletedAppointments(since);

    if (!result.ok) {
      console.error('❌ Erro ao buscar consultas concluídas:', result.error);
      return;
    }

    const appointments = result.data;
    if (!appointments || appointments.length === 0) return;

    // Filtrar: só enviar para consultas de ONTEM (dia seguinte = hoje)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const yesterdayAppointments = appointments.filter(a => a.date === yesterdayStr);

    if (yesterdayAppointments.length === 0) return;

    console.log(`💬 ${yesterdayAppointments.length} consulta(s) concluída(s) ontem — enviando pós-consulta`);

    for (const apt of yesterdayAppointments) {
      try {
        // Verificar se já processou
        const already = db.prepare(
          'SELECT 1 FROM processed_completions WHERE appointment_id = ?'
        ).get(apt.appointmentId);

        if (already) continue;

        const message = postConsultationCheckIn(apt.patientName);

        console.log(`💬 Enviando pós-consulta para ${apt.patientName} (${apt.patientPhone})`);

        const postFirstName = apt.patientName.split(' ')[0];
        const [py, pm, pd] = (apt.date || yesterdayStr).split('-');
        const postDateBR = pd + '/' + pm + '/' + py;
        await smartSend(apt.patientPhone, message, 'pos_consulta', [postFirstName]);

        // Registrar envio do pos_consulta (usado pela alta para saber se janela 24h esta aberta)
        db.prepare(
          "INSERT INTO pos_consulta_log (phone, sent_at) VALUES (?, datetime('now','localtime'))"
        ).run(apt.patientPhone);

        // Marcar como processado
        db.prepare(
          'INSERT OR IGNORE INTO processed_completions (appointment_id, scheduled_date, processed_at) VALUES (?, ?, ?)'
        ).run(apt.appointmentId, new Date().toISOString().slice(0, 10), new Date().toISOString());

        await logClaudiaActivity('post_consultation', {
          patientName: apt.patientName,
          phone: apt.patientPhone,
          details: { appointmentId: apt.appointmentId, date: apt.date }
        });

        console.log(`✅ Pós-consulta enviado para ${apt.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao enviar pós-consulta para ${apt.patientName}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de pós-consulta:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Aniversário: parabéns automáticos
// ═══════════════════════════════════════════════════════════════════════════════

async function sendBirthdayMessages() {
  if (!sendMessageFn) return;

  try {
    // Data de hoje no formato MM-DD (ajustando para BRT = UTC-3)
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const monthDay = `${String(brt.getMonth() + 1).padStart(2, '0')}-${String(brt.getDate()).padStart(2, '0')}`;
    const currentYear = brt.getFullYear();

    console.log(`🎂 Verificando aniversários para ${monthDay}...`);

    const result = await getBirthdays(monthDay);

    if (!result.ok) {
      console.error('❌ Erro ao buscar aniversários:', result.error);
      return;
    }

    const patients = result.data;
    if (!patients || patients.length === 0) {
      console.log('🎂 Nenhum aniversariante hoje');
      return;
    }

    console.log(`🎂 ${patients.length} aniversariante(s) hoje!`);

    for (const patient of patients) {
      try {
        // Verificar se já enviou neste ano
        const already = db.prepare(
          'SELECT 1 FROM sent_birthdays WHERE patient_phone = ? AND year = ?'
        ).get(patient.phone, currentYear);

        if (already) continue;

        const message = birthdayMessage(patient.name);

        console.log(`🎂 Enviando parabéns para ${patient.name} (${patient.phone})`);

        const bdayFirstName = patient.name.split(' ')[0];
        await smartSend(patient.phone, message, 'aniversario_paciente', [bdayFirstName]);

        db.prepare(
          'INSERT OR IGNORE INTO sent_birthdays (patient_phone, year, sent_at) VALUES (?, ?, ?)'
        ).run(patient.phone, currentYear, new Date().toISOString());

        await logClaudiaActivity('birthday', {
          patientName: patient.name,
          phone: patient.phone,
          details: { year: currentYear }
        });

        console.log(`✅ Parabéns enviados para ${patient.name}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao enviar parabéns para ${patient.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de aniversários:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Reativação de pacientes inativos
// ═══════════════════════════════════════════════════════════════════════════════

async function sendReactivationMessages() {
  if (!sendMessageFn) return;

  try {
    console.log('🔄 Verificando pacientes inativos para reativação...');

    const result = await getInactivePatients(90); // 3+ meses sem consulta

    if (!result.ok) {
      console.error('❌ Erro ao buscar pacientes inativos:', result.error);
      return;
    }

    const patients = result.data;
    if (!patients || patients.length === 0) {
      console.log('🔄 Nenhum paciente inativo para reativação');
      return;
    }

    console.log(`🔄 ${patients.length} paciente(s) inativo(s) encontrado(s)`);

    // Limitar a 10 mensagens por execução para não sobrecarregar
    const batch = patients.slice(0, 10);

    for (const patient of batch) {
      try {
        // Verificar se já enviou reativação (só envia 1 vez)
        const already = db.prepare(
          'SELECT 1 FROM sent_reactivations WHERE patient_id = ?'
        ).get(patient.patientId);

        if (already) continue;

        const message = reactivationMessage(patient.name, patient.daysSinceLastAppointment);

        console.log(`🔄 Enviando reativação para ${patient.name} (${patient.daysSinceLastAppointment} dias sem consulta)`);

        const reactFirstName = patient.name.split(' ')[0];
        await smartSend(patient.phone, message, 'reativacao_paciente', [reactFirstName]);

        db.prepare(
          'INSERT OR IGNORE INTO sent_reactivations (patient_id, sent_at) VALUES (?, ?)'
        ).run(patient.patientId, new Date().toISOString());

        await logClaudiaActivity('reactivation', {
          patientId: patient.patientId,
          patientName: patient.name,
          phone: patient.phone,
          details: { daysSinceLastAppointment: patient.daysSinceLastAppointment }
        });

        console.log(`✅ Reativação enviada para ${patient.name}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao enviar reativação para ${patient.name}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de reativação:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Relatório semanal para o profissional
// ═══════════════════════════════════════════════════════════════════════════════

const DIEGO_PHONE = '5571993507884'; // Número do Dr. Diego para relatórios

async function sendWeeklyReport() {
  if (!sendMessageFn) return;

  try {
    // Semana anterior (segunda a domingo)
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);

    const endDate = new Date(brt);
    endDate.setDate(endDate.getDate() - 1); // ontem (domingo)
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6); // segunda passada

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    console.log(`📊 Gerando relatório semanal (${startStr} a ${endStr})...`);

    const result = await getWeeklyReport(startStr, endStr);

    if (!result.ok) {
      console.error('❌ Erro ao gerar relatório semanal:', result.error);
      return;
    }

    const message = weeklyReportMessage(result.data);

    // Datas formatadas (DD/MM) — usadas tanto no template antigo (2 vars)
    // quanto na primeira variável do template _dados (período).
    const startDD = startStr.slice(8,10) + '/' + startStr.slice(5,7);
    const endDD = endStr.slice(8,10) + '/' + endStr.slice(5,7);

    // ── Tentativa 1: relatorio_semanal_dados (template único com 10 variáveis)
    // Estrutura aprovada pelo Meta:
    //   {{1}} período "DD/MM a DD/MM"
    //   {{2}} realizados | {{3}} faltas | {{4}} % faltas | {{5}} cancelamentos
    //   {{6}} novos agendamentos | {{7}} novos pacientes | {{8}} altas
    //   {{9}} receita formatada | {{10}} consultas próxima semana
    const { sendTemplateMessage } = await import('./whatsapp-cloudapi.js');
    const d = result.data;
    const completed = d.completedAppointments ?? 0;
    const noShows = d.noShows ?? 0;
    const noShowRate = (completed + noShows) > 0
      ? ((noShows / (completed + noShows)) * 100).toFixed(1)
      : '0.0';
    const revenueStr = (d.revenue ?? 0).toFixed(2).replace('.', ',');

    const dadosVars = [
      `${startDD} a ${endDD}`,           // {{1}}
      String(completed),                 // {{2}}
      String(noShows),                   // {{3}}
      noShowRate,                        // {{4}}
      String(d.cancelled ?? 0),          // {{5}}
      String(d.newAppointments ?? 0),    // {{6}}
      String(d.newPatients ?? 0),        // {{7}}
      String(d.discharges ?? 0),         // {{8}}
      revenueStr,                        // {{9}}
      String(d.nextWeekAppointments ?? 0) // {{10}}
    ];

    const dadosOk = await sendTemplateMessage(DIEGO_PHONE, 'relatorio_semanal_dados', dadosVars);

    if (dadosOk) {
      console.log('✅ Relatório enviado via template _dados (única mensagem)');
    } else {
      // ── Fallback: fluxo antigo (template anúncio + texto separado) ──
      console.warn('⚠️ Template _dados falhou, caindo no fluxo antigo (anúncio + texto)...');
      const templateOk = await sendTemplateMessage(DIEGO_PHONE, 'relatorio_semanal', [startDD, endDD]);
      if (templateOk) {
        await new Promise(r => setTimeout(r, 2000));
        await sendMessageFn(DIEGO_PHONE, message);
      } else {
        // Fallback final: texto direto (só funciona dentro da janela de 24h)
        console.warn('⚠️ Template anúncio também falhou, tentando texto direto...');
        await sendMessageFn(DIEGO_PHONE, message);
      }
    }

    await logClaudiaActivity('weekly_report', {
      phone: DIEGO_PHONE,
      details: { startDate: startStr, endDate: endStr }
    });

    console.log('✅ Relatório semanal enviado para Dr. Diego');
  } catch (err) {
    console.error('❌ Erro geral no relatório semanal:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Notificação de pacote concluído
// ═══════════════════════════════════════════════════════════════════════════════

async function checkCompletedPackages() {
  if (!sendMessageFn) return;

  try {
    const result = await getCompletedPackages();

    if (!result.ok) {
      console.error('❌ Erro ao buscar pacotes concluídos:', result.error);
      return;
    }

    const packages = result.data;
    if (!packages || packages.length === 0) return;

    console.log(`🏆 ${packages.length} pacote(s) concluído(s) encontrado(s)`);

    for (const pkg of packages) {
      try {
        // Verificar se já notificou
        const already = db.prepare(
          'SELECT 1 FROM notified_completed_packages WHERE package_id = ?'
        ).get(pkg.packageId);

        if (already) continue;

        const message = packageCompletedMessage(pkg.patientName, pkg.productName, pkg.totalSessions);

        console.log(`🏆 Notificando conclusão de pacote para ${pkg.patientName} (${pkg.productName})`);

        await sendMessageFn(pkg.phone, message);

        db.prepare(
          'INSERT OR IGNORE INTO notified_completed_packages (package_id, sent_at) VALUES (?, ?)'
        ).run(pkg.packageId, new Date().toISOString());

        await logClaudiaActivity('package_completed', {
          patientName: pkg.patientName,
          phone: pkg.phone,
          details: { packageId: pkg.packageId, productName: pkg.productName }
        });

        console.log(`✅ Notificação de conclusão enviada para ${pkg.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao notificar pacote concluído para ${pkg.patientName}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral no sistema de pacotes concluídos:', err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// Campanha de indicação (3 dias após pós-consulta positivo)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendReferralCampaign() {
  if (!sendMessageFn) return;

  try {
    // Buscar consultas concluídas de 3 dias atrás
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const targetDate = threeDaysAgo.toISOString().slice(0, 10);

    // Buscar consultas de 4-5 dias atrás (janela)
    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const sinceDate = fiveDaysAgo.toISOString().slice(0, 10);

    const result = await getCompletedAppointments(sinceDate);

    if (!result.ok) {
      console.error('❌ Erro ao buscar consultas para indicação:', result.error);
      return;
    }

    const appointments = result.data;
    if (!appointments || appointments.length === 0) return;

    // Filtrar apenas consultas de 3 dias atrás
    const targetAppointments = appointments.filter(a => a.date === targetDate);

    if (targetAppointments.length === 0) return;

    console.log(`🤝 ${targetAppointments.length} paciente(s) elegível(eis) para indicação`);

    for (const apt of targetAppointments) {
      try {
        // Verificar se já enviou indicação para este telefone
        const already = db.prepare(
          'SELECT 1 FROM sent_referrals WHERE patient_phone = ?'
        ).get(apt.patientPhone);

        if (already) continue;

        const message = referralMessage(apt.patientName);

        console.log(`🤝 Enviando campanha de indicação para ${apt.patientName}`);

        await sendMessageFn(apt.patientPhone, message);

        db.prepare(
          'INSERT OR IGNORE INTO sent_referrals (patient_phone, sent_at) VALUES (?, ?)'
        ).run(apt.patientPhone, new Date().toISOString());

        await logClaudiaActivity('referral', {
          patientName: apt.patientName,
          phone: apt.patientPhone,
          details: { appointmentDate: apt.date }
        });

        console.log(`✅ Indicação enviada para ${apt.patientName}`);

        await sleep(3000);
      } catch (err) {
        console.error(`❌ Erro ao enviar indicação para ${apt.patientName}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro geral na campanha de indicação:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Lembrete no dia da consulta (manhã 8h BRT)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendSameDayReminders() {
  if (!sendMessageFn) return;

  try {
    // Data de hoje (BRT)
    const now = new Date();
    const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const todayStr = brt.toISOString().slice(0, 10);

    // Formatar data em BR
    const [y, m, d] = todayStr.split('-');
    const dateBR = `${d}/${m}/${y}`;

    console.log(`🌅 Verificando agendamentos para HOJE ${dateBR} (lembrete do dia)...`);

    const result = await getUpcomingAppointments(todayStr, { includeConfirmed: true });

    if (!result.ok) {
      console.error('❌ Erro ao buscar agendamentos do dia:', result.error);
      return;
    }

    const appointments = result.data;

    if (!appointments || appointments.length === 0) {
      console.log('📭 Nenhum agendamento para hoje');
      return;
    }

    console.log(`🌅 ${appointments.length} agendamento(s) hoje`);

    for (const apt of appointments) {
      // Ignorar agendamentos cancelados
      if (apt.status === 'cancelado' || apt.status === 'cancelled') {
        continue;
      }

      try {
        // Verificar se já enviou
        const already = db.prepare(
          'SELECT 1 FROM sent_sameday_reminders WHERE appointment_id = ?'
        ).get(apt.id);

        if (already || wasReminderSent(db, apt.id, 'sameday', todayStr)) {
          continue;
        }

        if (!apt.patientPhone) {
          console.warn(`⚠️ Paciente ${apt.patientName} sem telefone, lembrete do dia não enviado`);
          continue;
        }

        // ⏸️ Pular lembrete_dia se há reagendamento pendente no Kanban para este apt
        // (paciente clicou "Reagendar" mas ainda não confirmou nova data/hora)
        try {
          const fuResult = await getFollowUpsByPhone(apt.patientPhone);
          const fuArr = Array.isArray(fuResult?.data) ? fuResult.data : [];
          const hasPendingReschedule = fuArr.some(f =>
            f.source === 'reagendar_pendente' &&
            f.status !== 'agendou' &&
            f.status !== 'perdido' &&
            typeof f.notes === 'string' &&
            f.notes.includes(`[apt_id:${apt.id}]`)
          );
          if (hasPendingReschedule) {
            console.log(`⏸️ Lembrete_dia pulado — reagendamento pendente para ${apt.patientName} (apt ${apt.id})`);
            continue;
          }
        } catch (err) {
          console.warn(`⚠️ Erro ao verificar reagendamento pendente para ${apt.patientName}:`, err.message);
        }

        const message = sameDayReminder(
          apt.patientName,
          apt.time,
          apt.professionalName
        );

        console.log(`🌅 Enviando lembrete do dia para ${apt.patientName} (${apt.patientPhone}) — ${apt.time}`);

        const sameDayFirstName = apt.patientName.split(' ')[0];
        await smartSend(apt.patientPhone, message, 'lembrete_dia', [sameDayFirstName, apt.time, apt.professionalName]);

        // Registrar envio
        db.prepare(
          'INSERT OR IGNORE INTO sent_sameday_reminders (appointment_id, sent_at) VALUES (?, ?)'
        ).run(apt.id, new Date().toISOString());
        markReminderSent(db, apt.id, 'sameday', todayStr);

        // Log na dashboard
        await logClaudiaActivity('same_day_reminder', {
          patientName: apt.patientName,
          phone: apt.patientPhone,
          details: { appointmentId: apt.id, time: apt.time, date: todayStr }
        });

        console.log(`✅ Lembrete do dia enviado para ${apt.patientName}`);
        // Marcar phone para aceitar respostas curtas como confirmação
        const reminderPhoneDay = String(apt.patientPhone).replace(/\D/g, '');
        recentReminderPhones.set(reminderPhoneDay, Date.now());
        recentReminderNames.set(reminderPhoneDay, apt.patientName);

        await sleep(3000);
      } catch (error) {
        console.error(`❌ Erro ao enviar lembrete do dia para ${apt.patientName}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Erro geral no sistema de lembretes do dia:', error.message);
  }
}

