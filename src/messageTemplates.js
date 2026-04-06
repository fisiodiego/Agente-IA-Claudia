// ─── Templates de Mensagens ────────────────────────────────────────────────────
// Todas as mensagens enviadas pelo agente de forma automática

/**
 * Gera saudação baseada no horário atual
 */
export function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12)  return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * Mensagem de boas-vindas quando o paciente entra em contato pela primeira vez
 */
export function welcomeMessage() {
  return `${getGreeting()}! 😊 Seja bem-vindo(a) ao *Instituto Holiz* — Osteopatia e Quiropraxia!

Sou a *Cláudia*, assistente virtual do Instituto. Estou aqui para te ajudar com agendamentos, dúvidas sobre nossos tratamentos e muito mais. 🌿

Para começar, qual é o seu *nome*? 😊`;
}

/**
 * Pesquisa de satisfação - enviada após o primeiro atendimento
 */
export function satisfactionSurvey(patientName) {
  return `${getGreeting()}, ${patientName}! 😊

Esperamos que sua consulta no *Instituto Holiz* tenha sido incrível! Ficamos muito felizes em ter cuidado de você. 💚

Temos um pedido especial: poderia deixar sua avaliação no *Doctoralia*? Leva menos de 2 minutinhos e faz uma diferença enorme para nós! ⭐

👉 *Deixe sua avaliação aqui:*
https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao

Seu feedback nos ajuda a:
✅ Continuar evoluindo na qualidade do atendimento
✅ Ajudar outras pessoas a encontrarem o Instituto Holiz
✅ Saber o que estamos fazendo bem — e o que podemos melhorar

Obrigada de coração! 🙏😊`;
}

/**
 * Agradecimento pela resposta da pesquisa de satisfação
 */
export function thanksSurveyResponse(score) {
  const score_num = parseInt(score);

  if (score_num >= 4) {
    return `Uhuuu! Que alegria receber essa avaliação! 🥳🌟

Fico muito feliz em saber que sua experiência no *Instituto Holiz* foi positiva! Isso nos motiva muito a continuar cuidando de cada paciente com dedicação e carinho. 💚

Se ainda não deixou sua avaliação no Doctoralia, aproveite! É rapidinho e ajuda muita gente a nos encontrar 😊👇
https://www.doctoralia.com.br/adicionar-opiniao/diego-matos#/opiniao

Até a próxima consulta! Cuide-se bem! 🌿`;
  }

  if (score_num === 3) {
    return `Obrigada pelo seu retorno! 🙏

Cada feedback é muito valioso pra gente. Se quiser nos contar o que poderíamos ter feito melhor, adoraríamos ouvir — pode falar à vontade aqui mesmo! Estamos sempre buscando melhorar para te atender cada vez melhor. 😊

Qualquer dúvida, é só chamar! 💚`;
  }

  return `Obrigada por ser honesto(a) com a gente! Isso é muito importante para nós. 🙏

Lamentamos que a experiência não tenha sido como esperado. Queremos entender o que aconteceu para melhorarmos. Pode nos contar mais sobre o que não atendeu suas expectativas? Estamos aqui para ouvir e evoluir! 💬`;
}

/**
 * Lembrete de follow-up - 1 mês após a alta
 */
export function followup1Month(patientName) {
  return `${getGreeting()}, ${patientName}! 😊

Já faz *1 mês* desde que você recebeu alta! Passando para saber como você está se sentindo. 💚

🩺 *Algumas perguntas rápidas:*
- As dores ou desconfortos que te trouxeram à clínica melhoraram?
- Está conseguindo manter as orientações posturais recebidas?
- Notou algum novo desconforto?

💡 Lembre-se: na *Osteopatia e Quiropraxia*, o acompanhamento preventivo é parte essencial do tratamento. Ele garante que o seu corpo continue em equilíbrio e evita recidivas!

Tem alguma dúvida ou quer compartilhar algo? Estamos aqui! 😊`;
}

/**
 * Lembrete de follow-up - 3 meses após a alta
 */
export function followup3Months(patientName) {
  return `${getGreeting()}, ${patientName}! 😊

*3 meses de alta!* Como está o seu corpo por aí? 💚

🔎 *Por que fazer uma revisão agora?*
Na Osteopatia e Quiropraxia, a consulta de revisão aos 3 meses é fundamental para:
✅ Verificar a estabilidade dos ajustes e tratamentos realizados
✅ Prevenir o retorno de dores e tensões
✅ Identificar novos padrões de compensação antes que virem problema

Que tal agendarmos uma *consulta de manutenção*? Costuma ser mais rápida que as iniciais e faz toda a diferença no resultado a longo prazo! 😊

Responda aqui e te ajudamos com o horário. 📅`;
}

/**
 * Lembrete de follow-up - 6 meses após a alta
 */
export function followup6Months(patientName) {
  return `${getGreeting()}, ${patientName}! 😊

*6 meses de alta!* Que ótimo chegar até aqui! 💪

Esse é um marco muito importante no seu acompanhamento. Chegou o momento ideal para a sua *revisão semestral* de Osteopatia e/ou Quiropraxia! 🏥

🌟 *O que avaliamos nessa consulta:*
- Equilíbrio postural e mobilidade articular
- Tensões acumuladas no sistema neuromusculoesquelético
- Necessidade de novos ajustes ou intervenções preventivas
- Qualidade de vida e hábitos posturais

Não deixe acumular! Um corpo cuidado regularmente responde muito melhor ao tratamento. 💚

Quer agendar sua revisão semestral? É só responder aqui! 📅`;
}

/**
 * Lembrete de follow-up - 12 meses após a alta
 */
export function followup12Months(patientName) {
  return `${getGreeting()}, ${patientName}! 🎉

*1 ANO desde sua alta!* Que conquista incrível — parabéns por cuidar da sua saúde! 🥳

Chegou o momento da sua *revisão anual*, uma das consultas mais completas e importantes do seu acompanhamento em Osteopatia e Quiropraxia.

📋 *Na revisão anual, nossos especialistas avaliam:*
✅ Evolução completa do seu caso ao longo do ano
✅ Equilíbrio estrutural e funcional do corpo
✅ Necessidade de ajustes ou novos ciclos de tratamento
✅ Orientações personalizadas para o próximo ano

Um ano de saúde em equilíbrio é motivo de celebração! 🌿 Continue investindo no seu bem-estar.

Responda aqui para marcar seu horário. Estamos te esperando! 😊`;
}

/**
 * Mensagem enviada no dia seguinte após o paciente confirmar o agendamento.
 * Pergunta como está e se começou os exercícios orientados.
 */
export function postConfirmationCheckIn(patientName) {
  const name = patientName && patientName !== 'Novo Paciente' ? patientName.split(' ')[0] : '';
  const greeting = name ? `${getGreeting()}, *${name}*! 😊` : `${getGreeting()}! 😊`;

  return `${greeting}

Passando aqui para saber como você está se sentindo após a consulta! 💚

Já conseguiu começar a fazer os exercícios que foram orientados? Manter a regularidade faz toda a diferença no resultado do tratamento! 🏃

Qualquer dúvida, desconforto ou necessidade — pode chamar aqui, estamos sempre à disposição! 🌿`;
}

/**
 * Mensagem de lembrete sobre tratamento preventivo (genérica)
 */
export function preventiveCareReminder(patientName) {
  return `${getGreeting()}, ${patientName}! 😊

Uma mensagem rápida para lembrá-lo(a) da importância do *cuidado preventivo*! 🌟

💡 *Sabia que:*
- A prevenção evita até 70% dos problemas de saúde
- Consultas regulares reduzem custos a longo prazo
- Cuidar da saúde hoje garante qualidade de vida amanhã

Estamos sempre aqui para te apoiar nessa jornada! Qualquer dúvida, é só chamar. 💚`;
}

/**
 * Lembrete enviado automaticamente quando o paciente confirma o agendamento
 * (responde CONFIRMAR ao SMS/WhatsApp do Simples Agenda)
 */
export function appointmentConfirmedReminder(patientName) {
  const name = patientName && patientName !== 'Novo Paciente' ? patientName.split(' ')[0] : '';
  const greeting = name ? `Ótimo, *${name}*!` : 'Ótimo!';

  return `${greeting} Consulta confirmada! ✅

Venha com roupas confortáveis (legging, moletom ou roupa de ginástica).

Se precisar *reagendar ou cancelar*, nos avise com pelo menos *12 horas de antecedência*.

Te esperamos! 🌿`;
}
/**
 * Resposta quando o paciente cancela o agendamento via Simples Agenda
 */
export function appointmentCancelledResponse(patientName) {
  const name = patientName && patientName !== 'Novo Paciente' ? patientName.split(' ')[0] : '';
  const greeting = name ? `Entendido, *${name}*!` : 'Entendido!';

  return `${greeting} Seu agendamento foi cancelado.

Deseja reagendar para outro dia? Posso verificar os horários disponíveis pra você! 📅`;
}

/**
 * Mensagem de consentimento LGPD enviada após coletar os dados do paciente.
 */
export function lgpdConsentMessage(patientName) {
  const name = patientName && patientName !== 'Novo Paciente' ? `, *${patientName}*` : '';
  return `Obrigada${name}! Seus dados foram recebidos.

Precisamos do seu consentimento para cuidar dos seus dados. Eles serão usados apenas para seu atendimento e comunicação. Você pode pedir acesso ou exclusão quando quiser. Ao continuar, você concorda com a LGPD.

Você concorda? (Responda *Sim* para confirmar)`;
}

/**
 * Mensagem enviada quando o paciente pergunta sobre horários disponíveis.
 * Cláudia sinaliza que vai verificar e passa a conversa para o Dr. Diego.
 */
export function availabilityHoldingMessage() {
  return `${getGreeting()}! 😊 Vou verificar os horários disponíveis para você agora mesmo! 🗓️

Em breve nossa equipe entra em contato com as opções. 😊`;
}

/**
 * Mapeamento de tipos de follow-up para funções
 */
export const followupTemplates = {
  pesquisa_satisfacao:     satisfactionSurvey,
  pos_confirmacao_d1:      postConfirmationCheckIn,
  lembrete_1mes:           followup1Month,
  lembrete_3meses:         followup3Months,
  lembrete_6meses:         followup6Months,
  lembrete_12meses:        followup12Months,
};

/**
 * Descrições dos tipos de follow-up (para logs)
 */
export const followupDescriptions = {
  pesquisa_satisfacao:  'Pesquisa de satisfação pós-atendimento',
  pos_confirmacao_d1:   'Check-in pós-consulta (dia seguinte)',
  lembrete_1mes:        'Lembrete de 1 mês pós-alta',
  lembrete_3meses:      'Lembrete de 3 meses pós-alta',
  lembrete_6meses:      'Lembrete de 6 meses pós-alta',
  lembrete_12meses:     'Lembrete de 12 meses pós-alta',
};

/**
 * Lembrete de consulta enviado 24h antes do agendamento.
 */
export function appointmentReminder24h(patientName, date, time, professionalName, specialty) {
  const name = patientName && patientName !== 'Novo Paciente' ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  const specialtyLabel = specialty === 'quiropraxia' ? 'Quiropraxia' : specialty === 'psicologia' ? 'Psicologia' : 'Osteopatia';

  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Passando para lembrar que você tem *consulta amanhã*:

📅 *Data:* ${date}
🕐 *Horário:* ${time}
👨‍⚕️ *Profissional:* ${professionalName}
🩺 *Especialidade:* ${specialtyLabel}

📍 *Local:* Av. Vasco da Gama, nº 3691 — Edf. Vasco da Gama Plaza, sala 1401 — Salvador, Bahia

👕 Lembre-se de vir com *roupas confortáveis* (legging, moletom ou roupa de ginástica).

Se precisar *reagendar ou cancelar*, por favor nos avise com pelo menos *12 horas de antecedência*.

Te esperamos! 🌿`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES: Lembrete de retorno de pacote (3 níveis de urgência)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Nível 1 (7+ dias sem agendar): Lembrete gentil
 */
export function packageReminderLevel1(patientName, freeSessions, productName, deadlineDate) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Passando para lembrar que você ainda tem *${freeSessions} ${freeSessions === 1 ? "sessão disponível" : "sessões disponíveis"} no seu pacote *${productName}*! 🌿

Você tem até *${deadlineDate}* para concluir seu pacote. Que tal agendarmos sua próxima sessão?

Responda aqui e encontramos o melhor horário para você! 📅`;
}

/**
 * Nível 2 (14+ dias sem agendar): Mais direto
 */
export function packageReminderLevel2(patientName, freeSessions, productName, deadlineDate) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Não esqueça! Você tem *${freeSessions} ${freeSessions === 1 ? "sessão restante" : "sessões restantes"} no seu pacote *${productName}* e o prazo para conclusão é *${deadlineDate}*. ⏰

A regularidade do tratamento é fundamental para os melhores resultados! Vamos agendar sua próxima sessão? 💚

É só responder aqui que marcamos pra você! 📅`;
}

/**
 * Nível 3 (21+ dias ou <2 semanas do vencimento): Urgente
 */
export function packageReminderLevel3(patientName, freeSessions, productName, deadlineDate) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! ⚠️

*Atenção:* Seu pacote *${productName}* está próximo do vencimento!

📋 Você ainda tem *${freeSessions} ${freeSessions === 1 ? "sessão" : "sessões"}* para usar
📅 Prazo final: *${deadlineDate}*

As sessões não utilizadas dentro do prazo serão perdidas. Não deixe para a última hora!

Responda agora e agendamos suas sessões restantes! 🗓️`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Reagendamento de faltantes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem enviada quando paciente falta à consulta
 */
export function noShowRescheduling(patientName, date, time, professionalName) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  const [y, m, d] = date.split('-');
  const dateBR = `${d}/${m}/${y}`;
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Sentimos sua falta na consulta de hoje (${dateBR} às ${time}) com *${professionalName}*! 💚

Sabemos que imprevistos acontecem. Gostaria de *reagendar* sua consulta? Estamos aqui para encontrar o melhor horário para você! 📅

Lembrando que a regularidade do tratamento faz toda a diferença nos resultados. 🌿

Responda aqui e agendamos rapidinho! 😊`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Lista de espera — notificação de vaga
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem enviada quando abre vaga para paciente na lista de espera
 */
export function waitlistNotification(patientName, date, professionalName) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  const [y, m, d] = date.split('-');
  const dateBR = `${d}/${m}/${y}`;
  return `${greeting}${name ? `, *${name}*` : ''}! 🎉

Ótima notícia! Abriu uma *vaga* na agenda do dia *${dateBR}* com *${professionalName}*!

Você estava na nossa lista de espera para esse dia. Gostaria de aproveitar e *agendar*? 📅

Responda rápido para garantir o horário! 😊🌿`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Pós-consulta — check-in dia seguinte
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem enviada no dia seguinte após consulta concluída.
 * Pergunta como o paciente está, sem pesquisa de satisfação.
 */
export function postConsultationCheckIn(patientName) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Passando aqui para saber como você está se sentindo após a consulta! 💚

Já conseguiu começar a fazer os exercícios que foram orientados? Manter a regularidade faz toda a diferença no resultado do tratamento! 🏃

Qualquer dúvida, desconforto ou necessidade — pode chamar aqui, estamos sempre à disposição! 🌿`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Aniversário
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem de parabéns enviada no dia do aniversário do paciente.
 */
export function birthdayMessage(patientName) {
  const name = patientName ? patientName.split(' ')[0] : '';
  return `${getGreeting()}${name ? `, *${name}*` : ''}! 🎂🎉

Hoje é um dia muito especial — *FELIZ ANIVERSÁRIO!* 🥳

Toda a equipe do *Instituto Holiz* deseja a você muita saúde, alegria e bem-estar! 💚

Que esse novo ciclo traga equilíbrio ao corpo e à mente. Estamos aqui para cuidar de você sempre! 🌿

Um abraço carinhoso de toda a equipe! 🤗`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Reativação de paciente inativo
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem para pacientes inativos há 3+ meses, convidando a retornar.
 */
export function reactivationMessage(patientName, daysSince) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  const months = Math.floor(daysSince / 30);
  const timeLabel = months >= 2 ? `${months} meses` : 'algum tempo';
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Faz *${timeLabel}* que não nos vemos por aqui no *Instituto Holiz*! Sentimos sua falta! 💚

Cuidar do corpo de forma regular é essencial para manter os benefícios do tratamento e prevenir novos desconfortos. 🌿

Que tal agendar uma *consulta de retorno*? Vamos avaliar como você está e traçar o melhor caminho para o seu bem-estar! 💪

Responda aqui e encontramos o melhor horário para você! 📅`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Relatório semanal para o profissional
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Relatório semanal enviado via WhatsApp ao profissional.
 */
export function weeklyReportMessage(data) {
  const { period, completedAppointments, noShows, cancelled, newAppointments, newPatients, revenue, discharges, nextWeekAppointments } = data;

  const [sy, sm, sd] = period.startDate.split('-');
  const [ey, em, ed] = period.endDate.split('-');
  const periodStr = `${sd}/${sm} a ${ed}/${em}`;

  const noShowRate = (completedAppointments + noShows) > 0
    ? ((noShows / (completedAppointments + noShows)) * 100).toFixed(1)
    : '0.0';

  return `📊 *RELATÓRIO SEMANAL — Instituto Holiz*
📅 Período: ${periodStr}

━━━━━━━━━━━━━━━━━━━━━━━━
📋 *Atendimentos:*
✅ Realizados: *${completedAppointments}*
🚫 Faltas: *${noShows}* (${noShowRate}%)
❌ Cancelamentos: *${cancelled}*

📈 *Movimentação:*
🆕 Novos agendamentos: *${newAppointments}*
👤 Novos pacientes: *${newPatients}*
🏥 Altas: *${discharges}*

💰 *Receita:* R$ ${revenue.toFixed(2).replace('.', ',')}

━━━━━━━━━━━━━━━━━━━━━━━━
📅 *Próxima semana:* ${nextWeekAppointments} consulta(s) agendada(s)

_Relatório gerado automaticamente pela Cláudia IA_ 🤖`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Pacote concluído
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem quando o paciente conclui todas as sessões do pacote.
 */
export function packageCompletedMessage(patientName, productName, totalSessions) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! 🎉

Parabéns! Você concluiu todas as *${totalSessions} sessões* do seu pacote *${productName}*! 💪🌟

Esperamos que você esteja se sentindo muito melhor! O tratamento trouxe benefícios importantes para o seu corpo.

🔄 *Para manter os resultados*, recomendamos:
- Continuar com os exercícios orientados
- Agendar uma *consulta de manutenção* em 1-2 meses
- Manter atenção à postura no dia a dia

Quer saber mais sobre nossos planos de manutenção ou agendar um retorno? É só responder aqui! 😊🌿`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATE: Campanha de indicação
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mensagem de indicação enviada após feedback positivo do pós-consulta.
 */
export function referralMessage(patientName) {
  const name = patientName ? patientName.split(' ')[0] : '';
  const greeting = getGreeting();
  return `${greeting}${name ? `, *${name}*` : ''}! 😊

Ficamos muito felizes em saber que você está se sentindo bem! 💚

Sabia que você pode ajudar alguém que está precisando? 🤝

Se você conhece algum amigo, familiar ou colega que sofre com:
• Dores nas costas ou no pescoço
• Enxaquecas ou dores de cabeça
• Problemas posturais
• Desconfortos articulares

Indique o *Instituto Holiz*! É só encaminhar nosso contato. Cuidar da saúde com quem a gente confia faz toda a diferença! 🌿

Obrigada por confiar no nosso trabalho! 💚`;
}

// ── Lembrete no dia da consulta (manhã) ─────────────────────────────────────

export function sameDayReminder(patientName, time, professionalName) {
  const firstName = patientName.split(' ')[0];
  return `Bom dia, ${firstName}! 😊

Lembrando que sua consulta é *hoje às ${time}* com ${professionalName}.

📍 *Av. Vasco da Gama, nº 3691 — Edf. Vasco da Gama Plaza, sala 1401 — Salvador, Bahia*

Venha com roupa confortável!

Até logo! 🤗`;
}

