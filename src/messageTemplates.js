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

Para começarmos, poderia me informar:
1️⃣ Seu *nome completo*
2️⃣ Sua *data de nascimento* (dd/mm/aaaa)
3️⃣ Seu *número de telefone* para contato

Assim consigo te atender da melhor forma! 😊`;
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
  const greeting = name ? `Ótimo, *${name}*! ` : 'Ótimo! ';

  return `${greeting}Consulta confirmada com sucesso! 🎉

Só alguns lembretes importantes antes da sua consulta:

👕 *Roupas adequadas:*
Venha com roupas confortáveis e fáceis de movimentar — roupa de ginástica, legging ou moletom são ótimas opções! Isso facilita muito a avaliação e o tratamento. 😊

⚠️ *Política de cancelamento:*
Caso precise cancelar ou reagendar, pedimos que nos avise com pelo menos *12 horas de antecedência*. Ausências sem aviso prévio após a confirmação serão *contabilizadas como consulta realizada*.

Te esperamos! Qualquer dúvida, é só chamar. 🌿`;
}

/**
 * Resposta quando o paciente cancela o agendamento via Simples Agenda
 */
export function appointmentCancelledResponse(patientName) {
  const name = patientName && patientName !== 'Novo Paciente' ? patientName.split(' ')[0] : '';
  const greeting = name ? `Entendido, *${name}*!` : 'Entendido!';

  return `${greeting} Seu agendamento foi cancelado. 😊

Quando quiser remarcar, é só nos chamar aqui que encontramos o melhor horário para você! 📅

Estamos sempre à disposição. Cuide-se! 🌿`;
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
